'use strict';
/**
 * 真机低谷截图端到端：打包态采集器 → 卡顿 → 自动截图 → 缩略图条 → 本地报告画廊。
 *
 * 用法: node trough_shot_realdevice.js <deviceId> [packageName] [seconds]
 * 设备序列号必须运行时传入（不入库）；默认用 com.android.chrome（任何设备都有）。
 *
 * 覆盖点：
 *   1) 采集途中施加 CPU 压力 + 滑动，制造真实低帧
 *   2) reports/shots/<pkg>/<时间>/ 下出现 trough_*.jpg，且是合法 JPEG、宽度 ≤900
 *   3) 采集窗口缩略图条出现（#trough-strip 可见、缩略图数量与文件一致）
 *   4) 停止采集后 data.js 带 shots；perf.html 打开后出现画廊且图片非空白
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync, execFile } = require('child_process');
const pw = require('playwright-core');

const PROJ = path.resolve(__dirname, '..', '..', '..');
const APP_EXE = path.join(PROJ, 'perfara', 'collector', 'Perfara.exe');
const REPORTS = path.join(PROJ, 'perfara', 'collector', 'resources', 'reports');
const SHOTS = path.join(REPORTS, 'shots');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const DEVICE = process.argv[2] || '';
const PKG = process.argv[3] || 'com.android.chrome';
const SECONDS = parseInt(process.argv[4] || '45', 10);
if (!DEVICE) { console.error('用法: node trough_shot_realdevice.js <deviceId> [packageName] [seconds]'); process.exit(2); }

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + '  -> ' + JSON.stringify(detail)); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const adb = (args, opt) => execFileSync('adb', ['-s', DEVICE, ...args], Object.assign({ encoding: 'utf8', timeout: 15000 }, opt));
const adbAsync = (args) => new Promise(r => execFile('adb', ['-s', DEVICE, ...args], { timeout: 15000 }, () => r()));

function listShots(root) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.jpe?g$/i.test(e.name) && !/^thumb_/i.test(e.name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** 读 JPEG 宽高（SOF0/1/2） */
function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xc3) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

(async () => {
  console.log(`\n===== 真机低谷截图 e2e  device=${DEVICE}  pkg=${PKG}  ${SECONDS}s =====\n`);
  if (!fs.existsSync(APP_EXE)) throw new Error('未找到打包态采集器: ' + APP_EXE);

  // 清掉历史截图，避免把旧文件算进本轮
  try { fs.rmSync(SHOTS, { recursive: true, force: true }); } catch (_) {}

  // 当前 shell/CI 可能带 ELECTRON_RUN_AS_NODE=1（Electron 会退化成纯 Node，窗口一闪就退出）。
  // 启动器本身也会剔除它，这里同样处理，否则 Playwright 连不上窗口。
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;

  const electronApp = await pw._electron.launch({ executablePath: APP_EXE, env, timeout: 90000 });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2500);
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e.message || e)));

  // 记录渲染进程收到的 trough-shot（与缩略图条各自验证）
  await page.evaluate(() => {
    window.__troughSeen = [];
    window.__collectLogs = [];
    if (window.perfAPI && window.perfAPI.onTroughShot) {
      window.perfAPI.onTroughShot(m => window.__troughSeen.push(m));
    }
    if (window.perfAPI && window.perfAPI.onCollectLog) {
      window.perfAPI.onCollectLog(m => { window.__collectLogs.push(String(m)); if (window.__collectLogs.length > 200) window.__collectLogs.shift(); });
    }
  });

  // 走真实 UI 启动：渲染进程只在「开始」按钮把 isCollecting 置真后才消费 perf-data，
  // 直接调 perfAPI.startCollect 会得到「缩略条有图、曲线没数据」的假状态。
  const deviceReady = await page.evaluate((id) => {
    const sel = document.getElementById('sel-device');
    if (!sel) return false;
    if (!Array.from(sel.options).some(o => o.value === id)) return false;
    sel.value = id;
    sel.dispatchEvent(new Event('change'));
    return true;
  }, DEVICE);
  check('设备列表包含目标设备', deviceReady, deviceReady);

  let started = { ok: false };
  if (deviceReady) {
    const appReady = await page.waitForFunction((pkg) => {
      const sel = document.getElementById('sel-app');
      return !!(sel && !sel.disabled && Array.from(sel.options).some(o => o.value === pkg));
    }, PKG, { timeout: 60000 }).then(() => true).catch(() => false);
    check('应用列表包含目标包名', appReady, appReady);
    if (appReady) {
      await page.evaluate((pkg) => {
        const sel = document.getElementById('sel-app');
        sel.value = pkg;
        sel.dispatchEvent(new Event('change'));
      }, PKG);
      await page.click('#btn-start');
      await page.waitForTimeout(3000);
      started = await page.evaluate(() => {
        const stop = document.getElementById('btn-stop');
        const badge = document.querySelector('.badge');
        return { ok: !!(stop && !stop.disabled), badge: badge ? badge.textContent.trim() : '' };
      });
    }
  }
  check('采集启动成功', !!(started && started.ok), started);
  if (!started || !started.ok) {
    await electronApp.close().catch(() => {});
    console.log(`\n===== 结果: ${pass} PASS / ${fail} FAIL =====`);
    process.exit(1);
  }

  // 用本地动画页制造确定性低谷：adb reverse 把宿主机页面转到设备，
  // 页面每 18s 循环「12s 轻载 / 6s 重载」，重载期 FPS 明显低于轻载期的 P95。
  const PAGE_HTML = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#111}</style>
