/**
 * 把看板 SPA 产物改成「真正 100% 本地」：剥掉 index.html 里的外链字体。
 *
 * 为什么需要一个脚本而不是一次手改（2026-10-28）：
 *   `perfara/frontend/dist/` 被 `.gitignore` 排除，仓库里也没有 Vue 源码，
 *   dist 只能靠 `patch-spa-metric-config.js` 这类**入库的后处理脚本**在打包前调整。
 *   直接改 dist/index.html 删掉那三行，下一次重新构建前端就会把它带回来 ——
 *   深度测试报告的 D3 就是这么来的：README 写着「拔掉网线功能一个都不少」，
 *   首屏却向 fonts.googleapis.com 发两个 preconnect 加一个 stylesheet。
 *
 * 删掉外链是安全的，不需要自托管字体文件：
 *   assets/index-*.css 里 `--font-sans` 的回退栈本身完整
 *   （ui-sans-serif / -apple-system / Segoe UI / Roboto / Helvetica / Arial），
 *   少了 Plus Jakarta Sans 只是换成系统无衬线，不会白屏也不会等网络。
 *
 * 用法（在仓库任意位置）：
 *   node perfara/frontend/patch-spa-offline-fonts.js          # 就地修改 dist/index.html
 *   node perfara/frontend/patch-spa-offline-fonts.js --check   # 只检查，发现外链则退出码 1
 *
 * 退出码：0 干净（或已修复）/ 1 --check 模式下仍有外链 / 2 找不到 dist/index.html
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, 'dist', 'index.html');
const CHECK = process.argv.indexOf('--check') >= 0;

// 外链字体：preconnect 到字体域 + css2 样式表。按整行/整块匹配，标签顺序变了也不漏。
const FONT_TAG = /\s*<link[^>]*?(?:rel="preconnect"[^>]*href="https?:\/\/(?:fonts\.(?:googleapis|gstatic)\.com)"|href="https?:\/\/fonts\.(?:googleapis|gstatic)\.com[^"]*"[^>]*rel="stylesheet")[^>]*\/?>/g;

function externalFontRefs(html) {
  return (html.match(/https?:\/\/fonts\.(?:googleapis|gstatic)\.com/g) || []).length;
}

function main() {
  if (!fs.existsSync(HTML)) {
    console.error('[error] 找不到 ' + HTML + '（前端产物未构建？）');
    return 2;
  }
  const before = fs.readFileSync(HTML, 'utf8');
  const n = externalFontRefs(before);
  if (n === 0) {
    console.log('[OK] dist/index.html 无外链字体引用');
    return 0;
  }
  if (CHECK) {
    console.error('[check] 发现 ' + n + ' 处外链字体引用，SPA 首屏会联网。运行本脚本（不加 --check）修复。');
    return 1;
  }
  const after = before.replace(FONT_TAG, '');
  const left = externalFontRefs(after);
  if (left > 0) {
    console.error('[error] 替换后仍有 ' + left + ' 处外链，正则没覆盖当前标签写法，请人工处理。');
    return 1;
  }
  fs.writeFileSync(HTML, after, 'utf8');
  console.log('[fixed] 已剥掉 ' + n + ' 处外链字体引用（改由 --font-sans 的系统字体栈回退）');
  // 顺手校验：head 里该有的东西不能被我删掉
  const must = ['<meta charset', '<title', 'type="module"', 'rel="stylesheet" crossorigin href="/assets/'];
  const missing = must.filter((s) => after.indexOf(s) < 0);
  if (missing.length) {
    console.error('[warn] 修复后 index.html 缺少预期片段: ' + missing.join(' , ') + '（请确认构建产物形态）');
  }
  return 0;
}

process.exitCode = main();
