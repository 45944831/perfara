'use strict';
/** 用 harness 页在多种窗口宽度下渲染修复后的 FPS 图，量化检查图例与轴名称是否重叠。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const pw = require('playwright-core');

const ROOT = path.join(__dirname, 'fixtures_fps_harness');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = process.argv[2] || path.join(__dirname, '_shots');
fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };

let failed = 0;
function check(name, cond, detail) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '  -> ' + JSON.stringify(detail)));
  if (!cond) failed++;
}

(async () => {
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'harness.html');
    try {
      const body = fs.readFileSync(p);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch (e) { res.writeHead(404); res.end('nf'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await pw.chromium.launch({ executablePath: EDGE, args: ['--no-sandbox', '--headless=new'] });

  for (const width of [1240, 1000, 700]) {
    console.log(`== 窗口宽度 ${width}px ==`);
    const page = await browser.newPage({ viewport: { width, height: 300 } });
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/harness.html`, { waitUntil: 'load' });
    await page.waitForTimeout(2600); // 等若干帧数据
    // 量化：从 canvas 顶部条带像素检测。图例与轴名称都在 y<20 的条带里。
    // 若图例居中，条带中央应有内容（图例），而右缘 44~60px 区域不应有灰色文字（卡顿名称不会被盖住=仍存在，但与图例不相交）。
    // 直接采用几何判定：用 echarts 内部 opt 计算图例矩形 vs 轴名称位置不可靠，改用像素法：
    // 取 canvas 顶条带，检测「图例像素」与「右轴名称像素」的水平区间是否相交。
    const res = await page.evaluate(() => {
      const cv = document.querySelector('#chart-fps canvas');
      const w = cv.width, h = cv.height;
      const ctx = cv.getContext('2d');
      const img = ctx.getImageData(0, 0, w, Math.min(24, h)).data;
      const cols = [];
      for (let x = 0; x < w; x++) {
        let hit = false;
        for (let y = 0; y < Math.min(24, h); y++) {
          const i = (y * w + x) * 4;
          const a = img[i + 3], r = img[i], g = img[i + 1], b = img[i + 2];
          if (a > 40 && (r > 90 || g > 90 || b > 90)) { hit = true; break; }
        }
        cols.push(hit);
      }
      // 找连续文字段
      const segs = [];
      let s = -1;
      for (let x = 0; x < w; x++) {
        if (cols[x] && s < 0) s = x;
        if ((!cols[x] || x === w - 1) && s >= 0) { segs.push([s, x]); s = -1; }
      }
      // 合并间隔 < 30px 的段（图例项之间有间隔但同属图例）
      const merged = [];
      for (const seg of segs) {
        if (merged.length && seg[0] - merged[merged.length - 1][1] < 30) merged[merged.length - 1][1] = seg[1];
        else merged.push([...seg]);
      }
      return { w, h, segments: merged };
    });
    // 期望：两个内容块 —— 左轴名称 FPS（左端 ~30-60px）与 图例（中部）；右侧 60px 内应无独立文字块贴边（卡顿名称贴近右缘但不应与图例相交）
    const segs = res.segments;
    console.log('  顶条带文字块:', JSON.stringify(segs), ' canvasW =', res.w);
    const legendSeg = segs.find(sg => sg[0] > res.w * 0.25 && sg[1] < res.w * 0.75);
    check('图例存在且位于中部（居中）', !!legendSeg, segs);
    const rightNameSeg = segs.find(sg => sg[1] > res.w - 70);
    // 右轴名称「卡顿」仍存在（贴右缘），但不得与图例块相交
    if (rightNameSeg) {
      check('右轴名称与图例不相交', !legendSeg || legendSeg[1] < rightNameSeg[0] - 4, { legendSeg, rightNameSeg });
    } else {
      check('右缘无文字或仅轴名称（无重叠）', true);
    }
    check('无页面 JS 错误', errs.length === 0, errs);
    await page.screenshot({ path: path.join(OUT, `fps-${width}.png`), clip: { x: 0, y: 0, width, height: 280 } });
    await page.close();
  }
  await browser.close();
  server.close();
  console.log(failed === 0 ? 'ALL PASS' : `FAILED: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