<canvas id="c"></canvas><script>
const c=document.getElementById('c'),x=c.getContext('2d');
function fit(){c.width=innerWidth;c.height=innerHeight}addEventListener('resize',fit);fit();
function frame(){
  const heavy=(performance.now()%18000)>12000;
  x.fillStyle='#111';x.fillRect(0,0,c.width,c.height);
  if(!heavy){const s=70+40*Math.sin(performance.now()/300);
    x.fillStyle='#39f';x.fillRect((c.width-s)/2,(c.height-s)/2,s,s);}
  else{const n=700,t=performance.now();
    for(let i=0;i<n;i++){const a=i*.7+t/800;
      x.beginPath();x.arc(c.width/2+Math.cos(a)*220,c.height/2+Math.sin(a*1.3)*220,16,0,6.283);
      x.fillStyle='hsla('+(i%360)+',80%,60%,.3)';x.shadowBlur=14;x.shadowColor='#08f';x.fill();}}
  requestAnimationFrame(frame);
}requestAnimationFrame(frame);
</script>`;
  const pageSrv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PAGE_HTML);
  });
  await new Promise(r => pageSrv.listen(0, '127.0.0.1', r));
  const pagePort = pageSrv.address().port;
  const pageUrl = `http://127.0.0.1:${pagePort}/`;
  try { adb(['reverse', `tcp:${pagePort}`, `tcp:${pagePort}`]); } catch (e) {
    console.log('  [warn] adb reverse 失败：' + e.message);
  }
  // 亮屏 → 解锁 → 打开动画页；ColorOS 会把退到后台的 Chrome 冻结，循环里持续拉回前台
  try { adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']); } catch (_) {}
  try { adb(['shell', 'wm', 'dismiss-keyguard']); } catch (_) {}
  const openPage = () => adbAsync(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', pageUrl, '-p', PKG]).catch(() => {});
  const frontPkg = () => {
    try {
      const m = /topResumedActivity=ActivityRecord\{\S+ u\d+ ([\w.]+)\//.exec(adb(['shell', 'dumpsys', 'activity', 'activities']));
      return m ? m[1] : '';
    } catch (_) { return ''; }
  };
  await openPage();
  await sleep(2000);
  console.log('  前台应用: ' + (frontPkg() || '未知'));

  // 轻载期也要持续出帧，重载期自然掉帧；不再额外加压，避免环境噪声
  const deadline = Date.now() + Math.round(SECONDS * 1000);
  let shotFiles = [];
  let strip = { count: 0, visible: false, seen: 0 };
  let tick = 0;
  while (Date.now() < deadline) {
    if (tick++ % 3 === 0 && frontPkg() !== PKG) {
      await openPage();
    }
    shotFiles = listShots(SHOTS);
    strip = await page.evaluate(() => {
      const s = document.getElementById('trough-strip');
      return {
        count: s ? s.querySelectorAll('.trough-thumb').length : 0,
        visible: !!(s && !s.hidden),
        seen: (window.__troughSeen || []).length,
      };
    }).catch(() => strip);
    if (shotFiles.length >= 3 && strip.count >= 3) break;
    await sleep(1500);
  }
  try { adb(['reverse', '--remove', `tcp:${pagePort}`]); } catch (_) {}
  pageSrv.close();

  // 截图落盘、IPC 推送、缩略图条是三条异步链路：收尾时等缩略条追上文件数再断言
  for (let i = 0; i < 12; i++) {
    shotFiles = listShots(SHOTS);
    strip = await page.evaluate(() => {
      const s = document.getElementById('trough-strip');
      return {
        count: s ? s.querySelectorAll('.trough-thumb').length : 0,
        visible: !!(s && !s.hidden),
        seen: (window.__troughSeen || []).length,
      };
    }).catch(() => strip);
    if (strip.count >= Math.min(shotFiles.length, 60)) break;
    await sleep(400);
  }

  check('产生低谷截图文件', shotFiles.length >= 1, shotFiles.length);
  if (!shotFiles.length) {
    const logs = await page.evaluate(() => (window.__collectLogs || []).slice(-8)).catch(() => []);
    console.log('  采集日志尾部：\n    ' + logs.join('\n    '));
  }
  const sizes = shotFiles.map(f => fs.statSync(f).size);
  check('截图体积在 20KB~1MB 之间', sizes.length > 0 && sizes.every(s => s > 20 * 1024 && s < 1024 * 1024), sizes);
  const dims = shotFiles.map(f => jpegSize(fs.readFileSync(f)));
  check('截图是合法 JPEG', dims.length > 0 && dims.every(d => d && d.width > 0 && d.height > 0), dims);
  check('截图宽度 ≤900', dims.length > 0 && dims.every(d => d && d.width <= 900), dims);
  check('文件名带时间戳与序号', shotFiles.length > 0 && shotFiles.every(f => /trough_\d{6}_\d{2}\.jpg$/.test(path.basename(f))), shotFiles.map(f => path.basename(f)).slice(0, 3));
  check('截图按包名/时间分目录', shotFiles.length > 0 && shotFiles.every(f => path.relative(SHOTS, f).split(path.sep).length === 3), shotFiles.slice(0, 1).map(f => path.relative(SHOTS, f)));

  const seen = await page.evaluate(() => (window.__troughSeen || []).length).catch(() => -1);
  check('渲染进程收到 trough-shot', seen >= 1, seen);
  check('采集窗口出现缩略图条', strip.visible === true && strip.count >= 1, strip);
  check('缩略图与落盘文件数量一致', strip.count === Math.min(shotFiles.length, 60), { strip: strip.count, files: shotFiles.length });
  check('截图发生在本轮（未被旧文件干扰）', shotFiles.length >= strip.count, { files: shotFiles.length, strip: strip.count });

  const thumbs = shotFiles.map(f => path.join(path.dirname(f), 'thumb_' + path.basename(f)));
  const thumbOk = thumbs.length > 0 && thumbs.every(f => {
    try { const n = fs.statSync(f).size; return n > 1024 && n < 64 * 1024; } catch (_) { return false; }
  });
  check('每张截图都有小图（曲线/缩略条用）', thumbOk, thumbs.map(f => path.basename(f)).slice(0, 3));

  let liveMarks = { n: 0, sym: '', coords: [], stored: 0, times: 0 };
  for (let i = 0; i < 10; i++) {
    liveMarks = await page.evaluate(() => {
      const m = window.chartMgr;
      const inst = m && m._charts && m._charts.fps;
      const mp = inst && inst.getOption().series[0].markPoint;
      const list = mp && Array.isArray(mp.data) ? mp.data : [];
      return {
        n: list.length,
        sym: list[0] ? list[0].symbol : '',
        coords: list.map(x => x.coord),
        stored: (m && m._troughShots || []).length,
        times: (m && m._data && m._data.fps && m._data.fps.times || []).length,
      };
    }).catch(() => ({ n: -1 }));
    if (liveMarks.n >= 1) break;
    await sleep(300);
  }
  check('实时 FPS 曲线出现截图标记', liveMarks.n >= 1, liveMarks);
  check('曲线标记用小图', /thumb_trough_\d{6}_\d{2}\.jpg$/.test(liveMarks.sym || ''), liveMarks.sym);

  // 停止采集 → 写 data.js
  const stopped = await page.evaluate(() => window.perfAPI.stopCollect());
  check('停止采集成功', !!(stopped && stopped.ok), stopped);
  await sleep(1500);

  let data = null;
  try {
    const txt = fs.readFileSync(path.join(REPORTS, 'data.js'), 'utf8').trim();
    data = JSON.parse(txt.replace(/^var data = /, '').replace(/;$/, ''));
  } catch (e) { /* 下面断言会失败 */ }
  check('data.js 已写入', !!data, null);
  check('data.js 带 shots 数组', !!(data && Array.isArray(data.shots)) && data.shots.length >= 1, data && data.shots && data.shots.length);
  if (data && Array.isArray(data.shots) && data.shots.length) {
    const s0 = data.shots[0];
    check('shots 条目字段完整', !!(s0.url && s0.file && /^file:/.test(s0.url) && typeof s0.fps === 'number' && typeof s0.target === 'number' && typeof s0.t === 'number'), s0);
    check('shots 指向的文件存在', data.shots.every(s => fs.existsSync(path.join(REPORTS, ...String(s.file).split('/')))), data.shots.map(s => s.file).slice(0, 2));
    check('shots 带曲线用的小图', data.shots.every(s => !!s.thumb && /^file:/.test(s.thumbUrl || '')), data.shots.map(s => s.thumb).slice(0, 2));
    check('小图文件存在且体积合理', data.shots.every(s => {
      try { const n = fs.statSync(path.join(REPORTS, ...String(s.thumb).split('/'))).size; return n > 1024 && n < 64 * 1024; } catch (_) { return false; }
    }), data.shots.map(s => path.basename(String(s.thumb))).slice(0, 2));
  }

  await electronApp.close().catch(() => {});
  check('采集过程无渲染进程报错', pageErrors.length === 0, pageErrors.slice(0, 3));

  // 本地报告画廊：用 Edge 打开真实 perf.html（读同目录 data.js）
  // file:// 页面读取 file:// 截图会被视为跨源、canvas 被污染；放开该限制后才能抽样像素
  const browser = await pw.chromium.launch({ executablePath: EDGE, headless: true, args: ['--allow-file-access-from-files'] });
  const rp = await browser.newPage();
  const reportErrors = [];
  rp.on('pageerror', e => reportErrors.push(String(e.message || e)));
  await rp.goto('file:///' + path.join(REPORTS, 'perf.html').replace(/\\/g, '/'), { waitUntil: 'load', timeout: 30000 });
  await rp.waitForTimeout(4000);
  const gallery = await rp.evaluate(() => {
    const sec = document.getElementById('trough-gallery');
    return {
      has: !!sec,
      cards: sec ? sec.querySelectorAll('.trough-gal-card').length : 0,
      title: sec ? sec.querySelector('.chart-title').textContent : '',
    };
  });
  check('报告出现低谷截图画廊', gallery.has === true && gallery.cards >= 1, gallery);
  check('画廊张数与 data.shots 一致', data && gallery.cards === data.shots.length, { cards: gallery.cards, shots: data && data.shots.length });

  // FPS 曲线上的截图标记：报告用 data.js 的 thumbUrl 作 symbol
  let marks = { n: 0, sym: '', coords: [] };
  for (let i = 0; i < 32; i++) {
    marks = await rp.evaluate(() => {
      const el = document.getElementById('chart-fps');
      const inst = window.echarts && el && window.echarts.getInstanceByDom(el);
      const mp = inst && inst.getOption().series[0].markPoint;
      const list = mp && Array.isArray(mp.data) ? mp.data : [];
      return { n: list.length, sym: list[0] ? String(list[0].symbol || '') : '', coords: list.map(x => x.coord) };
    }).catch(() => ({ n: 0 }));
    if (marks.n >= 1) break;
    await rp.waitForTimeout(250);
  }
  check('报告 FPS 曲线出现截图标记', marks.n >= 1, marks);
  check('报告曲线标记张数与 data.shots 一致', !!data && marks.n === data.shots.length, { marks: marks.n, shots: data && data.shots.length });
  check('报告曲线标记用小图', /thumb_trough_\d{6}_\d{2}\.jpg$/.test(marks.sym), marks.sym);

  if (marks.n >= 1) {
    await rp.locator('.chart-wrap[data-metric="fps"]').scrollIntoViewIfNeeded();
    await rp.waitForTimeout(300);
    const hit = await rp.evaluate(() => {
      const el = document.getElementById('chart-fps');
      const inst = window.echarts.getInstanceByDom(el);
      const d0 = inst.getOption().series[0].markPoint.data[0];
      const p = inst.convertToPixel({ seriesIndex: 0 }, d0.coord);
      if (!p) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + p[0], y: r.top + p[1] - 46 };
    });
    check('曲线标记可换算为屏幕坐标', !!hit, hit);
    if (hit) {
      await rp.mouse.click(hit.x, hit.y);
      await rp.waitForTimeout(200);
      check('报告内点击曲线标记可全屏预览', await rp.evaluate(() => !!document.querySelector('.trough-gal-overlay')));
      await rp.mouse.click(5, 5); // 点遮罩关闭，避免挡住后面的画廊点击
      await rp.waitForTimeout(150);
    }
  }

  // 截图不是纯色（真机画面必须有内容）
  const variance = await rp.evaluate(async () => {
    const img = document.querySelector('#trough-gallery .trough-gal-card img');
    if (!img) return -1;
    try { await img.decode(); } catch (_) { return -2; }
    const c = document.createElement('canvas');
    c.width = Math.min(200, img.naturalWidth);
    c.height = Math.min(200, img.naturalHeight);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const set = new Set();
    for (let i = 0; i < d.length; i += 4) set.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3));
    return set.size;
  });
  check('截图内容非纯色（真实画面）', variance > 8, variance);

  await rp.click('#trough-gallery .trough-gal-card').catch(() => {});
  await rp.waitForTimeout(200);
  check('报告内点击可全屏预览', await rp.evaluate(() => !!document.querySelector('.trough-gal-overlay')));
  check('报告无 JS 报错', reportErrors.length === 0, reportErrors.slice(0, 3));

  await browser.close();
  console.log(`\n===== 真机低谷截图结果: ${pass} PASS / ${fail} FAIL =====`);
  if (fail) console.log('FAILED: ' + FAILS.join(', '));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
