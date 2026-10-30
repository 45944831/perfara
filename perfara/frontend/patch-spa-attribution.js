#!/usr/bin/env node
/**
 * 在 SPA 主界面顶部注入一行「基于原项目二次开发」的小字。
 *
 * dist/ 不入库、仓库里也没有 Vue 源码，直接改 dist/index.html 会在下次重建前端时丢失，
 * 所以落成这个幂等的后处理脚本，打包前执行一次即可。
 *
 * 用法：
 *   node perfara/frontend/patch-spa-attribution.js          # 就地注入（幂等）
 *   node perfara/frontend/patch-spa-attribution.js --check  # 只检查，缺失时退出码 1
 *
 * 退出码：0 已存在/注入成功；1 --check 时缺失；2 找不到 dist/index.html
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, 'dist', 'index.html');
const MARK = 'id="perfara-attribution"';
const BLOCK = [
  '<div id="perfara-attribution" role="note">本项目基于 ',
  '<a href="https://github.com/charmingLitteDeveloper/perfara" target="_blank" rel="noopener noreferrer"',
  ' title="在新窗口打开原项目">https://github.com/charmingLitteDeveloper/perfara</a> 二次开发，感谢开源</div>',
  '<style>',
  '#perfara-attribution{position:fixed;top:2px;left:16px;z-index:60;',
  'font:10.5px/1.35 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
  'color:rgba(148,163,184,.5);white-space:nowrap;letter-spacing:.2px;pointer-events:auto}',
  '#perfara-attribution a{color:inherit;text-decoration:none;',
  'border-bottom:1px dotted rgba(148,163,184,.32)}',
  '#perfara-attribution a:hover{color:rgba(203,213,225,.85);border-bottom-color:currentColor}',
  '@media (max-width:760px){#perfara-attribution{font-size:9.5px;left:8px;right:8px;',
  'white-space:normal}}',
  // 窄屏下小字会折成两行，压到导航栏，给 header 让出顶部空间
  '@media (max-width:480px){#perfara-attribution{top:4px;font-size:9px;line-height:1.25}',
  '.header{padding-top:34px!important}}',
  '</style>',
].join('');

if (!fs.existsSync(HTML)) {
  console.error('[patch-spa-attribution] 缺少 dist/index.html，请先构建前端');
  process.exit(2);
}

let html = fs.readFileSync(HTML, 'utf8');
const present = html.includes(MARK);

if (process.argv.includes('--check')) {
  if (present) {
    console.log('[OK] dist/index.html 已包含开源署名');
    process.exit(0);
  }
  console.error('[MISS] dist/index.html 缺少开源署名，请运行 node perfara/frontend/patch-spa-attribution.js');
  process.exit(1);
}

const start = html.indexOf('<div id="perfara-attribution"');
if (start >= 0) {
  const styleEnd = html.indexOf('</style>', start);
  const end = styleEnd >= 0 ? styleEnd + '</style>'.length : -1;
  if (end > 0 && html.slice(start, end) !== BLOCK) {
    html = html.slice(0, start) + BLOCK + html.slice(end);
    fs.writeFileSync(HTML, html);
    console.log('[patch-spa-attribution] 已更新为最新样式');
    process.exit(0);
  }
  console.log('[patch-spa-attribution] 已存在且为最新，未改动');
  process.exit(0);
}

if (!html.includes('</body>')) {
  console.error('[patch-spa-attribution] index.html 缺少 </body>，未注入');
  process.exit(2);
}

html = html.replace('</body>', `    ${BLOCK}\n  </body>`);
fs.writeFileSync(HTML, html);
console.log('[patch-spa-attribution] 已注入顶部署名');
