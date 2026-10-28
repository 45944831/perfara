#!/usr/bin/env node
/**
 * 把 favicon 资源复制进前端产物，并在 index.html 注入 <link>。
 * dist/ 是构建产物、不入库；前端一旦重建，这些改动需要重新应用，故落成脚本。
 * 幂等：重复执行不会重复插入 <link>。
 */
const fs = require('fs');
const path = require('path');

const here = __dirname;
const src = path.join(here, 'favicon');
const dist = path.join(here, 'dist');
const index = path.join(dist, 'index.html');
const files = ['favicon.ico', 'favicon-32.png', 'apple-touch-icon.png'];
const links = [
  '<link rel="icon" href="/favicon.ico" sizes="any" />',
  '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
];

if (!fs.existsSync(dist)) {
  console.error('[patch-spa-favicon] 缺少 dist/，请先构建前端');
  process.exit(1);
}

for (const f of files) {
  fs.copyFileSync(path.join(src, f), path.join(dist, f));
}

let html = fs.readFileSync(index, 'utf8');
const missing = links.filter((l) => !html.includes(l));
if (missing.length) {
  html = html.replace('</head>', `    ${missing.join('\n    ')}\n  </head>`);
  fs.writeFileSync(index, html);
}
console.log(`[patch-spa-favicon] ${files.length} 个资源，新增 ${missing.length} 条 link`);
