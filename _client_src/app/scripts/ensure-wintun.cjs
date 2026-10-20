/* eslint-disable no-console */
'use strict';

/**
 * Ensure wintun.dll is bundled with ios.exe.
 *
 * go-ios on Windows loads wintun.dll via the normal DLL search order.
 * Putting wintun.dll next to ios.exe (ios-tools/bin/) makes it work for:
 * - dev runs (electron .)
 * - packaged app (resources/ios-tools/bin/)
 */

const fs = require('fs');
const path = require('path');

function exists(p) {
  try { return fs.existsSync(p); } catch (_) { return false; }
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function pickWintunDllCandidate(root) {
  // Prefer 64-bit for Windows desktop builds.
  const candidates = [
    path.join(root, 'ios-tools', 'wintun', 'bin', 'amd64', 'wintun.dll'),
    path.join(root, 'ios-tools', 'wintun', 'bin', 'x86_64', 'wintun.dll'),
    path.join(root, 'ios-tools', 'wintun', 'bin', 'x64', 'wintun.dll'),
    // Fallbacks (in case folder structure differs)
    path.join(root, 'ios-tools', 'wintun', 'amd64', 'wintun.dll'),
    path.join(root, 'ios-tools', 'wintun', 'wintun.dll'),
  ];
  for (const p of candidates) if (exists(p)) return p;
  return null;
}

function main() {
  const root = path.join(__dirname, '..');
  const src = pickWintunDllCandidate(root);
  const iosExeDir = path.join(root, 'ios-tools', 'bin');
  const dst = path.join(iosExeDir, 'wintun.dll');

  if (!src) {
    console.warn('[ensure-wintun] wintun.dll not found; tunnel may fail.');
    console.warn('[ensure-wintun] Expected one of:');
    console.warn('  - ios-tools/wintun/bin/amd64/wintun.dll');
    console.warn('  - ios-tools/wintun/bin/x64/wintun.dll');
    console.warn('  - ios-tools/wintun/wintun.dll');
    return;
  }

  if (!exists(iosExeDir)) {
    console.warn(`[ensure-wintun] ios-tools/bin not found: ${iosExeDir}`);
  }

  try {
    copyFile(src, dst);
    console.log(`[ensure-wintun] Copied ${src} -> ${dst}`);
  } catch (e) {
    console.warn(`[ensure-wintun] Copy failed: ${e.message || String(e)}`);
  }

  // Optional: if a unpacked build exists, copy there too for local testing.
  const unpacked = path.join(root, 'dist', 'win-unpacked', 'resources', 'ios-tools', 'bin', 'wintun.dll');
  if (exists(path.join(root, 'dist', 'win-unpacked', 'resources', 'ios-tools', 'bin'))) {
    try {
      copyFile(dst, unpacked);
      console.log(`[ensure-wintun] Also copied into unpacked: ${unpacked}`);
    } catch (_) {}
  }
}

main();

