/**
 * 方案 1.6「报告口径版本 schemaVersion」三处缺口的离线回归测试。
 *
 *  A. perf2.html：温度口径对齐 + 口径版本提示（静态接线 + 温度口径关键字）
 *  B. library.html：对比视图默认禁用 / 「仍要对比」解除（静态守卫 + 极简 DOM 真跑）
 *  C. tools/inject_metric_info.py：新版幂等 / 旧版不伪造版本 / 注入后数值不变
 *
 * 只用 Node 原生断言与内置模块，不依赖浏览器。测试数据均为离线 fixture，
 * 不含真机型号、设备序列号与真实应用包名。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { spawnSync } = require('child_process');

const PROJ = path.resolve(__dirname, '..', '..', '..');
const REPORTS = path.join(PROJ, 'perfara', 'collector', 'resources', 'reports');
const PERF2 = fs.readFileSync(path.join(REPORTS, 'perf2.html'), 'utf8');
const LIB = fs.readFileSync(path.join(REPORTS, 'library.html'), 'utf8');
const TOOLS = path.join(PROJ, 'tools').replace(/\\/g, '/');
const INJECT = path.join(PROJ, 'tools', 'inject_metric_info.py').replace(/\\/g, '/');
const PY = 'E:/WorkBuddy1/2026-10-19-13-59-27/tools/.venv/Scripts/python.exe';
const PY_ENV = Object.assign({}, process.env, {
  PYTHONIOENCODING: 'utf-8',
  PYTHONDONTWRITEBYTECODE: '1',
});

let passed = 0, failed = 0;
const FAILED = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS ' + name);
  } catch (e) {
    failed++;
    FAILED.push(name);
    console.log('  FAIL ' + name + '  -> ' + (e && e.message ? e.message : String(e)));
  }
}

/** 按大括号配对抠出指定函数源码（与同目录其它 deep 测试同一手法） */
function extractFn(src, name) {
  const needle = 'function ' + name + '(';
  const i = src.indexOf(needle);
  if (i < 0) throw new Error('未找到函数：' + name);
  let depth = 0, started = false, j = i;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) { j++; break; } }
  }
  return src.slice(i, j);
}

// ══════════════════════════════════════════════════════════════════════════
// A. perf2.html
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] perf2.html 温度口径对齐 + 口径版本提示');

