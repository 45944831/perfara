'use strict';

/**
 * 从 configout/config.js 读取 appname，写入 package.json 的 build.productName，
 * 供 electron-builder 使用（安装包名、exe 名等）。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const configPath = path.join(root, 'configout', 'config.js');

let appname = 'Perfara';
try {
  const raw = fs.readFileSync(configPath, 'utf8');
  const m = raw.match(/appname["']\s*:\s*["']([^"']*)["']/);
  if (m && m[1]) appname = m[1].trim();
} catch (_) {}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.build = pkg.build || {};
pkg.build.productName = appname;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log('[sync-product-name] build.productName ->', appname);
