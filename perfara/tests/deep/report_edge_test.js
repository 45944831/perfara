'use strict';
/**
 * 报告渲染边界测试：用畸形 / 极端 payload 打开真实 perf.html。
 *
 * 构造方式完全复刻产品线的自包含导出（main.js:buildSharedReportHtml）：
 *   ① 内联 echarts.min.js（放进同一目录，模板的相对路径即可解析）
 *   ② 把「外部 data 加载」那段替换成 `var data = <payload>`
 * 这样打开的是**离线自包含**文件，与用户实际导出的报告同构。
 *
 * 目标：报告页对「空数据 / 单点 / 全 null / 超大值 / 负数 / 缺字段」
 * 都不能白屏、不能 JS 报错。
 *
 * 用法: node report_edge_test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const pw = require('playwright-core');

const PROJ = path.resolve(__dirname, '..', '..', '..');
const REPORTS = path.join(PROJ, 'perfara', 'collector', 'resources', 'reports');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-edge-'));

let passed = 0, failed = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; fails.push(name); console.log(`  FAIL  ${name}  -> ${JSON.stringify(detail)}`); }
}

/** 与 main.js 相同的数据注入：替换外部加载脚本为内联 data */
function injectData(html, payload) {
  const mark = '<!-- external: 全局 data';
  const mi = html.indexOf(mark);
  if (mi < 0) throw new Error('未找到外部数据标记');
  const tagStart = html.indexOf('<script>', mi);
  const tagEnd = html.indexOf('</script>', tagStart);
  if (tagStart < 0 || tagEnd < 0) throw new Error('外部数据 script 标签不完整');
  const json = JSON.stringify(payload).replace(/<\//g, '<\\/');
  return html.slice(0, tagStart)
    + '<script>\nvar data = ' + json + ';\n</' + 'script>\n'
    + html.slice(tagEnd + '</script>'.length);
}

function basePayload() {
  return {
    device: { model: 'EdgeTest', brand: 'X', android: '13', sdk: 33, cpu: 'test' },
    app: { pkg: 'com.edge.test', name: 'EdgeTest', version: '1.0' },
    perf: {
      fps: [60, 60, 60],
      cpu: [10, 11, 12],
      mem: [100, 101, 102],
      temp: [40, 41, 42],
      net: [{ rx: 1, tx: 2 }, { rx: 2, tx: 3 }, { rx: 3, tx: 4 }],
      battery: [{ level: 90 }, { level: 89 }, { level: 88 }],
      gpu: [5, 6, 7],
      gpuTemp: [50, 51, 52],
      jank: [1, 2, 3],
    },
    ts: 1700000000000,
    testid: 'edgetest0001',
  };
}

const withSeries = (over) => {
  const p = basePayload();
  Object.assign(p.perf, over);
  return p;
};
const truncate = (p, k) => {
  for (const key of Object.keys(p.perf)) {
    const v = p.perf[key];
    if (Array.isArray(v) && v.length > k) p.perf[key] = v.slice(0, k);
  }
  return p;
};

const CASES = [
  ['正常基准', basePayload],
  ['perf 全部为空数组', () => withSeries({ fps: [], cpu: [], mem: [], temp: [], net: [], battery: [], gpu: [], gpuTemp: [], jank: [] })],
  ['perf 键全部缺失', () => { const p = basePayload(); p.perf = {}; return p; }],
  ['perf 字段为 null', () => withSeries({ fps: null, cpu: null, mem: null, temp: null, net: null, battery: null, gpu: null, gpuTemp: null, jank: null })],
  ['单点数据', () => truncate(basePayload(), 1)],
  ['两个点', () => truncate(basePayload(), 2)],
  ['全 0 值', () => withSeries({ fps: [0, 0, 0], cpu: [0, 0, 0], mem: [0, 0, 0], temp: [0, 0, 0], net: [], battery: [], gpu: [0, 0, 0], gpuTemp: [0, 0, 0], jank: [0, 0, 0] })],
  ['全 null 序列', () => withSeries({ fps: [null, null, null], cpu: [null, null, null], mem: [null, null, null], temp: [null, null, null], net: [], battery: [], gpu: [null, null, null], gpuTemp: [null, null, null], jank: [null, null, null] })],
  ['超大值(1e9)', () => withSeries({ fps: [1e9, 1e9, 1e9], cpu: [1e9, 1e9, 1e9], mem: [1e9, 1e9, 1e9], temp: [1e9, 1e9, 1e9], net: [], battery: [], gpu: [1e9, 1e9, 1e9], gpuTemp: [1e9, 1e9, 1e9], jank: [1e9, 1e9, 1e9] })],
  ['负值', () => withSeries({ fps: [-60, -60, -60], cpu: [-10, -10, -10], mem: [-100, -100, -100], temp: [-40, -40, -40], net: [], battery: [], gpu: [-5, -5, -5], gpuTemp: [-50, -50, -50], jank: [-1, -1, -1] })],
  ['device/app 缺失', () => { const p = basePayload(); delete p.device; delete p.app; return p; }],
  ['testid 缺失', () => { const p = basePayload(); delete p.testid; return p; }],
  ['testid 含特殊字符', () => { const p = basePayload(); p.testid = 'a<b>"c&d\'e'; return p; }],
  ['net/battery 为裸数字数组', () => withSeries({ net: [1, 2, 3], battery: [50, 51, 52] })],
  ['超长序列(3000点)', () => {
    const p = basePayload();
    const n = 3000;
    p.perf.fps = Array.from({ length: n }, (_, i) => 50 + (i % 10));
    p.perf.cpu = Array.from({ length: n }, (_, i) => i % 100);
    p.perf.mem = Array.from({ length: n }, (_, i) => 500 + (i % 50));
    return p;
  }],
];

(async () => {
  const html = fs.readFileSync(path.join(REPORTS, 'perf.html'), 'utf-8');
  // echarts.min.js 放同目录，模板相对路径即可解析（与产品一致）
  fs.copyFileSync(path.join(REPORTS, 'echarts.min.js'), path.join(OUT, 'echarts.min.js'));

  console.log('===== 报告渲染边界测试 =====\n');

  for (let idx = 0; idx < CASES.length; idx++) {
    const [name, mk] = CASES[idx];
    const payload = mk();
    const f = path.join(OUT, `case_${idx}.html`);
    fs.writeFileSync(f, injectData(html, payload), 'utf-8');

    const browser = await pw.chromium.launch({ executablePath: EDGE, headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message || e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    let canvasCount = 0, bodyLen = 0, renderErr = null, bodyText = '';
    try {
      await page.goto('file://' + f.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 15000 });
      await page.waitForTimeout(2500);
      canvasCount = await page.evaluate(() => document.querySelectorAll('canvas').length);
      bodyLen = await page.evaluate(() => document.body.innerText.trim().length);
      bodyText = await page.evaluate(() => document.body.innerText);
      if (/TypeError|Cannot read|is not a function|is not defined/.test(bodyText)) {
        renderErr = '页面文本含 JS 错误痕迹';
      }
    } catch (e) {
      renderErr = String(e.message || e);
    }
    await browser.close();

    // ERR_FILE_NOT_FOUND 之类资源错误单独看（不应出现）
    const resErr = errors.filter(e => /ERR_FILE_NOT_FOUND|Failed to load resource/.test(e));
    const jsErr = errors.filter(e => !/ERR_FILE_NOT_FOUND|Failed to load resource/.test(e));

    check(`「${name}」不白屏`, !renderErr && bodyLen > 50,
      { renderErr, bodyLen, resErr: resErr.slice(0, 1), jsErr: jsErr.slice(0, 2) });
    if (jsErr.length) console.log(`        canvas=${canvasCount} bodyLen=${bodyLen}`);
  }

  console.log(`\n===== 结果: ${passed} passed, ${failed} failed =====`);
  if (fails.length) console.log('FAILED: ' + fails.join(' | '));
  fs.rmSync(OUT, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
