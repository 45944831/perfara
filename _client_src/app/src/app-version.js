'use strict';

/**
 * 本地版本标识与更新源。
 *
 * 版本号规范见 ./version-scheme.js：`主版本.次版本`，次版本 0~10 后进位：
 *   1.0 → 1.1 → … → 1.10 → 2.0 → … → 2.10 → 3.0 …
 * Release tag 为 `v` + 版本号（如 `v1.10`）。
 *
 * 优先级：包外 collector/resources/version.txt > 本文件 APP_VERSION。
 * 发版不要手改版本号：首个序列版本 v1.0 直接
 *   python tools/make_release_zip.py full <源目录> <输出.zip>          （不传参，沿用 1.0）
 * 之后每次发新版追加 --app-version=next，脚本按规范递增、写 version.txt
 * 并同步本文件的 APP_VERSION；补发 / 重打某个已发布版本用 --app-version=1.3。
 *
 * 历史 Release（v2026.* / 2026xxxx）是日期式旧编号，客户端一律忽略，
 * 不会被当成「新版本」；详见 version-scheme.js 的 isLegacyVersion。
 *
 * 不用 package.json 的 version：那里常年是 1.0.0（三段式），不合新规范。
 */
module.exports = {
  // 当前版本：新编号从 1.0 起。发新版请用 --app-version=next 自动递增。
  APP_VERSION: '1.0',
  GITHUB_OWNER: '45944831',
  GITHUB_REPO: 'perfara',
};
