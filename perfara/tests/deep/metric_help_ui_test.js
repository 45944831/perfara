/**
 * 主界面「各参数 !」口径说明（playwright-core + Edge，真实 index.html + 打桩 perfAPI）。
 *
 * 锁的是行为，不是文案：
 *   ① 每张参数卡都挂了 !，且 ! 的 id 与 metric-help.js 里的说明条目一一对应；
 *   ② 点 ! 展开、再点收起、点另一个切换（同一时刻只开一个）；
 *   ③ 点外部 / Esc / 窗口失焦收起；
 *   ④ 面板不出视口（1280 与最小宽度 1024）；
 *   ⑤ 展开不改变卡片数值区布局（! 不能把标签撑高、把 value 挤走）。
 *
 * 需要 NODE_PATH 指向 workspace/node_modules（run_deep_batch.sh 已设置）。
 */
'use strict';
const fs = require('fs');
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

/** 与弱网 / 低谷截图 UI 测试同款打桩：只要不崩，页面自己的 DOM/事件逻辑才是被测对象 */
const MOCK = `
window.perfAPI = new Proxy({}, { get: (t, k) => {
  if (k === 'then') return undefined;
  if (k === 'activationGetState') return async () => ({ activated: true, expiryLabel: '2099-12-31', hideActivationHints: true });
  return async () => ({ ok: false, reason: 'mock' });
}});
`;

function serveRenderer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const p = path.join(RENDERER, rel);
    try {
      const body = fs.readFileSync(p);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      res.end(body);
    } catch (e) { res.writeHead(404); res.end('nf'); }
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

async function openPage(browser, port, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 } });
  await ctx.addInitScript(MOCK);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  return { ctx, page, errors };
}

