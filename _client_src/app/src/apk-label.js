'use strict';

/**
 * 从 APK 的 AndroidManifest.xml / resources.arsc 里读「桌面显示的应用名」。
 *
 * adb 没有现成的取 label 接口（pm list packages 只有包名，MIUI 的 dumpsys 连
 * labelRes 都裁掉了），所以只能自己解这两个二进制格式：
 *   - AndroidManifest.xml 是 AXML（字符串池 + 元素/属性），取 <application> 的
 *     android:label：值是字符串就直接用，是资源引用就记下 id；
 *   - resources.arsc 是资源表，按 id 找到对应 entry 的值字符串。
 * 解析失败一律返回 null，调用方退回包名——名字只是方便选，不能因此让列表打不开。
 */

const RES_XML_TYPE = 0x0003;
const RES_TABLE_TYPE = 0x0002;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_TABLE_PACKAGE_TYPE = 0x0200;
const RES_TABLE_TYPE_TYPE = 0x0201;

const TYPE_STRING = 0x03;
const TYPE_REFERENCE = 0x01;

const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

function readStringPool(buf, start) {
  if (u16(buf, start) !== RES_STRING_POOL_TYPE) return null;
  const headerSize = u16(buf, start + 2);
  const size = u32(buf, start + 4);
  const count = u32(buf, start + 8);
  const flags = u32(buf, start + 16);
  const stringsStart = u32(buf, start + 20);
  const utf8 = (flags & 0x0100) !== 0;
  const offsets = start + headerSize;
  const data = start + stringsStart;
  const strings = new Array(count);
  for (let i = 0; i < count; i += 1) {
    let p = data + u32(buf, offsets + i * 4);
    if (utf8) {
      // UTF-8 池：先 UTF-16 长度、再 UTF-8 字节长度，两个都是变长整数
      let n = buf[p++];
      if (n & 0x80) p += 1;
      n = buf[p++];
      if (n & 0x80) n = ((n & 0x7f) << 8) | buf[p++];
      strings[i] = buf.toString('utf8', p, p + n);
    } else {
      let n = u16(buf, p);
      p += 2;
      if (n & 0x8000) {
        n = ((n & 0x7fff) << 16) | u16(buf, p);
        p += 2;
      }
      strings[i] = buf.toString('utf16le', p, p + n * 2);
    }
  }
  return { strings, end: start + size };
}

/**
 * 读 AndroidManifest.xml 里 <application android:label> 的值。
 * @returns {{ text: string|null, resId: number|null }} 都不认识时返回 null。
 */
function readManifestLabel(buf) {
  try {
    if (!buf || buf.length < 8 || u16(buf, 0) !== RES_XML_TYPE) return null;
    let p = u16(buf, 2);
    const end = Math.min(u32(buf, 4), buf.length);
    let pool = null;
    let nsMap = null;
    while (p + 8 <= end) {
      const type = u16(buf, p);
      const headerSize = u16(buf, p + 2);
      const size = u32(buf, p + 4);
      if (size < 8) break;
      if (type === RES_STRING_POOL_TYPE) {
        pool = readStringPool(buf, p);
        if (pool) {
          nsMap = pool.strings.indexOf(ANDROID_NS);
        }
      } else if (type === RES_XML_START_ELEMENT_TYPE && pool) {
        const nameIdx = u32(buf, p + 20);
        const attrStart = u16(buf, p + 24);
        const attrSize = u16(buf, p + 26) || 20;
        const attrCount = u16(buf, p + 28);
        const name = pool.strings[nameIdx] || '';
        if (name === 'application') {
          for (let i = 0; i < attrCount; i += 1) {
            const a = p + 16 + attrStart + i * attrSize;
            const ns = u32(buf, a);
            const an = u32(buf, a + 4);
            if (nsMap < 0 || ns !== nsMap) continue;
            if ((pool.strings[an] || '') !== 'label') continue;
            const dataType = buf[a + 15];
            const data = u32(buf, a + 16);
            if (dataType === TYPE_STRING) {
              return { text: pool.strings[data] || null, resId: null };
            }
            if (dataType === TYPE_REFERENCE) return { text: null, resId: data >>> 0 };
          }
          return null;
        }
      }
      p += size || headerSize;
    }
    return null;
  } catch (_) {
    return null;
  }
}

function configLanguage(buf, p) {
  // ResTable_config: size(4) mcc(2) mnc(2) language[2] country[2]
  return { lang: buf.toString('latin1', p + 8, p + 10), country: buf.toString('latin1', p + 10, p + 12) };
}

function cleanLang(s) {
  return (s || '').replace(/\0/g, '').toLowerCase();
}

/**
 * 配置与设备语言越贴合分越高。设备有语言时默认配置排最后（否则微信在中文机上
 * 会显示成 WeChat）；拿不到设备语言时反过来，默认配置最优先。
 */
