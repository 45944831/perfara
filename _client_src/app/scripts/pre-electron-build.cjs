'use strict';

/**
 * Windows: adb.exe under dist/resources/adb is often locked by a running adb server.
 * End those processes and remove dist so electron-builder can unpack cleanly.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

/** electron-builder 对 Windows 最稳妥：使用 build/icon.ico（见官方文档 buildResources） */
function copyWindowsIconToBuild() {
  const src = path.join(root, 'icon', 'perfara.ico');
  const buildDir = path.join(root, 'build');
  const dest = path.join(buildDir, 'icon.ico');
  if (!fs.existsSync(src)) {
    console.warn(
      '[pre-electron-build] Missing icon/perfara.ico — Windows exe may keep the default Electron icon.'
    );
    return;
  }
  fs.mkdirSync(buildDir, { recursive: true });
  fs.copyFileSync(src, dest);
}

function tryKillAdbWindows() {
  if (process.platform !== 'win32') return;
  let appExe = 'PerfAndroid.exe';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const pn = pkg.build && pkg.build.productName;
    if (pn && typeof pn === 'string') {
      appExe = pn.replace(/[<>:"/\\|?*]/g, '_').trim() + '.exe';
    }
  } catch (_) {}
  for (const cmd of [
    'taskkill /F /IM adb.exe',
    `taskkill /F /IM ${appExe}`,
    'taskkill /F /IM PerfAndroid.exe',
    'taskkill /F /IM Perfara.exe',
    'taskkill /F /IM electron.exe',
  ]) {
    try {
      execSync(cmd, { stdio: 'ignore', windowsHide: true });
    } catch (_) {
      /* no such process */
    }
  }
}

function rmDist() {
  if (!fs.existsSync(dist)) return;
  try {
    fs.rmSync(dist, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
    return;
  } catch (err) {
    console.warn('[pre-electron-build] rm dist failed, trying rename fallback:', err.message);
  }
  const fallback = path.join(root, `dist.old.${Date.now()}`);
  try {
    fs.renameSync(dist, fallback);
    console.warn('[pre-electron-build] Renamed locked dist/ to', path.basename(fallback), '— delete manually later.');
  } catch (err2) {
    console.error(
      '[pre-electron-build] Could not remove or rename dist/. Close Perfara / Explorer on dist/, stop adb, then retry.\n',
      err2.message
    );
    process.exit(1);
  }
}

tryKillAdbWindows();
copyWindowsIconToBuild();
rmDist();