(async () => {
  console.log('===== 主界面参数口径说明测试 =====\n');

  // ── ① 静态对应关系：说明条目 ↔ 卡片 id ─────────────────────────────────────
  const helpSrc = fs.readFileSync(path.join(RENDERER, 'metric-help.js'), 'utf8');
  const helpKeys = [...helpSrc.matchAll(/'(card-[a-z]+)'\s*:\s*\{/g)].map(m => m[1]);
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  const cardIds = [...html.matchAll(/<div class="card" id="(card-[a-z]+)"/g)].map(m => m[1]);
  check('index.html 引入 metric-help.js', html.includes('<script src="metric-help.js"></script>'));
  check('说明条目数与参数卡数一致', helpKeys.length === cardIds.length && cardIds.length >= 10,
    { helpKeys: helpKeys.length, cardIds: cardIds.length });
  check('每张卡都有说明条目', cardIds.every(id => helpKeys.includes(id)),
    cardIds.filter(id => !helpKeys.includes(id)));
  check('说明条目没有指向不存在的卡', helpKeys.every(k => cardIds.includes(k)),
    helpKeys.filter(k => !cardIds.includes(k)));
  // 2026-11-17 从零筛查：这套「!」与主界面实时采集卡绑定，与报告页三份说明块
  // 相互独立，历史上从未随报告口径同步。文案必须与源码口径一致，否则用户
  // 在主界面点「!」读到的是过期说法。
  check('说明：温度主数值以 BATTERY 优先（与 adb.js 取数顺序一致）',
    /电池热敏电阻（BATTERY[\s\S]{0,40}其次 SKIN/.test(helpSrc)
      && !/优先取 thermalservice 的机身节点，取不到时用电池温度兜底/.test(helpSrc), true);
  check('说明：PSS 按 5 秒降频（与 MEM_FULL_REFRESH_MS=5000 一致，非「5 拍」）',
    /PSS 家族每 5 秒实测一次/.test(helpSrc) && !/每 5 拍实测一次/.test(helpSrc), true);

  const server = await serveRenderer();
  const port = server.address().port;
  const browser = await pw.chromium.launch({ executablePath: EDGE, headless: true });

  try {
    for (const width of [1280, 1024]) {
      console.log(`\n[width=${width}]`);
      const { ctx, page, errors } = await openPage(browser, port, width);

      // ── ② 每张卡都有 ! ────────────────────────────────────────────────────
      const dotInfo = await page.evaluate(() => [...document.querySelectorAll('.cards .card')].map(c => {
        const d = c.querySelector('.metric-help-dot');
        return { id: c.id, hasDot: !!d, w: d ? Math.round(d.getBoundingClientRect().width) : 0 };
      }));
      check(`每张卡都挂 ! (${dotInfo.length} 张)`, dotInfo.length === 10 && dotInfo.every(d => d.hasDot),
        dotInfo.filter(d => !d.hasDot));
      check('! 有实际尺寸（没被样式压成 0）', dotInfo.every(d => d.w >= 10), dotInfo.map(d => d.w));

      // 展开不能把卡片撑高：记录 系统 CPU 卡内 value 的纵坐标
      const before = await page.evaluate(() => {
        const c = document.getElementById('card-cpu');
        return { h: Math.round(c.getBoundingClientRect().height), vy: Math.round(document.getElementById('val-syscpu').getBoundingClientRect().top) };
      });

      // ── ③ 点开 / 收起 / 切换 ──────────────────────────────────────────────
      await page.click('#card-cpu .metric-help-dot');
      await page.waitForTimeout(120);
      const opened = await page.evaluate(() => {
        const p = document.getElementById('metric-help-panel');
        const b = p.getBoundingClientRect();
        return {
          hidden: p.hidden,
          title: p.querySelector('.metric-help-panel__title').textContent,
          tag: p.querySelector('.metric-help-panel__tag').textContent,
          rows: p.querySelectorAll('.metric-help-panel__list li').length,
          foot: !!p.querySelector('.metric-help-panel__foot'),
          expanded: document.querySelectorAll('.metric-help-dot[aria-expanded="true"]').length,
          inViewport: b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight,
        };
      });
      check('点 ! 展开面板', opened.hidden === false);
      check('标题是「系统 CPU」', opened.title === '系统 CPU', opened.title);
      check('口径标签是整机', opened.tag === '整机口径', opened.tag);
      check('说明有 2 条要点 + 脚注', opened.rows === 2 && opened.foot, opened);
      check('只有被点的 ! 处于展开态', opened.expanded === 1, opened.expanded);
      check('面板不出视口', opened.inViewport, opened);

      const after = await page.evaluate(() => {
        const c = document.getElementById('card-cpu');
        return { h: Math.round(c.getBoundingClientRect().height), vy: Math.round(document.getElementById('val-syscpu').getBoundingClientRect().top) };
      });
      check('展开面板不改变卡片高度与数值位置', after.h === before.h && after.vy === before.vy, { before, after });

      await page.click('#card-cpu .metric-help-dot');
      await page.waitForTimeout(100);
      check('再点同一个 ! 收起', await page.evaluate(() => document.getElementById('metric-help-panel').hidden));

      // 切到另一张卡：内容跟着换，同时只开一个
      await page.click('#card-cpu .metric-help-dot');
      await page.waitForTimeout(80);
      await page.click('#card-proccpu .metric-help-dot');
      await page.waitForTimeout(120);
      const switched = await page.evaluate(() => ({
        title: document.getElementById('metric-help-panel').querySelector('.metric-help-panel__title').textContent,
        tag: document.getElementById('metric-help-panel').querySelector('.metric-help-panel__tag').textContent,
        expanded: document.querySelectorAll('.metric-help-dot[aria-expanded="true"]').length,
      }));
      check('点另一张卡切换内容', switched.title === '进程 CPU' && switched.tag === '应用口径', switched);
      check('切换后仍只开一个', switched.expanded === 1, switched.expanded);

      // ── ④ 收起路径：点外部 / Esc / 失焦 ────────────────────────────────────
      await page.mouse.click(width / 2, 620);
      await page.waitForTimeout(120);
      check('点面板外部收起', await page.evaluate(() => document.getElementById('metric-help-panel').hidden));

      await page.click('#card-jank .metric-help-dot');
      await page.waitForTimeout(80);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
      check('Esc 收起', await page.evaluate(() => document.getElementById('metric-help-panel').hidden));

      await page.click('#card-jank .metric-help-dot');
      await page.waitForTimeout(80);
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await page.waitForTimeout(100);
      check('窗口失焦收起', await page.evaluate(() => document.getElementById('metric-help-panel').hidden));

      // 面板内部点击不收起（方便选中文字）
      await page.click('#card-jank .metric-help-dot');
      await page.waitForTimeout(80);
      await page.click('#metric-help-panel .metric-help-panel__title');
      await page.waitForTimeout(100);
      check('点面板内部不收起', await page.evaluate(() => !document.getElementById('metric-help-panel').hidden));

      // ── ⑤ 键盘可达 ────────────────────────────────────────────────────────
      await page.keyboard.press('Escape');
      await page.waitForTimeout(60);
      await page.focus('#card-fps .metric-help-dot');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(120);
      const kb = await page.evaluate(() => ({
        hidden: document.getElementById('metric-help-panel').hidden,
        title: document.querySelector('#metric-help-panel .metric-help-panel__title').textContent,
      }));
      check('键盘 Enter 也能展开', kb.hidden === false && kb.title === 'FPS', kb);

      // ── ⑥ 每张卡的说明都能打开且不出视口 ──────────────────────────────────
      const perCard = [];
      for (const id of dotInfo.map(d => d.id)) {
        await page.click(`#${id} .metric-help-dot`);
        await page.waitForTimeout(60);
        perCard.push(await page.evaluate(() => {
          const p = document.getElementById('metric-help-panel');
          const b = p.getBoundingClientRect();
          return {
            hidden: p.hidden,
            title: p.querySelector('.metric-help-panel__title').textContent,
            rows: p.querySelectorAll('.metric-help-panel__list li').length,
            inViewport: b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight,
          };
        }));
      }
      check('10 张卡的说明都能打开', perCard.every(c => !c.hidden && c.rows === 2), perCard.filter(c => c.hidden || c.rows !== 2));
      check('10 张卡的面板都在视口内', perCard.every(c => c.inViewport), perCard.filter(c => !c.inViewport));

      check(`width=${width} 无 JS 报错`, errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n===== 结果: ${passed} PASS / ${failed} FAIL =====`);
  if (failed) console.log('FAILED: ' + FAILS.join(', '));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
