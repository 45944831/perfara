/**
 * 验证「设备刷新率跟随设备变化，而不是固定值」。
 *
 * 背景：D-19（取错字段报 90）、D-21（60Hz 面板被 framework vote 报 120）都是
 * 「刷新率与真实设备脱钩」的缺陷。这里用真实解析函数（parsePeakRefreshRate /
 * parseMaxSupportedFps / capRefreshRateToPanel）复现 getDeviceRefreshRate 的完整
 * 取值链路，喂四台不同面板的设备 dump，证明同一套代码对不同设备给出不同刷新率。
 *
 * 另有一例真机实测：本仓测试机 supportedModes 全 60Hz、framework vote 120、
 * settings=null，产品同款包内 adb 直调 getDeviceRefreshRate 应返回 ~60（不是 120）。
 * 真机那例需要设备在线，单独用 --realdevice 运行；默认只跑离线注入用例。
 *
 * 只用 Node 原生断言，不含真机型号/序列号/真实包名（除 --realdevice 模式外）。
 */
'use strict';
const assert = require('assert');
const path = require('path');

const PROJ = path.resolve(__dirname, '..', '..');
// 真机模式必须在 require(adb.js) 之前设置资源路径：模块顶部 resolveAdb() 在加载时
// 就固定了 ADB_BIN，晚设会回退到不存在的 dev 路径、导致 getDeviceRefreshRate 返回 null。
if (process.argv.includes('--realdevice')) {
  process.resourcesPath = path.join(PROJ, 'perfara', 'collector', 'resources');
}
const ADB = require(path.join(PROJ, '_client_src', 'app', 'src', 'adb.js'));
const algo = ADB.__algo;
const { parsePeakRefreshRate, parseMaxSupportedFps, capRefreshRateToPanel } = algo;

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ' -> ' + (e && e.message || e)); }
}

/**
 * 复现 getDeviceRefreshRate 的取值顺序（纯函数版，注入设备输出）：
 *   settings peak_refresh_rate 优先 → dumpsys framework vote 兜底 → panelCap 兜底；
 *   每个来源都经 capRefreshRateToPanel 用 supportedModes 最大 fps 钳制。
 */
function refreshRateForDevice({ dump, settings }) {
  const panelCap = parseMaxSupportedFps(dump);
  let hz = null, source = null;
  const accept = (claimed, src) => {
    const capped = capRefreshRateToPanel(claimed, panelCap);
    if (capped.hz != null) {
      hz = capped.hz;
      source = capped.capped ? capped.source : src;
    }
  };
  const sv = parseFloat(String(settings == null ? '' : settings).trim());
  if (Number.isFinite(sv) && sv >= 24 && sv <= 480) accept(sv, 'settings-system');
  if (hz == null && dump) {
    const v = parsePeakRefreshRate(dump);
    if (v != null) accept(v, 'dumpsys-display');
  }
  if (hz == null && panelCap != null) { hz = panelCap; source = 'display-supported-modes'; }
  return { hz, source, panelCap };
}

/** 按面板 fps 构造 dumpsys display 片段（含一个 framework vote） */
function dumpFor(panelFps, voteHz) {
  const modes = [60, panelFps].filter((v, i, a) => a.indexOf(v) === i)
    .map((v, i) => `{id=${i + 1}, fps=${v.toFixed(6)}}`).join(', ');
  return [
    `DisplayDeviceInfo{supportedModes [${modes}]}`,
    `mDisplayModeSpecs={primaryRefreshRateRange=[0 ${voteHz}]}`,
    `PRIORITY_USER_SETTING_PEAK_REFRESH_RATE -> Vote{maxRefreshRate=${voteHz}.0, minRefreshRate=0.0}`,
    `mDefaultPeakRefreshRate: ${voteHz}.0`,
  ].join('\n');
}

console.log('\n===== 刷新率跟随设备验证（注入式，四台不同面板） =====\n');

const devices = [
  { name: '60Hz 面板 / vote 120（D-21 场景）', panel: 60, vote: 120, settings: null, expect: 60 },
  { name: '90Hz 面板 / vote 90', panel: 90, vote: 90, settings: null, expect: 90 },
  { name: '120Hz 面板 / vote 120', panel: 120, vote: 120, settings: null, expect: 120 },
  { name: '144Hz 面板 / vote 144（高刷机）', panel: 144, vote: 144, settings: null, expect: 144 },
];
const results = [];
devices.forEach((d) => {
  const r = refreshRateForDevice({ dump: dumpFor(d.panel, d.vote), settings: d.settings });
  results.push(r);
  check(d.name + ' → ' + Math.round(r.hz) + 'Hz', () => {
    assert(Math.abs(r.hz - d.expect) < 1,
      `期望 ${d.expect}Hz，实际 ${r.hz}（source=${r.source}）`);
  });
});

check('四台设备给出四个不同刷新率（证明不是固定值）', () => {
  const uniq = new Set(results.map((r) => Math.round(r.hz)));
  assert(uniq.size === 4, '不同设备应得出四个不同刷新率，实际只有 ' + [...uniq].join('/'));
});

check('60Hz 场景钳制来源标记为 display-supported-modes', () => {
  assert.strictEqual(results[0].source, 'display-supported-modes');
});
check('144Hz 面板 + settings 锁 60 → 取 60（用户设置优先）', () => {
  const r = refreshRateForDevice({ dump: dumpFor(144, 144), settings: '60' });
  assert(Math.abs(r.hz - 60) < 1 && r.source === 'settings-system', JSON.stringify(r));
});
check('无 supportedModes 时保留声明值（定制 ROM 不臆造）', () => {
  const r = refreshRateForDevice({ dump: 'mPeakRefreshRate=120.0', settings: null });
  assert.strictEqual(r.hz, 120);
});

// ── 真机实测（可选，需设备在线 + 包内 adb）────────────────────────────────
if (process.argv.includes('--realdevice')) {
  console.log('\n===== 真机实测（包内 adb） =====\n');
  const deviceId = (process.argv.find((a) => a.startsWith('--device=')) || '').split('=')[1]
    || process.env.PERFARA_TEST_SERIAL || '';
  if (!deviceId) {
    // 串号不能写死默认值（会进公开仓库）：真机模式必须显式传 --device= 或环境变量。
    console.log('  [skip] 真机模式未指定设备：请传 --device=<serial> 或设置 PERFARA_TEST_SERIAL');
    finish();
    return;
  }
  (async () => {
    const r = await ADB.getDeviceRefreshRate(deviceId);
    console.log('  真机返回:', JSON.stringify(r));
    if (r && Math.abs(r.hz - 60) < 1) { pass++; console.log('  PASS 真机跟随本机 60Hz 面板（未固定 120）'); }
    else { fail++; console.log('  FAIL 真机刷新率未跟随设备 60Hz 面板: ' + JSON.stringify(r)); }
    finish();
  })().catch((e) => { fail++; console.log('  FAIL 真机调用异常: ' + e.message); finish(); });
} else {
  finish();
}

function finish() {
  console.log(`\n===== 刷新率跟随设备验证: ${pass} PASS / ${fail} FAIL =====\n`);
  if (fail) process.exit(1);
}
