'use strict';

/**
 * 应用桌面名的后台解析 + 磁盘缓存。
 *
 * 取名要走一遍 adb：pm path → exec-out unzip 出清单/资源表 → 本地解析，
 * 单包 0.5~2 s，127 个第三方应用全量跑要一两分钟。所以：
 *   - get-packages 立刻返回（能命中的直接填缓存名），解析在后台慢慢补；
 *   - 每解出一个就推一条 IPC，界面就地改名，不阻塞用户选应用；
 *   - 结果按「包名 + versionCode + 设备语言」缓存到 userData，下次秒开；
 *   - 采集进行中暂停解析：大文件 exec-out 会占用 USB 通道，影响采样。
 */

const fs = require('fs');
const path = require('path');

const CACHE_KEEP = 3000;   // 缓存条目上限（多设备 + 多版本叠加也不会无限涨）
const WORKERS = 2;         // 并发 adb 流；再多会和采集抢 USB 带宽
const LOCALE_TTL_MS = 10 * 60 * 1000;

let cachePath = '';
let cache = null;          // { version: 1, entries: { key: { label, ts } } }
let saveTimer = null;
const localeMemo = new Map(); // deviceId -> { locale, ts }

function init(filePath) {
  cachePath = filePath;
  cache = null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (raw && raw.version === 1 && raw.entries && typeof raw.entries === 'object') {
      cache = raw;
    }
  } catch (_) {}
  if (!cache) cache = { version: 1, entries: {} };
}

function cacheKey(pkg, versionCode, locale) {
  const lang = locale && locale.lang ? String(locale.lang).toLowerCase() : '-';
  const country = locale && locale.country ? String(locale.country).toLowerCase() : '';
  return `${pkg}|${versionCode == null ? 0 : versionCode}|${lang}|${country}`;
}

function cacheGet(pkg, versionCode, locale) {
  const row = cache && cache.entries[cacheKey(pkg, versionCode, locale)];
  if (!row || typeof row.label !== 'string') return null; // 没缓存过
  return row.label;       // '' 表示「解过、确实没有名字」，别再反复重试
}

function cachePut(pkg, versionCode, locale, label) {
  if (!cache) return;
  cache.entries[cacheKey(pkg, versionCode, locale)] = { label, ts: Date.now() };
  scheduleSave();
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 3000);
  if (saveTimer.unref) saveTimer.unref();
}

function saveNow() {
  if (!cachePath || !cache) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const keys = Object.keys(cache.entries);
  if (keys.length > CACHE_KEEP) {
    keys.sort((a, b) => (cache.entries[b].ts || 0) - (cache.entries[a].ts || 0));
    for (const k of keys.slice(CACHE_KEEP)) delete cache.entries[k];
  }
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8');
    fs.renameSync(tmp, cachePath);
  } catch (_) {}
}

async function getLocale(deviceId, adb) {
  const hit = localeMemo.get(deviceId);
  if (hit && Date.now() - hit.ts < LOCALE_TTL_MS) return hit.locale;
  const locale = await adb.getDeviceLocale(deviceId).catch(() => null);
  localeMemo.set(deviceId, { locale, ts: Date.now() });
  return locale;
}

/** 把缓存里已有的名字直接填进 packages（原地改 label），返回命中数量 */
async function attachCached(deviceId, packages, adb) {
  const locale = await getLocale(deviceId, adb);
  let hit = 0;
  for (const p of packages) {
    const label = cacheGet(p.pkg, p.versionCode, locale);
    if (label) { p.label = label; hit += 1; }
  }
  return hit;
}

/**
 * 后台把没命中的包逐个解出来。
 * @param {object} opts
 * @param {string} opts.deviceId
 * @param {Array<{pkg:string,versionCode:number|null}>} opts.packages
 * @param {object} opts.adb
 * @param {(items:Array<{pkg:string,label:string}>, progress:object) => void} opts.onUpdate
 * @param {() => boolean} [opts.isStale]    新一轮解析开始后旧轮次自行退出
 * @param {() => boolean} [opts.shouldPause] 采集进行中返回 true
 */
async function resolveAll({ deviceId, packages, adb, onUpdate, isStale, shouldPause }) {
  const locale = await getLocale(deviceId, adb);
  const total = packages.length;
  const queue = [];
  const cached = [];
  for (const p of packages) {
    const label = cacheGet(p.pkg, p.versionCode, locale);
    if (label == null) queue.push(p);
    else if (label) cached.push({ pkg: p.pkg, label });
  }
  let done = total - queue.length;
  if (cached.length) onUpdate(cached, { done, total });
  if (queue.length === 0) {
    onUpdate([], { done: total, total, finished: true });
    return;
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function worker() {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      if (isStale && isStale()) return;
      while (shouldPause && shouldPause()) {
        if (isStale && isStale()) return;
        await sleep(1000);
      }
      let label = null;
      try {
        label = await adb.resolveAppLabel(deviceId, item.pkg, locale);
        if (label === undefined) label = null;
      } catch (_) {
        label = null;
      }
      if (isStale && isStale()) return;
      if (label == null) {
        // adb 通道偶尔抖（实测会短暂 device not found）：挪到队尾再试，最多三次
        if ((item.tries || 0) < 2) {
          item.tries = (item.tries || 0) + 1;
          await sleep(400);
          queue.push(item);
          continue;
        }
        done += 1;
        onUpdate([], { done, total }); // 没成功就不写缓存，下次打开再试
        continue;
      }
      done += 1;
      // '' 表示「解过、确实没名字」，也写缓存，免得每次都白跑一遍
      cachePut(item.pkg, item.versionCode, locale, label);
      onUpdate(label ? [{ pkg: item.pkg, label }] : [], { done, total });
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(WORKERS, queue.length); i += 1) workers.push(worker());
  await Promise.all(workers);
  saveNow();
  if (!isStale || !isStale()) onUpdate([], { done, total, finished: true });
}

module.exports = { init, attachCached, resolveAll, saveNow, cacheGet, cachePut };