function configScore(cfg, locale) {
  const lang = cleanLang(cfg.lang);
  const country = cleanLang(cfg.country);
  const wantLang = locale && locale.lang ? String(locale.lang).toLowerCase() : '';
  if (!lang) return wantLang ? 1 : 3;
  if (!wantLang) return 1;
  if (lang !== wantLang) return 0;
  const wantCountry = locale.country ? String(locale.country).toLowerCase() : '';
  if (!country) return 2;
  return country === wantCountry ? 3 : 1;
}

function entryOffset(buf, chunkStart, entryIndex, entryCount, flags) {
  const offsets = chunkStart + u16(buf, chunkStart + 2);
  if (flags & 0x02) {
    if (entryIndex >= entryCount) return -1;
    const v = u16(buf, offsets + entryIndex * 2);
    return v === 0xffff ? -1 : v * 4;
  }
  if (flags & 0x01) {
    let lo = 0;
    let hi = entryCount - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const idx = u16(buf, offsets + mid * 4);
      if (idx === entryIndex) {
        const v = u16(buf, offsets + mid * 4 + 2);
        return v === 0xffff ? -1 : v * 4;
      }
      if (idx < entryIndex) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }
  if (entryIndex >= entryCount) return -1;
  const v = u32(buf, offsets + entryIndex * 4);
  return v === 0xffffffff ? -1 : v;
}

/** 单份配置里取 entryId 的值：字符串直接返回，引用返回 ref（label 常见别名套一层） */
function readEntryValue(buf, chunk, entryId, pool) {
  const flags = buf[chunk + 9];
  const entryCount = u32(buf, chunk + 12);
  const entriesStart = u32(buf, chunk + 16);
  const off = entryOffset(buf, chunk, entryId, entryCount, flags);
  if (off < 0) return null;
  const e = chunk + entriesStart + off;
  if (e + 8 > buf.length) return null;
  const eSize = u16(buf, e) || 8;
  if (u16(buf, e + 2) & 0x0001) return null; // 复杂条目（bag）不会是 label
  const v = e + eSize;
  if (v + 8 > buf.length) return null;
  const dataType = buf[v + 3];
  const data = u32(buf, v + 4) >>> 0;
  if (dataType === TYPE_STRING) return pool.strings[data] ? { str: pool.strings[data] } : null;
  if (dataType === TYPE_REFERENCE && data !== 0) return { ref: data };
  return null;
}

/** 在资源表里按 id 取字符串值；locale 决定优先取哪套语言（默认回退） */
function readArscString(buf, resId, locale, depth) {
  try {
    const d = depth || 0;
    if (d > 4) return null; // 别名套娃保险丝
    if (!buf || buf.length < 12 || u16(buf, 0) !== RES_TABLE_TYPE) return null;
    const res = resId >>> 0;
    const pkgId = (res >>> 24) & 0xff;
    const typeId = (res >>> 16) & 0xff;
    const entryId = res & 0xffff;

    let p = u16(buf, 2);
    const end = Math.min(u32(buf, 4), buf.length);
    let pool = null;
    let pkgStart = -1;
    while (p + 8 <= end) {
      const type = u16(buf, p);
      const size = u32(buf, p + 4);
      if (size < 8) break;
      if (type === RES_STRING_POOL_TYPE && !pool) pool = readStringPool(buf, p);
      else if (type === RES_TABLE_PACKAGE_TYPE && u32(buf, p + 8) === pkgId) pkgStart = p;
      p += size;
    }
    if (!pool || pkgStart < 0) return null;

    // 同一 type 会有多套配置（默认 / zh / zh-CN / zh-TW …）。全部按贴合度排序后
    // 逐个试：高分的配置里未必有这条资源（APK 只翻译了一部分），不能一撞就放弃。
    const cands = [];
    const pkgSize = u32(buf, pkgStart + 4);
    let q = pkgStart + u16(buf, pkgStart + 2);
    const pkgEnd = Math.min(pkgStart + pkgSize, end);
    while (q + 8 <= pkgEnd) {
      const type = u16(buf, q);
      const size = u32(buf, q + 4);
      if (size < 8) break;
      if (type === RES_TABLE_TYPE_TYPE && buf[q + 8] === typeId) {
        cands.push({ at: q, score: configScore(configLanguage(buf, q + 20), locale) });
      }
      q += size;
    }
    cands.sort((a, b) => b.score - a.score);

    for (const c of cands) {
      const v = readEntryValue(buf, c.at, entryId, pool);
      if (!v) continue;
      if (v.str) return v.str;
      const alias = readArscString(buf, v.ref, locale, d + 1);
      if (alias) return alias;
    }
    return null;
  } catch (_) {
    return null;
  }
}

/** 合并两步：先看清单里是不是字面量，不是再从资源表查 */
function labelFromApk(manifestBuf, arscBuf, locale) {
  const m = readManifestLabel(manifestBuf);
  if (!m) return null;
  if (m.text) return m.text;
  if (!m.resId || !arscBuf) return null;
  return readArscString(arscBuf, m.resId, locale);
}

function u16(buf, o) { return buf.readUInt16LE(o); }
function u32(buf, o) { return buf.readUInt32LE(o); }

module.exports = { readManifestLabel, readArscString, labelFromApk };
