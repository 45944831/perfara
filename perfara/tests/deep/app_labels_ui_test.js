/**
 * 采集窗口应用下拉框：桌面名的渐进更新、排序、选中保持、回退包名。
 * Playwright + Edge 驱动真实的 index.html，perfAPI 全部打桩（假设备/假应用），
 * 不连真机、不含任何真实应用名。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const pw = require('playwright-core');

const PROJ = path.resolve(__dirname, '..', '..', '..');
const RENDERER = path.join(PROJ, '_client_src', 'app', 'renderer');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

let passed = 0, failed = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; FAILS.push(name); console.log('  FAIL  ' + name + '  -> ' + JSON.stringify(detail)); }
}

// 假应用：名字、顺序都和真实设备无关
const PKGS = [
  { pkg: 'com.demo.alpha', label: 'com.demo.alpha', versionCode: 1 },
  { pkg: 'com.demo.mike', label: 'com.demo.mike', versionCode: 2 },
  { pkg: 'com.demo.zeta', label: 'com.demo.zeta', versionCode: 3 },
  { pkg: 'com.example.local', label: 'com.example.local', versionCode: 4 },
];

const MOCK = `
window.perfAPI = new Proxy({}, { get: (t, k) => {
  if (k === 'then') return undefined;
  if (k === 'activationGetState') return async () => ({ activated: true, expiryLabel: '2099-12-31', hideActivationHints: true });
  if (k === 'getAppName') return async () => 'Perfara';
  if (k === 'getDevices') return async () => [{ id: 'FAKEDEV1', displayName: '测试机', model: 'Test' }];
  if (k === 'getPackages') return async () => ${JSON.stringify(PKGS)};
  if (k === 'onAppLabels') return (cb) => { window.__labelCb = cb; };
  if (k === 'startCollect') return async (...args) => { window.__startArgs = args; return { ok: true }; };
  if (k === 'getAndroidDeviceInfo') return async () => ({ ok: false });
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

function optionTexts(page) {
  return page.evaluate(() => Array.from(document.getElementById('sel-app').options)
    .filter(o => o.value).map(o => ({ value: o.value, text: o.textContent })));
}

async function main() {
  if (!fs.existsSync(EDGE)) {
    console.log('SKIP: 未找到 Edge，跳过 UI 验证');
    process.exit(0);
  }
  const server = await serveRenderer();
  const port = server.address().port;
  const browser = await pw.chromium.launch({ executablePath: EDGE, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(MOCK);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const s = document.getElementById('sel-app');
    return s && s.options.length === 5 && !s.disabled;
  }, null, { timeout: 15000 });

  console.log('[1] 初次加载（无缓存名）');
  let opts = await optionTexts(page);
  check('四个应用按包名显示', opts.length === 4 && opts.every(o => o.text === o.value), opts);

  // 用户先选一个，后台名字陆续到位时不能把选中项弄丢
  await page.selectOption('#sel-app', 'com.demo.mike');

  console.log('[2] 后台推送部分名字');
  await page.evaluate(() => window.__labelCb({
    deviceId: 'FAKEDEV1',
    items: [{ pkg: 'com.demo.alpha', label: '甲应用' }, { pkg: 'com.demo.zeta', label: '丙应用' }],
    done: 2, total: 4,
  }));
  await page.waitForTimeout(150);
  opts = await optionTexts(page);
  const alpha = opts.find(o => o.value === 'com.demo.alpha');
  const mike = opts.find(o => o.value === 'com.demo.mike');
  check('解析中的名字就地更新', alpha && alpha.text === '甲应用 (com.demo.alpha)', alpha);
  check('未解析的仍旧显示包名', mike && mike.text === 'com.demo.mike', mike);
  check('解析中保持包名顺序', opts.map(o => o.value).join(',') === PKGS.map(p => p.pkg).join(','), opts.map(o => o.value));
  const selNow = await page.evaluate(() => document.getElementById('sel-app').value);
  check('选中项未被重排冲掉', selNow === 'com.demo.mike', selNow);

  console.log('[3] 别的设备推来的名字要忽略');
  await page.evaluate(() => window.__labelCb({
    deviceId: 'OTHERDEV',
    items: [{ pkg: 'com.demo.mike', label: '别人的名字' }],
    done: 4, total: 4, finished: true,
  }));
  await page.waitForTimeout(120);
  opts = await optionTexts(page);
  check('异设备事件被丢弃', opts.find(o => o.value === 'com.demo.mike').text === 'com.demo.mike', opts);

  console.log('[4] 解析完成：按显示名排序');
  await page.evaluate(() => window.__labelCb({
    deviceId: 'FAKEDEV1',
    items: [{ pkg: 'com.demo.mike', label: '乙应用' }],
    done: 4, total: 4, finished: true,
  }));
  await page.waitForTimeout(200);
  const sorted = await page.evaluate(() => {
    const opts = Array.from(document.getElementById('sel-app').options).filter(o => o.value);
    const key = o => (o.text.includes(' (') ? o.text.split(' (')[0] : o.value);
    const expected = opts.slice().sort((a, b) => key(a).localeCompare(key(b), 'zh-Hans-CN'));
    return {
      actual: opts.map(o => o.value),
      expected: expected.map(o => o.value),
      texts: opts.map(o => o.text),
      selected: document.getElementById('sel-app').value,
      log: document.getElementById('log-output').textContent,
    };
  });
  check('排序与中文排序规则一致', sorted.actual.join(',') === sorted.expected.join(','), sorted);
  check('三个应用显示名字，无名字的只显示包名',
    sorted.texts.includes('甲应用 (com.demo.alpha)')
    && sorted.texts.includes('乙应用 (com.demo.mike)')
    && sorted.texts.includes('丙应用 (com.demo.zeta)')
    && sorted.texts.includes('com.example.local'), sorted.texts);
  check('排序后仍保持选中', sorted.selected === 'com.demo.mike', sorted.selected);
  check('日志记录解析结果', /应用名解析完成：3\/4/.test(sorted.log), sorted.log.slice(-120));

  console.log('[5] 开始采集带的是桌面名');
  await page.click('#btn-start');
  await page.waitForTimeout(200);
  const args = await page.evaluate(() => window.__startArgs || null);
  check('startCollect 的 appLabel 是桌面名', args && args[3] === '乙应用', args);
  check('页面无 JS 异常', errors.length === 0, errors);

  await browser.close();
  server.close();

  console.log(`\n结果：${passed} PASS / ${failed} FAIL`);
  if (failed > 0) { console.log('FAILED: ' + FAILS.join(', ')); process.exit(1); }
  console.log('APP_LABELS_UI_OK');
}

main().catch(e => { console.error('UNCAUGHT', e); process.exit(1); });
