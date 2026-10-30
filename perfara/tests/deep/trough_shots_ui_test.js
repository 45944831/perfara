/**
 * 低谷截图的两个展示面（playwright-core + Edge）：
 *   ① 采集窗口缩略图条：trough-shot 推送 → 缩略图 / 计数 / 上限 / 全屏预览 / 清空
 *   ② 本地报告 perf.html：data.shots → 画廊 / 全屏预览 / 坏图剔除
 *
 * 需要 NODE_PATH 指向 workspace/node_modules（run_deep_batch.sh 已设置）。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const pw = require('playwright-core');

const PROJ = path.resolve(__dirname, '..', '..', '..');
const APP = path.join(PROJ, '_client_src', 'app');
const RENDERER = path.join(APP, 'renderer');
const REPORTS = path.join(PROJ, 'perfara', 'collector', 'resources', 'reports');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-trough-'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

let passed = 0, failed = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; FAILS.push(name); console.log('  FAIL  ' + name + '  -> ' + JSON.stringify(detail)); }
}

/** 1x1 PNG，用来当截图缩略图 */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const DATA_URL = 'data:image/png;base64,' + PNG_1x1.toString('base64');

// mock preload：保留 onTroughShot 的真实回调，其他接口给「已激活」假值
const MOCK = `
window.perfAPI = new Proxy({}, { get: (t, k) => {
  if (k === 'then') return undefined;
  if (k === 'activationGetState') return async () => ({ activated: true, expiryLabel: '2099-12-31', hideActivationHints: true });
  if (k === 'onTroughShot') return (cb) => { window.__troughCb = cb; };
  if (k === 'removeTroughShotListener') return () => { window.__troughCb = null; };
  return async () => ({ ok: false, reason: 'mock' });
}});
`;

function serveRenderer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const base = rel.startsWith('node_modules/') ? path.resolve(RENDERER, '..') : RENDERER;
    const p = path.join(base, rel);
    try {
      const body = fs.readFileSync(p);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      res.end(body);
    } catch (e) { res.writeHead(404); res.end('nf'); }
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

