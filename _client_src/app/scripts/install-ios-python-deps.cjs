'use strict';

/**
 * Install py-ios-device dependencies into bundled WinPython (ios-tools/python).
 * 由 npm run build 的 prebuild 自动执行；也可单独运行: npm run install-ios-python
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');

if (process.platform !== 'win32') {
  console.log('[install-ios-python-deps] skip (WinPython / pip 仅 Windows 打包环境需要)');
  process.exit(0);
}

const py = path.join(root, 'ios-tools', 'python', 'python', 'python.exe');
const req = path.join(
  root,
  'ios-tools',
  'python',
  'python',
  'Scripts',
  'psets',
  'pdm',
  'requirements.txt'
);

if (!fs.existsSync(py)) {
  console.error('Bundled Python not found:', py);
  process.exit(1);
}
if (!fs.existsSync(req)) {
  console.error('requirements.txt not found:', req);
  process.exit(1);
}

let r = spawnSync(py, ['-m', 'pip', 'install', '-r', req], {
  stdio: 'inherit',
  cwd: root,
});
if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1);

const pcReq = path.join(
  root,
  'ios-tools',
  'python',
  'python',
  'Scripts',
  'requirements-pc.txt',
);
if (fs.existsSync(pcReq)) {
  r = spawnSync(py, ['-m', 'pip', 'install', '-r', pcReq], {
    stdio: 'inherit',
    cwd: root,
  });
  process.exit(r.status ?? 1);
}
process.exit(0);
