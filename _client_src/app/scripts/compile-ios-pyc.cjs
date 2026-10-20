'use strict';

/**
 * Compile iOS python collector scripts to same-dir .pyc files.
 * Keep behavior unchanged; JS will execute .pyc instead of .py.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const py = path.join(root, 'ios-tools', 'python', 'python', 'python.exe');
const scriptsDir = path.join(root, 'ios-tools', 'python', 'python', 'Scripts');

const targets = [
  'collect_ios.py',
  'collect_ios_legacy.py',
  'collect_ios_gpu.py',
  'gpu_counters_pre_ios17.py',
  'collect_pc_perf.py',
].map(f => ({
  py: path.join(scriptsDir, f),
  pyc: path.join(scriptsDir, `${f}c`), // e.g. collect_ios.pyc
}));

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (process.platform !== 'win32') {
  // This repo's iOS tooling is Windows-focused (WinPython, wintun).
  process.exit(0);
}
if (!fs.existsSync(py)) fail(`[compile-ios-pyc] bundled python not found: ${py}`);

for (const t of targets) {
  // In some distributions we only keep .pyc (and exclude .py) for packaging.
  // Missing sources should not break the build.
  if (!fs.existsSync(t.py)) {
    console.warn(`[compile-ios-pyc] skip (source missing): ${t.py}`);
  }
}

for (const t of targets) {
  if (!fs.existsSync(t.py)) continue;
  const code = [
    'import py_compile',
    `py_compile.compile(r"${t.py.replace(/\\/g, '\\\\')}", cfile=r"${t.pyc.replace(/\\/g, '\\\\')}", doraise=True)`,
  ].join('; ');
  const r = spawnSync(py, ['-c', code], { stdio: 'inherit', cwd: root, windowsHide: true });
  if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1);
  if (!fs.existsSync(t.pyc)) fail(`[compile-ios-pyc] expected .pyc not found: ${t.pyc}`);
}

console.log('[compile-ios-pyc] OK');

