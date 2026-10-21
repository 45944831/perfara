'use strict';
/** 用脱敏库重生 README 看板截图：dashboard（首页列表）+ test-detail（公开分享页）。
 *  用法: node shot_dashboard_scrubbed.js <port> <testid> <outdir>
 */
const pw = require('playwright-core');
const path = require('path');

const PORT = process.argv[2] || '8018';
const TESTID = process.argv[3] || '';
const OUT = process.argv[4] || '.';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

(async () => {
  const browser = await pw.chromium.launch({ executablePath: EDGE, args: ['--no-sandbox', '--headless=new'] });

  // 1) dashboard：首页项目/测试列表（uid 来自脱敏库的 demo-user-1）
  {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1111 } });
    await page.goto(`http://127.0.0.1:${PORT}/?uid=demo-user-1`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT, 'dashboard.png') });
    await page.close();
    console.log('shot: dashboard.png');
  }

  // 2) test-detail：公开分享页 /tests?testid=<share_md5>
  if (TESTID) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1111 } });
    await page.goto(`http://127.0.0.1:${PORT}/tests?testid=${encodeURIComponent(TESTID)}`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(OUT, 'test-detail.png') });
    await page.close();
    console.log('shot: test-detail.png');
  }

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