check('A01 接入 schemaVersion：读取 data.schemaVersion', () => {
  assert(/data\.schemaVersion/.test(PERF2));
});
check('A02 当前口径版本常量为 2', () => {
  assert(PERF2.includes("var CUR = '2'"));
});
check('A03 提示文案含「跨版本不可直接对比」', () => {
  assert(PERF2.includes('跨版本不可直接对比'));
});
check('A04 使用与 perf.html 同款 data-notice 提示条', () => {
  assert(PERF2.includes("el.id = 'data-notice'"));
  assert(PERF2.includes("el.setAttribute('role', 'note')"));
  assert(PERF2.includes('position:sticky;top:0;z-index:9999'));
});
check('A05 提示条插到 body 最前', () => {
  assert(PERF2.includes('document.body.insertBefore(el, document.body.firstChild)'));
});
check('A06 旧报告不报错不白屏：typeof data 守卫', () => {
  assert(PERF2.includes("if (typeof data === 'undefined' || !data) return;"));
});
check('A07 旧报告不报错不白屏：整段 try/catch 兜底', () => {
  assert(/catch \(_\) \{\}/.test(PERF2));
});
check('A08 无版本分支给出提示', () => {
  assert(PERF2.includes('本报告由旧版本生成（无口径版本），跨版本不可直接对比。'));
});
check('A09 版本≠当前分支给出提示', () => {
  assert(PERF2.includes('指标定义或单位已变化，跨版本不可直接对比。'));
});
check('A10 提示条为独立 script，位于主逻辑之后', () => {
  assert(PERF2.indexOf("el.id = 'data-notice'") > PERF2.indexOf('})();'));
});
check('A11 温度回退对齐 perf.html：新增 pickTemp', () => {
  assert(PERF2.includes('function pickTemp(thermalRaw, batteryRaw)'));
});
check('A12 温度归一：新增 a_temp（十分度整数换算 °C）', () => {
  const fn = extractFn(PERF2, 'a_temp');
  assert(fn.includes('v / 10'));
  assert(fn.includes('return null'));
});
check('A13 temperature 序列改用 pickTemp 回退', () => {
  assert(PERF2.includes("series['temperature'].push(pickTemp(it.temperature, battery.temperature));"));
});
check('A14 旧回退口径已移除', () => {
  assert(!PERF2.includes('it.temperature != null ? it.temperature : battery.temperature'));
});
check('A15 CONFIG.android.temp 不再把电池温度当独立序列', () => {
  assert(/"temp":\["temperature"\]/.test(PERF2));
  assert(!/"temp":\["temperature","battery.temperature"\]/.test(PERF2));
});
check('A16 空值写 null、不补 0', () => {
  const fn = extractFn(PERF2, 'pickTemp');
  assert(fn.includes('t > 0'));
  assert(fn.includes('b > 0'));
  assert(fn.includes('return null;'));
  assert(!/return\s+0\s*;/.test(fn), '不得补 0');
  const returns = fn.match(/return[^;]*;/g) || [];
  assert(returns.length >= 3);
  assert(/return null;/.test(returns[returns.length - 1]), '取不到时最后必须返回 null');
});
check('A17 temperature 序列只写一次（未叠加注入）', () => {
  assert.strictEqual((PERF2.match(/series\['temperature'\]\.push\(/g) || []).length, 1);
});
check('A18 图表与统计数值逻辑保持原样', () => {
  ['buildSeries', 'buildStatsRows', 'statsForPointsInRange', 'avg', 'p98', 'vmax', 'renderCharts', 'renderStats']
    .forEach((n) => assert(PERF2.includes('function ' + n + '('), '缺少 ' + n));
});
check('A19 主解析仍带 try/catch 错误兜底（不白屏）', () => {
  assert(PERF2.includes("errBox.textContent = '解析失败: '"));
});

// ══════════════════════════════════════════════════════════════════════════
// B. library.html 静态守卫
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[B] library.html 对比视图默认禁用（静态守卫）');

check('B01 新增纯函数 compareSchemaRisk', () => {
  assert(LIB.includes('function compareSchemaRisk('));
});
check('B02 新增版本指纹 compareSchemaKey / isCompareOverridden', () => {
  assert(LIB.includes('function compareSchemaKey('));
  assert(LIB.includes('function isCompareOverridden('));
});
check('B03 保留 renderCompareNotice 幂等：先移除旧元素', () => {
  assert(LIB.includes('if (old) old.remove();'));
  assert(LIB.includes("document.getElementById('cmp-schema-notice')"));
});
check('B04 无版本 / 版本不一致时默认禁用导出', () => {
  assert(LIB.includes('if (saveBtn) saveBtn.disabled = true;'));
});
check('B05 禁用时给出说明文字', () => {
  assert(LIB.includes('已默认禁用「保存对比报告」'));
});
check('B06 提供「仍要对比」显式解除按钮', () => {
  assert(LIB.includes('仍要对比'));
  assert(LIB.includes("btn.id = 'cmp-force-compare'"));
});
check('B07 点击解除后才放行 saveBtn', () => {
  assert(LIB.includes('if (saveBtn) saveBtn.disabled = false;'));
});
check('B08 runCompare 按 gate 结果决定是否放行', () => {
  assert(LIB.includes('saveBtn.disabled = !!(gate && gate.blocked && !gate.overridden);'));
});
check('B09 renderCompareNotice 返回 gate 状态', () => {
  assert(LIB.includes('return { blocked: risk.blocked, overridden: risk.blocked && overridden };'));
});
check('B10 解除状态按版本指纹绑定，收起对比时重置', () => {
  assert(LIB.includes('cmpOverrideKey = null;'));
  assert(LIB.includes('cmpOverrideKey === compareSchemaKey(payloads)'));
});
check('B11 解除后给出「仅供参考」说明', () => {
  assert(LIB.includes('已显式允许跨版本对比（结果仅供参考）'));
});
check('B12 版本一致时不禁用：守卫函数只按无版本/多版本判定', () => {
  const fn = extractFn(LIB, 'compareSchemaRisk');
  assert(fn.includes('unversioned > 0 || versions.length > 1'));
});

// ─── B. 极简 DOM 替身真跑 renderCompareNotice ───────────────────────────────
function makeDom() {
  const nodes = Object.create(null);
  function makeEl(id) {
    return {
      id: id || '', style: { cssText: '' }, children: [], textContent: '',
      innerHTML: '', disabled: false, type: '', onclick: null, firstChild: null,
      attrs: Object.create(null), removed: false, _parent: null,
      setAttribute: function (k, v) { this.attrs[k] = v; },
      appendChild: function (c) {
        c._parent = this; this.children.push(c);
        if (c.id) nodes[c.id] = c;
        this.textContent = this.children.map((x) => x.textContent).join('');
        return c;
      },
      insertBefore: function (c) {
        c._parent = this; this.children.unshift(c);
        if (c.id) nodes[c.id] = c;
        this.textContent = this.children.map((x) => x.textContent).join('');
        return c;
      },
      remove: function () {
        if (this._parent) {
          this._parent.children = this._parent.children.filter((x) => x !== this);
          this._parent.textContent = this._parent.children.map((x) => x.textContent).join('');
        }
        if (this.id && nodes[this.id] === this) delete nodes[this.id];
        this.removed = true;
      },
      classList: { remove() {}, add() {}, contains() { return false; } },
    };
  }
  const compare = makeEl('compare');
  const saveBtn = makeEl('btn-export-compare');
  nodes['compare'] = compare;
  nodes['btn-export-compare'] = saveBtn;
  const document = {
    getElementById: (id) => nodes[id] || null,
    createElement: () => makeEl(''),
  };
  const ctx = { document, $: (id) => document.getElementById(id), console };
  vm.createContext(ctx);
  const s = LIB.indexOf('function compareSchemaRisk(');
  const e = LIB.indexOf('function renderCompareInsight(');
  assert(s > 0 && e > s, '守卫函数片段可提取');
  vm.runInContext(LIB.slice(s, e), ctx);
  return { ctx, document, nodes, compare, saveBtn };
}
function runNotice(dom, payloads) {
  const gate = dom.ctx.renderCompareNotice(payloads);
  dom.saveBtn.disabled = !!(gate && gate.blocked && !gate.overridden);
  return gate;
}
const notices = (dom) => dom.compare.children.filter((c) => c.id === 'cmp-schema-notice');

console.log('\n[B] library.html 对比视图默认禁用（极简 DOM 真跑）');

check('B13 版本一致且=2：不插警示条、不禁用（行为不变）', () => {
  const dom = makeDom();
  const gate = runNotice(dom, [{ schemaVersion: '2' }, { schemaVersion: '2' }]);
  assert.strictEqual(gate.blocked, false);
  assert.strictEqual(dom.saveBtn.disabled, false);
  assert.strictEqual(notices(dom).length, 0);
});
check('B14 版本一致但非当前版本：只警示、不禁用（行为不变）', () => {
  const dom = makeDom();
  const gate = runNotice(dom, [{ schemaVersion: '1' }, { schemaVersion: '1' }]);
  assert.strictEqual(gate.blocked, false);
  assert.strictEqual(dom.saveBtn.disabled, false);
  assert.strictEqual(notices(dom).length, 1);
  assert(notices(dom)[0].textContent.includes('请谨慎解读'));
});
check('B15 版本不一致：默认禁用并给出不一致说明', () => {
  const dom = makeDom();
  const gate = runNotice(dom, [{ schemaVersion: '1' }, { schemaVersion: '2' }]);
  assert.strictEqual(gate.blocked, true);
  assert.strictEqual(dom.saveBtn.disabled, true);
  assert(notices(dom)[0].textContent.includes('不一致'));
});
check('B16 全部无版本：默认禁用并说明旧报告', () => {
  const dom = makeDom();
  const gate = runNotice(dom, [{}, {}]);
  assert.strictEqual(gate.blocked, true);
  assert.strictEqual(dom.saveBtn.disabled, true);
  assert(notices(dom)[0].textContent.includes('旧版本'));
});
check('B17 混合无版本+有版本：默认禁用', () => {
  const dom = makeDom();
  assert.strictEqual(runNotice(dom, [{}, { schemaVersion: '2' }]).blocked, true);
  assert.strictEqual(dom.saveBtn.disabled, true);
});
check('B18 幂等：重复调用不叠加 notice 元素', () => {
  const dom = makeDom();
  const payloads = [{ schemaVersion: '1' }, { schemaVersion: '2' }];
  runNotice(dom, payloads);
  runNotice(dom, payloads);
  runNotice(dom, payloads);
  assert.strictEqual(notices(dom).length, 1);
  assert.strictEqual(dom.saveBtn.disabled, true);
});
check('B19 「仍要对比」按钮存在且点击后解除禁用', () => {
  const dom = makeDom();
  runNotice(dom, [{}, { schemaVersion: '2' }]);
  const btn = dom.document.getElementById('cmp-force-compare');
  assert(btn && typeof btn.onclick === 'function');
  assert.strictEqual(btn.textContent, '仍要对比');
  btn.onclick();
  assert.strictEqual(dom.saveBtn.disabled, false);
  assert.strictEqual(btn.disabled, true);
});
check('B20 解除后重复渲染：overridden 生效且不再禁用', () => {
  const dom = makeDom();
  const payloads = [{}, { schemaVersion: '2' }];
  runNotice(dom, payloads);
  dom.document.getElementById('cmp-force-compare').onclick();
  const gate = runNotice(dom, payloads);
  assert.strictEqual(gate.overridden, true);
  assert.strictEqual(dom.saveBtn.disabled, false);
  assert.strictEqual(notices(dom).length, 1);
  assert(notices(dom)[0].textContent.includes('已显式允许'));
});
check('B21 换一组版本后解除失效、重新默认禁用', () => {
  const dom = makeDom();
  runNotice(dom, [{}, { schemaVersion: '2' }]);
  dom.document.getElementById('cmp-force-compare').onclick();
  const gate = runNotice(dom, [{ schemaVersion: '1' }, { schemaVersion: '2' }]);
  assert.strictEqual(gate.overridden, false);
  assert.strictEqual(gate.blocked, true);
  assert.strictEqual(dom.saveBtn.disabled, true);
});

// ══════════════════════════════════════════════════════════════════════════
// C. tools/inject_metric_info.py 纯函数
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[C] inject_metric_info.py 接线（Python 纯函数）');

const OLD = {
  device: { category: 'android' },
  perf: [{ timestamp: 1, fps: 58, temperature: 36, jank: 0 }],
  meta: { source: 'offline-fixture' },
};
const NEW = Object.assign({}, OLD, {
  schemaVersion: '2',
  metricDefinitions: [{ key: 'fps', label: 'FPS', unit: 'FPS', group: 'fps', scope: 'app' }],
  provenance: { schemaVersion: '2', metrics: {} },
});

function runPy(input, isDataJs) {
  const r = spawnSync(PY, [INJECT, '--payload'], {
    input: isDataJs ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: PY_ENV,
  });
  assert.strictEqual(r.status, 0, 'python 退出码 ' + r.status + ' / ' + r.stderr);
  assert(r.stdout && r.stdout.trim(), 'python 无 stdout 输出：' + r.stderr);
  return { out: JSON.parse(r.stdout), stderr: r.stderr || '' };
}

check('C01 新版 payload：幂等不重复注入（changed=false）', () => {
  const r = runPy(NEW);
  assert.strictEqual(r.out.status, 'already_current');
  assert.strictEqual(r.out.changed, false);
});
check('C02 新版 payload：返回结果与输入深度一致', () => {
  const r = runPy(NEW);
  assert.deepStrictEqual(r.out.payload, NEW);
});
check('C03 新版 payload：日志明确说明幂等跳过', () => {
  const r = runPy(NEW);
  assert(r.stderr.includes('幂等'));
  assert(r.out.logs.join('').includes('不重复注入'));
});
check('C04 新版 payload：重复调用仍不改动', () => {
  const a = runPy(NEW), b = runPy(NEW);
  assert.deepStrictEqual(a.out.payload, b.out.payload);
  assert.strictEqual(b.out.changed, false);
});
check('C05 旧版 payload：补定义且 changed=true', () => {
  const r = runPy(OLD);
  assert.strictEqual(r.out.status, 'legacy_injected');
  assert.strictEqual(r.out.changed, true);
});
check('C06 旧版 payload：不伪造 schemaVersion', () => {
  const r = runPy(OLD);
  assert(!('schemaVersion' in r.out.payload));
  assert(r.out.logs.join('').includes('未伪造 schemaVersion'));
});
check('C07 旧版 payload：注入后原有数值逐项不变', () => {
  const r = runPy(OLD);
  const p = JSON.parse(JSON.stringify(r.out.payload));
  delete p.metricDefinitions;
  assert.deepStrictEqual(p, OLD);
  assert.strictEqual(r.out.payload.perf[0].temperature, 36);
  assert.strictEqual(r.out.payload.perf[0].fps, 58);
});
check('C08 旧版 payload：metricDefinitions 结构完整', () => {
  const r = runPy(OLD);
  const defs = r.out.payload.metricDefinitions;
  assert(Array.isArray(defs) && defs.length > 0);
  defs.forEach((d) => ['key', 'label', 'unit', 'group', 'scope']
    .forEach((k) => assert(k in d, '缺字段 ' + k)));
});
check('C09 旧版 payload：返回值明确「旧报告不可直接跨版本对比」', () => {
  const r = runPy(OLD);
  assert(r.out.notice.includes('旧报告不可直接跨版本对比'));
  assert(r.out.logs.join('').includes('旧报告不可直接跨版本对比'));
});
check('C10 旧版 payload：stderr 打印明确日志', () => {
  const r = runPy(OLD);
  assert(r.stderr.includes('缺 schemaVersion'));
  assert(r.stderr.includes('旧报告不可直接跨版本对比'));
});
check('C11 有版本但缺定义：只补定义、版本与数值不动', () => {
  const half = Object.assign({}, OLD, { schemaVersion: '1' });
  const r = runPy(half);
  assert.strictEqual(r.out.status, 'definitions_injected');
  assert.strictEqual(r.out.payload.schemaVersion, '1');
  assert.deepStrictEqual(r.out.payload.perf, OLD.perf);
  assert(Array.isArray(r.out.payload.metricDefinitions));
});
check('C12 非 dict 输入：安全跳过不崩溃', () => {
  const r = runPy([1, 2, 3]);
  assert.strictEqual(r.out.status, 'invalid');
  assert.strictEqual(r.out.changed, false);
});
check('C13 data.js 旧版：文本注入定义、不伪造版本、数值不变', () => {
  const js = 'var data = ' + JSON.stringify(OLD) + ';\n';
  const r = runPy(js, true);
  assert.strictEqual(r.out.format, 'data.js');
  assert.strictEqual(r.out.status, 'legacy_injected');
  assert(r.out.dataJs.includes('metricDefinitions'));
  assert(!r.out.dataJs.includes('"schemaVersion"'));
  const reparsed = JSON.parse(r.out.dataJs.replace(/^var data = /, '').replace(/;\s*$/, ''));
  assert.deepStrictEqual(reparsed.perf, OLD.perf);
});
check('C14 data.js 新版：幂等，文本原样返回', () => {
  const js = 'var data = ' + JSON.stringify(NEW) + ';\n';
  const r = runPy(js, true);
  assert.strictEqual(r.out.status, 'already_current');
  assert.strictEqual(r.out.changed, false);
  assert.strictEqual(r.out.dataJs, js);
});
check('C15 data.js 格式非法：原样返回不破坏报告', () => {
  const bad = 'var data = not-json;\n';
  const r = runPy(bad, true);
  assert.strictEqual(r.out.status, 'invalid');
  assert.strictEqual(r.out.dataJs, bad);
});
check('C16 纯函数可直接 import 且不修改入参', () => {
  const code = 'import sys,json; sys.path.insert(0, ' + JSON.stringify(TOOLS) + '); '
    + 'import inject_metric_info as m; '
    + 'p={"perf":[{"fps":58}]}; '
    + 'r=m.inject_into_payload(p); '
    + 'print(json.dumps({"pure":"metricDefinitions" not in p and "schemaVersion" not in p,'
    + '"status":r["status"],"defs":len(r["payload"]["metricDefinitions"])}))';
  const r = spawnSync(PY, ['-c', code], { encoding: 'utf8', env: PY_ENV });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.pure, true);
  assert.strictEqual(out.status, 'legacy_injected');
  assert(out.defs > 0);
});

console.log('\n==== schema_version_test: ' + passed + ' PASS / ' + failed + ' FAIL ====');
if (failed) {
  console.log('FAILED: ' + FAILED.join(' | '));
  process.exit(1);
}