/** 与 main.js 相同的数据注入：把外部 data.js 加载替换成内联 data */
function injectData(html, payload) {
  const mark = '<!-- external: 全局 data';
  const mi = html.indexOf(mark);
  const tagStart = html.indexOf('<script>', mi);
  const tagEnd = html.indexOf('</script>', tagStart);
  const json = JSON.stringify(payload).replace(/<\//g, '<\\/');
  return html.slice(0, tagStart) + '<script>var data = ' + json + ';</script>' + html.slice(tagEnd + '</script>'.length);
}

function basePayload(shots) {
  const pad = n => String(n).padStart(2, '0');
  const perf = [];
  for (let i = 0; i < 12; i++) {
    perf.push({
      timestamp: 1700000000000 + i * 1000,
      time: `12:00:${pad(i)}`,
      pid: 1234,
      cpu: { sysCpu: 10 + i, procCpu: 1 + i / 10 },
      cpuCores: { usage: [10, 20, 30, 40], freq: [1000, 1200, 1400, 1600] },
      mem: {
        totalPss: 100 + i, nativeHeap: 10, javaHeap: 10, dalvikHeap: 10,
        code: 10, stack: 1, graphics: 5, privateOther: 20, system: 30,
        memTotalMB: 8192, memAvailableMB: 4096,
      },
      fps: 60, jank: 0, bigJank: 0, smallJank: 0, tinyJank: 0,
      net: { rxKBps: 0, txKBps: 0 },
      temperature: 40,
      battery: { level: 80, currentNow: 400, power: 2000 },
      cswitch: 100,
    });
  }
  return {
    device: {
      category: 'android', name: 'TroughUI', brand: 'X', model: 'TroughUI',
      android: '13', sdk: 33, cpu: 'test', deviceId: 'test', udid: '',
    },
    app: { pkg: 'com.trough.ui', name: 'TroughUI', version: '1.0' },
    perf,
    tag: [],
    testid: 'troughui0001',
    shots,
  };
}

async function collectorStrip(browser, port, pageFile) {
  console.log(`[${pageFile}] 采集窗口缩略图条`);
  const context = await browser.newContext();
  await context.addInitScript(MOCK);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  await page.goto(`http://127.0.0.1:${port}/${pageFile}`, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  const init = await page.evaluate(() => ({
    hasCb: typeof window.__troughCb === 'function',
    hidden: document.getElementById('trough-strip') ? document.getElementById('trough-strip').hidden : null,
    beforeLog: (() => {
      const s = document.getElementById('trough-strip');
      const v = s && s.nextElementSibling;
      return !!(v && v.classList.contains('log-panel'));
    })(),
  }));
  check(`${pageFile} 已挂 onTroughShot`, init.hasCb === true, init);
  check(`${pageFile} 初始隐藏且插在日志面板前`, init.hidden === true && init.beforeLog === true, init);

  const one = await page.evaluate((url) => {
    window.__troughCb({ id: 't1', t: 1700000000000, time: '12:00:01', fps: 20, target: 60, file: 'x.jpg', url, bytes: 1234 });
    const strip = document.getElementById('trough-strip');
    const thumbs = strip.querySelectorAll('.trough-thumb');
    return {
      hidden: strip.hidden,
      count: strip.querySelector('#trough-count').textContent,
      thumbs: thumbs.length,
      imgOk: !!(thumbs[0] && thumbs[0].querySelector('img').getAttribute('src') === url),
      label: thumbs[0] ? thumbs[0].querySelector('span').textContent : '',
    };
  }, DATA_URL);
  check(`${pageFile} 推送 1 张后显示`, one.hidden === false && one.count === '1' && one.thumbs === 1, one);
  check(`${pageFile} 缩略图取 url`, one.imgOk === true, one);
  check(`${pageFile} 缩略图带时间与 fps`, /12:00:01/.test(one.label) && /20 fps/.test(one.label), one.label);

  const capped = await page.evaluate((url) => {
    for (let i = 0; i < 64; i++) {
      window.__troughCb({ time: '12:00:0' + (i % 10), fps: 30, target: 60, file: 'x' + i + '.jpg', url });
    }
    const strip = document.getElementById('trough-strip');
    return { thumbs: strip.querySelectorAll('.trough-thumb').length, count: strip.querySelector('#trough-count').textContent };
  }, DATA_URL);
  check(`${pageFile} 缩略图上限 60`, capped.thumbs === 60 && capped.count === '65', capped);

  const wired = await page.evaluate(() => {
    const m = window.chartMgr;
    return { has: !!m, n: m && Array.isArray(m._troughShots) ? m._troughShots.length : -1 };
  });
  check(`${pageFile} 截图同步到曲线状态`, wired.has === true && wired.n === 65, wired);

  await page.click('#trough-strip .trough-thumb');
  await page.waitForTimeout(150);
  const opened = await page.evaluate(() => {
    const ov = document.querySelector('.trough-overlay');
    return { visible: !!(ov && !ov.hidden), src: ov ? ov.querySelector('img').getAttribute('src') : null, cap: ov ? ov.querySelector('.trough-overlay-cap').textContent : '' };
  });
  check(`${pageFile} 点击放大`, opened.visible === true && opened.src === DATA_URL, opened);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const closed = await page.evaluate(() => {
    const ov = document.querySelector('.trough-overlay');
    return { hidden: !!(ov && ov.hidden), src: ov ? ov.querySelector('img').getAttribute('src') : 'no-el' };
  });
  check(`${pageFile} Esc 关闭并释放 src`, closed.hidden === true && closed.src === null, closed);

  const cleared = await page.evaluate(() => {
    window.troughShots.clear();
    const strip = document.getElementById('trough-strip');
    return { hidden: strip.hidden, thumbs: strip.querySelectorAll('.trough-thumb').length, count: strip.querySelector('#trough-count').textContent };
  });
  check(`${pageFile} clear 清空并隐藏`, cleared.hidden === true && cleared.thumbs === 0 && cleared.count === '0', cleared);
  const clearedChart = await page.evaluate(() => (window.chartMgr && Array.isArray(window.chartMgr._troughShots) ? window.chartMgr._troughShots.length : -1));
  check(`${pageFile} clear 同步清空曲线状态`, clearedChart === 0, clearedChart);

  check(`${pageFile} 无 JS 报错`, errors.length === 0, errors.slice(0, 3));
  await context.close();
}

async function reportGallery(browser) {
  console.log('[perf.html] 本地报告画廊');
  const html = fs.readFileSync(path.join(REPORTS, 'perf.html'), 'utf-8');
  fs.copyFileSync(path.join(REPORTS, 'echarts.min.js'), path.join(OUT, 'echarts.min.js'));
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(OUT, `shot${i}.jpg`), PNG_1x1);
    fs.writeFileSync(path.join(OUT, `thumb${i}.jpg`), PNG_1x1);
  }

  const fileUrl = p => 'file:///' + p.replace(/\\/g, '/');
  const shots = [0, 1, 2].map(i => ({
    id: 's' + i, t: 1700000000000 + i * 1000, time: '12:00:0' + i, fps: 18 + i, target: 60,
    file: path.join(OUT, `shot${i}.jpg`), url: fileUrl(path.join(OUT, `shot${i}.jpg`)),
    thumb: '', thumbUrl: fileUrl(path.join(OUT, `thumb${i}.jpg`)), bytes: PNG_1x1.length,
  }));

  const run = async (payload, file, waitMs) => {
    fs.writeFileSync(path.join(OUT, file), injectData(html, payload), 'utf-8');
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message || e)));
    await page.goto(fileUrl(path.join(OUT, file)), { waitUntil: 'load', timeout: 15000 });
    await page.waitForTimeout(waitMs || 3500);
    const state = await page.evaluate(() => {
      const sec = document.getElementById('trough-gallery');
      return {
        hasSec: !!sec,
        title: sec ? sec.querySelector('.chart-title').textContent : '',
        cards: sec ? sec.querySelectorAll('.trough-gal-card').length : 0,
        firstCap: sec && sec.querySelector('.trough-gal-card span') ? sec.querySelector('.trough-gal-card span').textContent : '',
      };
    });
    return { page, errors, state };
  };

  // 正常三张
  let r = await run(basePayload(shots), 'gallery_ok.html');
  check('报告出现低谷截图区块', r.state.hasSec === true, r.state);
  check('标题含张数', /性能低谷截图（3）/.test(r.state.title), r.state.title);
  check('画廊 3 张', r.state.cards === 3, r.state);
  check('卡面带时间与 fps', /12:00:00/.test(r.state.firstCap) && /18 fps/.test(r.state.firstCap), r.state.firstCap);

  await r.page.waitForFunction(() => {
    const el = document.getElementById('chart-fps');
    const inst = el && window.echarts && echarts.getInstanceByDom(el);
    const mp = inst && inst.getOption().series[0] && inst.getOption().series[0].markPoint;
    return !!(mp && Array.isArray(mp.data) && mp.data.length === 3);
  }, null, { timeout: 8000 }).catch(() => {});
  const marks = await r.page.evaluate(() => {
    const el = document.getElementById('chart-fps');
    const inst = el && window.echarts && echarts.getInstanceByDom(el);
    const opt = inst && inst.getOption();
    const mp = opt && opt.series[0] && opt.series[0].markPoint;
    return {
      n: mp && Array.isArray(mp.data) ? mp.data.length : 0,
      sym: mp && mp.data && mp.data[0] ? mp.data[0].symbol : '',
      coords: mp && mp.data ? mp.data.map(m => m.coord) : [],
    };
  });
  check('FPS 曲线出现 3 个截图标记', marks.n === 3, marks);
  check('曲线标记优先用缩略图', /thumb0\.jpg$/.test(marks.sym || ''), marks.sym);

  const markPos = await r.page.evaluate(() => {
    const el = document.getElementById('chart-fps');
    const inst = echarts.getInstanceByDom(el);
    const mp = inst.getOption().series[0].markPoint.data;
    el.scrollIntoView({ block: 'center' });
    const xy = inst.convertToPixel({ seriesIndex: 0 }, mp[1].coord);
    const b = el.getBoundingClientRect();
    return { x: b.x + xy[0], y: b.y + xy[1] - 46 };
  });
  await r.page.mouse.click(markPos.x, markPos.y);
  await r.page.waitForTimeout(250);
  const markOv = await r.page.evaluate(() => {
    const o = document.querySelector('.trough-gal-overlay');
    return {
      open: !!o,
      cap: o ? o.querySelector('div').textContent : '',
      src: o ? o.querySelector('img').getAttribute('src') : '',
    };
  });
  check('点击曲线标记打开全屏预览', markOv.open === true && /12:00:01/.test(markOv.cap) && /shot1\.jpg$/.test(markOv.src), markOv);
  await r.page.keyboard.press('Escape');
  await r.page.waitForTimeout(150);

  await r.page.click('#trough-gallery .trough-gal-card');
  await r.page.waitForTimeout(150);
  const ov = await r.page.evaluate(() => {
    const o = document.querySelector('.trough-gal-overlay');
    return { visible: !!o, src: o ? o.querySelector('img').getAttribute('src') : null, cap: o ? o.querySelector('div').textContent : '' };
  });
  check('点击卡片全屏预览', ov.visible === true && /shot0\.jpg$/.test(ov.src || ''), ov);
  await r.page.keyboard.press('Escape');
  await r.page.waitForTimeout(150);
  check('Esc 关闭预览', await r.page.evaluate(() => !document.querySelector('.trough-gal-overlay')) === true);
  check('正常数据无 JS 报错', r.errors.length === 0, r.errors.slice(0, 3));
  await r.page.close();

  // 缺图：一张坏图被剔除，其余保留
  const mixed = shots.map(s => Object.assign({}, s));
  mixed.splice(1, 0, { id: 'bad', time: '12:00:09', fps: 10, target: 60, file: path.join(OUT, 'nope.jpg'), url: fileUrl(path.join(OUT, 'nope.jpg')) });
  r = await run(basePayload(mixed), 'gallery_bad_one.html');
  check('坏图剔除后保留 3 张', r.state.cards === 3 && r.state.hasSec === true, r.state);
  await r.page.close();

  // 全部缺图：整段移除，不白屏
  const allBad = [{ time: '12:00:09', fps: 10, target: 60, file: path.join(OUT, 'nope2.jpg'), url: fileUrl(path.join(OUT, 'nope2.jpg')) }];
  r = await run(basePayload(allBad), 'gallery_all_bad.html');
  const bodyLen = await r.page.evaluate(() => document.body.innerText.trim().length);
  check('全部缺图时移除区块', r.state.hasSec === false, r.state);
  check('全部缺图不白屏', bodyLen > 50, bodyLen);
  await r.page.close();

  // 无 shots 字段：不出现区块，报告照常
  const noShots = basePayload([]);
  r = await run(noShots, 'gallery_none.html', 2500);
  check('无截图时不出现区块', r.state.hasSec === false, r.state);
  await r.page.close();
}

