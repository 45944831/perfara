'use strict';

/**
 * 0.1「PC 采集脚本入库 + pyc 一致性」静态与算法守卫。
 *
 * 这条链路过去出过发布级阻断：collect_pc_perf.py 被 .gitignore 整目录排除，
 * 全新 clone 只剩 pyc；而且 pc-collector.js 无脑优先 pyc，改了源码不重编
 * 就会静默跑旧逻辑。现在用三道断言钉住：
 *   ① 源码不被忽略、确实在磁盘上；
 *   ② 构建链挂了统一重编；
 *   ③ 运行期按 mtime 选较新者（纯函数，注入假 exists/stat）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, '_client_src', 'app', 'ios脚本', '进程管理', 'collect_pc_perf.py');
const PYC = path.join(ROOT, 'perfara', 'collector', 'resources', 'ios-tools',
  'python', 'python', 'Scripts', 'collect_pc_perf.pyc');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ok  ' + name); }
  else { fail += 1; console.log(' FAIL ' + name + (extra ? ' | ' + extra : '')); }
}

// ── ① 源码可入库 ────────────────────────────────────────────────────────────
const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
const giLines = gi.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
const blanket = giLines.filter(s => /ios脚本\/?\s*$/.test(s) || /ios脚本\/\*\*\s*$/.test(s));
check('源码存在且非空', fs.existsSync(SRC) && fs.statSync(SRC).size > 1000,
  fs.existsSync(SRC) ? String(fs.statSync(SRC).size) + ' B' : 'missing');
check('.gitignore 不再整目录排除 ios脚本', blanket.length === 0, blanket.join(' / '));
check('.gitignore 仍排除 __pycache__', giLines.some(s => /__pycache__/.test(s)));
check('.gitignore 仍排除 *.pyc', giLines.some(s => /\*\.pyc/.test(s)));
// 只放行编译产物，不能把整个脚本目录重新挡回去
check('忽略规则里只出现缓存类条目', giLines.filter(s => /ios脚本/.test(s))
  .every(s => /__pycache__|\.pyc/.test(s)),
  giLines.filter(s => /ios脚本/.test(s)).join(' / '));
check('源码不是 pyc 指针（是真正的 Python 文本）',
  /^#!|^import |^from |^"""/m.test(fs.readFileSync(SRC, 'utf8').slice(0, 400)));

// ── ② 构建时统一重编 ────────────────────────────────────────────────────────
const compiler = path.join(ROOT, 'tools', 'compile_pc_collector.py');
const builder = fs.readFileSync(path.join(ROOT, 'tools', 'build_app.py'), 'utf8');
const compilerText = fs.existsSync(compiler) ? fs.readFileSync(compiler, 'utf8') : '';
check('编译脚本存在', fs.existsSync(compiler));
check('编译脚本的源指向 collect_pc_perf.py', /collect_pc_perf\.py/.test(compilerText));
check('编译脚本用 py_compile 且指定 dfile', /py_compile\.compile/.test(compilerText)
  && /dfile=/.test(compilerText));
check('build_app.py 定义了 sync_pc_bytecode', /def sync_pc_bytecode\(/.test(builder));
check('build_app.py 在 collect() 前调用重编',
  builder.indexOf('sync_pc_bytecode()') > 0
  && builder.indexOf('sync_pc_bytecode()') < builder.indexOf('kept, dropped = collect()'));
check('重编失败不中断打包（try/except 兜底）',
  /sync_pc_bytecode[\s\S]{0,800}except Exception/.test(builder));

// ── ③ 运行期按 mtime 选较新者 ─────────────────────────────────────────────
const PC = require(path.join(ROOT, '_client_src', 'app', 'src', 'pc-collector.js'));
const pick = PC.pickNewerScript;
check('pickNewerScript 已导出', typeof pick === 'function');
const py = '/x/collect_pc_perf.py', pyc = '/x/collect_pc_perf.pyc';
const exists = (o) => (p) => p in o;
const stat = (o) => (p) => ({ mtimeMs: o[p] });

check('两者都无 → missing', pick({ py, pyc }, () => false, () => ({ mtimeMs: 0 })).reason === 'missing');
check('只有 .py → 用源码', pick({ py, pyc }, exists({ [py]: 1 }), stat({ [py]: 1 })).path === py);
check('只有 .pyc → 用字节码', pick({ py, pyc }, exists({ [pyc]: 1 }), stat({ [pyc]: 1 })).path === pyc);
check('pyc 更新 → 用 pyc、不认为过期',
  pick({ py, pyc }, exists({ [py]: 1, [pyc]: 1 }), stat({ [py]: 1000, [pyc]: 5000 })).reason === 'pyc-current');
check('.py 明显更新 → 回退源码并标 stale', (() => {
  const r = pick({ py, pyc }, exists({ [py]: 1, [pyc]: 1 }), stat({ [py]: 9000, [pyc]: 5000 }));
  return r.path === py && r.stale === true;
})());
check('1s 内容差视为同一次构建，不误报过期',
  pick({ py, pyc }, exists({ [py]: 1, [pyc]: 1 }), stat({ [py]: 5800, [pyc]: 5000 })).stale === false);
check('stat 抛错时不崩，保守用 pyc', (() => {
  try {
    return pick({ py, pyc }, exists({ [py]: 1, [pyc]: 1 }),
      () => { throw new Error('EACCES'); }).path === pyc;
  } catch (_) { return false; }
})());

const pcSrc = fs.readFileSync(path.join(ROOT, '_client_src', 'app', 'src', 'pc-collector.js'), 'utf8');
check('start() 真的改用 resolvePcScript', /const resolved = resolvePcScript\(\)/.test(pcSrc));
check('stale 时有可见提示（不是静默回退）', /resolved\.stale[\s\S]{0,300}统一重编/.test(pcSrc));

// pyc 头记录的源大小与源码一致 —— 证明当前 pyc 确实由这份 .py 编译而来
if (fs.existsSync(PYC)) {
  const head = fs.readFileSync(PYC).subarray(0, 16);
  const srcSize = head.readUInt32LE(12);
  const realSize = fs.statSync(SRC).size;
  check('pyc 头记录的源大小与本仓库源码一致', srcSize === realSize,
    `pyc=${srcSize} src=${realSize}`);
}

// pyc 的 magic 必须与「运行期内置解释器」一致。
//
// 这条断言来自一次真实阻断：pyc 用 Python 3.12 编译（magic 6f0d0d0a），
// 而内置解释器已升到 3.13（f30d0d0a）。Scripts 目录下只有 pyc、没有 .py 兜底，
// pickNewerScript 按 mtime 判定 pyc 为 current，于是运行期直接
// `RuntimeError: Bad magic number in .pyc file` —— PC 采集一个数都采不到。
// 上面「源大小一致」只能证明 pyc 由这份源码编译，证明不了它能被加载，
// 所以必须单独校验 magic。
const PYEXE = path.join(ROOT, 'perfara', 'collector', 'resources', 'ios-tools',
  'python', 'python', 'python.exe');
if (fs.existsSync(PYC) && fs.existsSync(PYEXE)) {
  const { spawnSync } = require('child_process');
  const r = spawnSync(PYEXE,
    ['-c', 'import importlib.util;print(importlib.util.MAGIC_NUMBER.hex())'],
    { encoding: 'utf8', timeout: 15000 });
  const want = String(r.stdout || '').trim().toLowerCase();
  const got = fs.readFileSync(PYC).subarray(0, 4).toString('hex').toLowerCase();
  check('pyc magic 与内置解释器一致（不一致会在运行期 Bad magic number）',
    !!want && want === got, `pyc=${got} interp=${want || 'n/a'}`);
}

console.log(`\n===== PC 采集源码/字节码守卫测试结果: ${pass} PASS / ${fail} FAIL =====`);
process.exit(fail ? 1 : 0);
