/**
 * 低谷截图：判定算法 + 接线/模板静态检查。
 *
 * 判定口径：FPS 低于本轮 P95 目标的 80%，连续 2 拍才算低谷；两次截图冷却 10s；
 * 单轮上限 30 张；fps=null/0（无帧数据）不参与判定，并打断「连续低帧」计数。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { TroughDetector, percentile } = require(path.resolve(__dirname, '../../../_client_src/app/src/trough-detector'));

const PROJ = path.resolve(__dirname, '..', '..', '..');
const APP = path.join(PROJ, '_client_src', 'app');
const REPORTS = path.join(PROJ, 'perfara', 'collector', 'resources', 'reports');

let passed = 0, failed = 0;
const FAILED = [];
function check(name, cond, detail) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '  -> ' + JSON.stringify(detail)));
  cond ? passed++ : (failed++, FAILED.push(name));
}

function feedMany(d, fpsList, startTs, step) {
  const hits = [];
  fpsList.forEach((fps, i) => {
    const hit = d.push(fps, startTs + i * (step || 1000));
    if (hit) hits.push(hit);
  });
  return hits;
}

// ── 算法 ────────────────────────────────────────────────────────────────────
check('percentile 近秩取值', percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95) === 10, percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95));
check('percentile 空数组为 0', percentile([], 0.95) === 0, percentile([], 0.95));

{
  const d = new TroughDetector();
  const hits = feedMany(d, Array(10).fill(60), 1_000_000);
  check('稳定 60fps 不触发', hits.length === 0, hits);
}

{
  const d = new TroughDetector();
  const hits = feedMany(d, [...Array(10).fill(60), 30, 30], 1_000_000);
  check('连续 2 拍低于目标 80% 触发一次', hits.length === 1, hits);
  check('触发点 fps 正确', hits[0] && hits[0].fps === 30 && hits[0].target === 60, hits[0]);
  check('触发落在连续第 2 拍上（首拍低帧不触发）', hits[0] && hits[0].ts === 1_011_000, hits[0]);
}

{
  const d = new TroughDetector();
  const hits = feedMany(d, [...Array(10).fill(60), 20, 20, 20, 20], 1_000_000);
  check('持续低帧在冷却内只截一张', hits.length === 1, hits);
}

{
  const d = new TroughDetector();
  const hits = feedMany(d, [...Array(10).fill(60), 20, 20, ...Array(12).fill(60), 20, 20], 1_000_000);
  check('冷却结束后可再次触发', hits.length === 2, hits.map(h => h.ts));
}

{
  // 冷却放宽到 0.5s，专测单轮张数上限
  const d = new TroughDetector({ cooldownMs: 500 });
  const series = [];
  for (let k = 0; k < 40; k++) series.push(...Array(6).fill(60), 10, 10);
  const hits = feedMany(d, series, 1_000_000, 1000);
  check('单轮上限 30 张', hits.length === 30, hits.length);
}

{
  const d = new TroughDetector();
  const hits = feedMany(d, Array(10).fill(30), 1_000_000);
  check('全程 30fps 不算低谷（目标随之下移）', hits.length === 0, hits);
}

{
  const d = new TroughDetector();
  // 无帧数据（null/0）不参与判定，并打断已有的低帧计数：
  // 若是「不打断」，index 10 与 index 13 两拍就够 2 连击，触发点会落到 ts=1_013_000。
  const hits = feedMany(d, [...Array(10).fill(60), 20, null, 0, 20, 20], 1_000_000);
  check('null/0 不参与判定且打断低帧计数', hits.length === 1 && hits[0].ts === 1_014_000, hits);
}

{
  const d = new TroughDetector();
  d.push(60, 1_000_000);
  check('样本不足 minSamples 不判定', d.push(20, 1_001_000) === null && d.push(20, 1_002_000) === null, d.shots);
}

{
  const d = new TroughDetector();
  feedMany(d, [...Array(10).fill(60), 20, 20], 1_000_000);
  d.reset();
  const hits = feedMany(d, [60, 20, 20], 2_000_000);
  check('reset 后重新积累样本', hits.length === 0 && d.shots === 0, { hits, shots: d.shots });
}

// ── 接线 / 模板（防止打包漏文件或漏接线）────────────────────────────────────
const mainSrc = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
check('main 向渲染进程推送 trough-shot', /sendToRenderer\('trough-shot'/.test(mainSrc), true);
check('main 写报告时带 shots 字段', (mainSrc.match(/shots:\s*troughShots\.getShots\(/g) || []).length === 2, true);
check('main 在开始采集时重置判定', (mainSrc.match(/troughShots\.beginRun\(/g) || []).length === 2, true);
check('切换应用清空截图状态', /troughShots\.resetAll\(\)/.test(mainSrc), true);

const preloadSrc = fs.readFileSync(path.join(APP, 'preload.js'), 'utf8');
check('preload 暴露 onTroughShot', /onTroughShot/.test(preloadSrc), true);

for (const page of ['index.html', 'iphone.html', 'iphone_gpu.html']) {
  const src = fs.readFileSync(path.join(APP, 'renderer', page), 'utf8');
  check(`${page} 引入 trough-shots.js`, src.includes('<script src="trough-shots.js"></script>'), true);
  check(`${page} CSP 允许 file: 图片`, /img-src[^"]*file:/.test(src), true);
}

const perfHtml = fs.readFileSync(path.join(REPORTS, 'perf.html'), 'utf8');
check('perf.html 含低谷截图画廊脚本', perfHtml.includes('__TROUGH_SHOTS_V1__'), true);
check('perf.html 读取 data.shots', /data\.shots/.test(perfHtml), true);
check('perf.html 曲线用 markPoint 贴缩略图', /markPoint/.test(perfHtml) && /symbol:\s*'image:\/\//.test(perfHtml), true);
check('perf.html 标记优先用小图', /s\.thumbUrl\s*\|\|\s*s\.thumb/.test(perfHtml), true);

const shotsSrc = fs.readFileSync(path.join(APP, 'src', 'trough-shots.js'), 'utf8');
check('截图另存小图（曲线/缩略条用）', /THUMB_WIDTH/.test(shotsSrc) && /thumbUrl/.test(shotsSrc), true);

const chartsSrc = fs.readFileSync(path.join(APP, 'renderer', 'charts.js'), 'utf8');
check('图表管理器暴露给截图条', /window\.chartMgr\s*=\s*this/.test(chartsSrc), true);
check('图表管理器支持追加/清空截图标记', /pushTroughShot/.test(chartsSrc) && /clearTroughShots/.test(chartsSrc), true);
check('抽稀后重新投影截图锚点', /if \(trimmed\)[\s\S]{0,200}_renderTroughMarks\(\)/.test(chartsSrc), true);

const stripSrc = fs.readFileSync(path.join(APP, 'renderer', 'trough-shots.js'), 'utf8');
check('缩略图条把截图同步到曲线', /chartMgr\.pushTroughShot/.test(stripSrc), true);
check('缩略图条点击标记打开大图', /onTroughShotClick\(openOverlay\)/.test(stripSrc), true);

const adbSrc = fs.readFileSync(path.join(APP, 'src', 'adb.js'), 'utf8');
check('adb.js 导出 captureScreen', /captureScreen/.test(adbSrc), true);
check('截图走 exec-out（避免 Windows 换行破坏 PNG）', /'exec-out', 'screencap', '-p'/.test(adbSrc), true);

const iosSrc = fs.readFileSync(path.join(APP, 'src', 'ios-screen.js'), 'utf8');
check('iOS 截图调用 ios screenshot', /'screenshot'/.test(iosSrc), true);
check('iOS 截图用 --udid= 传设备（go-ios 无 -u 短选项）', /--udid=\$\{/.test(iosSrc) && !/['"]-u['"]/.test(iosSrc), true);
check('iOS 截图用 --output= 写出 PNG', /--output=\$\{out\}/.test(iosSrc), true);

console.log(`\n===== 低谷截图测试结果: ${passed} PASS / ${failed} FAIL =====`);
if (failed) {
  console.log('FAILED: ' + FAILED.join(', '));
  process.exit(1);
}