/** 采集窗口：低谷截图同时钉到实时 FPS 曲线，且抽稀后能重新投影 */
async function collectorCurveMarks(browser, port) {
  console.log('[index.html] 实时 FPS 曲线标记');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(MOCK);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.chartMgr && window.chartMgr._ready, null, { timeout: 15000 });

  await page.evaluate((url) => {
    const pad = n => String(n).padStart(2, '0');
    for (let i = 0; i < 12; i++) {
      window.chartMgr.update({
        time: `12:00:${pad(i)}`,
        fps: 60, jank: 0, bigJank: 0, smallJank: 0, tinyJank: 0,
        cpu: { sysCpu: 10, procCpu: 1 }, mem: { totalPss: 100 },
        cpuCores: { usage: [10, 20], freq: [1000, 1200] },
        net: { rxKBps: 0, txKBps: 0 }, temperature: 40, cswitch: 10,
      });
    }
    window.troughShots.add({ id: 'a', time: '12:00:03', fps: 20, target: 60, file: 'x.jpg', url, thumbUrl: url });
    window.troughShots.add({ id: 'b', time: '12:00:07', fps: 15, target: 60, file: 'y.jpg', url, thumbUrl: url });
  }, DATA_URL);
  await page.waitForTimeout(300);

  const live = await page.evaluate(() => {
    const inst = window.chartMgr._charts.fps;
    const mp = inst.getOption().series[0].markPoint;
    const data = mp && Array.isArray(mp.data) ? mp.data : [];
    const el = document.getElementById('chart-fps');
    el.scrollIntoView({ block: 'center' });
    let pos = null;
    if (data.length) {
      const xy = inst.convertToPixel({ seriesIndex: 0 }, data[0].coord);
      const b = el.getBoundingClientRect();
      pos = { x: b.x + xy[0], y: b.y + xy[1] - 46 };
    }
    return {
      n: data.length,
      coords: data.map(m => m.coord),
      sym: data[0] ? data[0].symbol : '',
      pos,
    };
  });
  check('采集窗口曲线出现 2 个截图标记', live.n === 2 && live.coords[0][0] === '12:00:03', live);
  check('采集窗口标记用缩略图', live.sym === 'image://' + DATA_URL, live.sym);

  if (live.pos) {
    await page.mouse.click(live.pos.x, live.pos.y);
    await page.waitForTimeout(250);
    const ov = await page.evaluate(() => {
      const o = document.querySelector('.trough-overlay');
      return { open: !!(o && !o.hidden), src: o ? o.querySelector('img').getAttribute('src') : '', cap: o ? o.querySelector('.trough-overlay-cap').textContent : '' };
    });
    check('点击曲线标记打开截图', ov.open === true && ov.src === DATA_URL && /12:00:03/.test(ov.cap), ov);
    await page.keyboard.press('Escape');
  } else {
    check('点击曲线标记打开截图', false, 'no mark position');
  }

  const cleared = await page.evaluate(() => {
    window.troughShots.clear();
    const mp = window.chartMgr._charts.fps.getOption().series[0].markPoint;
    return { n: mp && Array.isArray(mp.data) ? mp.data.length : 0 };
  });
  check('清空采集后曲线标记一起清空', cleared.n === 0, cleared);

  // 长跑抽稀：被删掉的锚点要投影到最近保留点，而不是整张消失
  const decimated = await page.evaluate((url) => {
    const mgr = window.chartMgr;
    const st = mgr._data.fps;
    st.times = [];
    st.series = st.series.map(() => []);
    const base = new Date(2020, 0, 1, 0, 0, 0).getTime();
    for (let i = 0; i < 4001; i++) {
      const t = new Date(base + i * 1000).toTimeString().slice(0, 8);
      st.times.push(t);
      st.series.forEach(s => s.push(60));
    }
    const droppedTime = st.times[3999];
    mgr._decimateIfNeeded(st);
    mgr.pushTroughShot({ id: 'c', time: droppedTime, fps: 10, target: 60, thumb: url });
    const mp = mgr._charts.fps.getOption().series[0].markPoint.data;
    return {
      droppedTime,
      stillThere: st.times.indexOf(droppedTime) >= 0,
      marks: mp.length,
      coord: mp[0] ? mp[0].coord : null,
      coordKept: mp[0] ? st.times.indexOf(mp[0].coord[0]) >= 0 : false,
    };
  }, DATA_URL);
  check('抽稀后截图锚点投影到最近的保留点', decimated.marks === 1 && decimated.stillThere === false && decimated.coordKept === true && decimated.coord[0] !== decimated.droppedTime, decimated);

  check('曲线标记无 JS 报错', errors.length === 0, errors.slice(0, 3));
  await context.close();
}

(async () => {
  console.log('===== 低谷截图展示面测试 =====\n');
  const server = await serveRenderer();
  const port = server.address().port;
  const browser = await pw.chromium.launch({ executablePath: EDGE, headless: true });
  try {
    for (const f of ['index.html', 'iphone.html', 'iphone_gpu.html']) {
      await collectorStrip(browser, port, f);
    }
    await collectorCurveMarks(browser, port);
    await reportGallery(browser);
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(OUT, { recursive: true, force: true });
  }
  console.log(`\n===== 展示面测试结果: ${passed} PASS / ${failed} FAIL =====`);
  if (failed) console.log('FAILED: ' + FAILS.join(', '));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
