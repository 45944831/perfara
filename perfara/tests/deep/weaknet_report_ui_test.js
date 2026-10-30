/**
 * 弱网总结分析（报告页）：用合成 data.weaknet 渲染 perf.html，核对区块位置与数值。
 *
 * 数据安排（1 Hz，240 点）：
 *   0–79   直连 60 fps / 0 卡顿 / 120 KB/s / 进程 CPU 20%
 *   80–159 弱网 42 fps / 每拍 1 次卡顿 / 30 KB/s / 进程 CPU 30%（段 start=ts[80], end=ts[160]）
 *   160–239 直连 60 fps / 0 卡顿 / 120 KB/s / 进程 CPU 20%
 * 期望：弱网 80s / 全程 239s（33%），平均帧率 −30%，卡顿 60 次/10min，达帧率 70%。
 *
 * 需要 NODE_PATH 指向 workspace/node_modules（run_deep_batch.sh 已设置）。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const pw = require('playwright-core');

const PROJ = path.resolve(__dirname, '..', '..', '..');
const REPORTS = path.join(PROJ, 'perfara', 'collector', 'resources', 'reports');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SHOTS_OUT = path.join(PROJ, 'release', '_audit', 'weaknet-report');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-weaknet-'));

let passed = 0, failed = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; FAILS.push(name); console.log('  FAIL  ' + name + '  -> ' + JSON.stringify(detail)); }
}

/** 与 main.js 相同的数据注入：把外部 data.js 加载替换成内联 data */
function injectData(html, payload) {
  const mark = '<!-- external: 全局 data';
  const mi = html.indexOf(mark);
  const tagStart = html.indexOf('<script>', mi);
  const tagEnd = html.indexOf('</script>', tagStart);
  const json = JSON.stringify(payload).replace(/<\//g, '<\\/');
  return html.slice(0, tagStart) + '<script>var data = ' + json + ';</script>' + html.slice(tagEnd + '</script>'.length);
}

const T0 = new Date(2026, 9, 29, 9, 0, 0).getTime();

function sample(i, fps, jank, rx, cpu) {
  return {
    timestamp: T0 + i * 1000,
    time: new Date(T0 + i * 1000).toTimeString().slice(0, 8),
    pid: 4242,
    cpu: { sysCpu: 18, procCpu: cpu },
    cpuCores: { usage: [20, 20, 20, 20], freq: [1400, 1400, 1400, 1400] },
    mem: { totalPss: 300, nativeHeap: 40, javaHeap: 20, dalvikHeap: 20, code: 60, stack: 1, graphics: 20, privateOther: 60, system: 80, memTotalMB: 7936, memAvailableMB: 3600 },
    fps, jank, bigJank: 0, smallJank: jank, tinyJank: 0,
    net: { rxKBps: rx, txKBps: 8 },
    battery: { level: 90, currentNow: 400, power: 2000 },
    temperature: 38,
  };
}

const PROFILE = {
  name: '3G 慢速',
  latency_down_ms: 400,
  latency_up_ms: 400,
  jitter_ms: 0,
  down_kbps: 400,
  up_kbps: 400,
  loss_pct: 0,
  stall_ms: 0,
  disconnect_pct: 0,
  timeout_pct: 0,
  dns_fail_pct: 0,
  reject_pct: 0,
  flap_sec: 0,
  flap_blackout_sec: 0,
};

function basePayload(weaknet) {
  const perf = [];
  for (let i = 0; i < 240; i += 1) {
    const weak = i >= 80 && i < 160;
    perf.push(sample(i, weak ? 42 : 60, weak ? 1 : 0, weak ? 30 : 120, weak ? 30 : 20));
  }
  const payload = {
    device: { category: 'android', name: '验证机', bundleId: 'com.demo.sample', appName: 'com.demo.sample', deviceId: '', udid: '' },
    perf,
    tag: [],
    metricConfig: null,
    shots: [],
  };
  if (weaknet) payload.weaknet = weaknet;
  return payload;
}

function seg(over) {
  return Object.assign({
    start: T0 + 80 * 1000,
    end: T0 + 160 * 1000,
    source: 'pc',
    key: 'custom_3g',
    name: '3G 慢速',
    scope: 'all',
    scopeCount: 0,
    profile: PROFILE,
    downBytes: 12 * 1024 * 1024,
    upBytes: 512 * 1024,
  }, over || {});
}

const WEAKNET = {
  ctrlPort: 8899,
  pollMs: 2000,
  reachable: true,
  segments: [seg()],
};

function clockOf(ms) {
  const d = new Date(ms);
  const p = (v) => String(v).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function main() {
  const html = fs.readFileSync(path.join(REPORTS, 'perf.html'), 'utf-8');
  fs.copyFileSync(path.join(REPORTS, 'echarts.min.js'), path.join(OUT, 'echarts.min.js'));
  const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/');
  fs.mkdirSync(SHOTS_OUT, { recursive: true });

  const browser = await pw.chromium.launch({ executablePath: EDGE, headless: true });

  const run = async (payload, file, waitMs) => {
    fs.writeFileSync(path.join(OUT, file), injectData(html, payload), 'utf-8');
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message || e)));
    await page.goto(fileUrl(path.join(OUT, file)), { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(waitMs || 2500);
    return { page, errors };
  };

  const read = (page) => page.evaluate(() => {
    const sec = document.getElementById('weaknet-box');
    const ins = document.getElementById('insight-box');
    const out = {
      hasSec: !!sec,
      afterInsight: !!(sec && ins && ins.nextElementSibling === sec),
      title: sec ? (sec.querySelector('.insight-title') || {}).textContent : '',
      badge: sec ? (sec.querySelector('.insight-badge') || {}).textContent : '',
      badgeCls: sec ? (sec.querySelector('.insight-badge') || {}).className : '',
      sub: sec ? (sec.querySelector('.insight-sub') || {}).textContent : '',
      lead: sec ? (sec.querySelector('.insight-lead') || {}).textContent : '',
      items: sec ? Array.from(sec.querySelectorAll('.insight-list li')).map((li) => ({
        k: (li.querySelector('b') || {}).textContent,
        v: li.textContent.replace((li.querySelector('b') || { textContent: '' }).textContent, '').trim(),
      })) : [],
      rows: sec ? Array.from(sec.querySelectorAll('.wn-table tbody tr')).map((tr) =>
        Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim())) : [],
      // 变化列的着色：方向 × 指标极性
      changes: sec ? Array.from(sec.querySelectorAll('.wn-table tbody tr')).map((tr) => {
        const tds = tr.querySelectorAll('td');
        return {
          label: tds[0].textContent.replace(/\s+/g, ' ').trim(),
          text: tds[3].textContent.trim(),
          cls: tds[3].className,
        };
      }) : [],
      risks: sec ? Array.from(sec.querySelectorAll('.insight-risk')).map((d) => ({
        cls: d.className, text: d.textContent,
      })) : [],
      hint: sec ? (sec.querySelector('.wn-hint') || {}).textContent : '',
      // 解读总结本身要照常渲染
      insLead: ins ? (ins.querySelector('.insight-lead') || {}).textContent : null,
    };
    return out;
  });

  /** 取一条指标行（第一列文字以 label 开头） */
  const row = (st, label) => st.rows.find((r) => r[0] && r[0].indexOf(label) === 0) || [];

  // ── ① 正常：有弱网段也有直连段 ──────────────────────────────────────────
  console.log('[perf.html] 有弱网段 + 直连段');
  let r = await run(basePayload(WEAKNET), 'weak_ok.html');
  let st = await read(r.page);

  check('出现弱网总结分析区块', st.hasSec === true, st);
  check('区块紧跟在解读总结之后', st.afterInsight === true, st.afterInsight);
  check('解读总结照常渲染', typeof st.insLead === 'string' && st.insLead.length > 10, st.insLead);
  check('标题为「弱网总结分析」', st.title === '弱网总结分析', st.title);
  check('徽标显示弱网时长占比 33%', /弱网\s*33%\s*时长/.test(st.badge || ''), st.badge);
  check('副标题：1 段 · 累计 1 分 20 秒 · 来源', /1 段/.test(st.sub) && /累计 1 分 20 秒/.test(st.sub) && /Windows WeakNet/.test(st.sub), st.sub);

  check('结论含弱网时长与占比', /1 分 20 秒/.test(st.lead) && /33%/.test(st.lead), st.lead);
  check('结论含两侧平均帧率与变化', /42\.0 fps/.test(st.lead) && /60\.0 fps/.test(st.lead) && /-30\.0%/.test(st.lead), st.lead);

  const scene = (st.items.find((x) => x.k === '场景') || {}).v || '';
  check('场景名带生效参数', /3G 慢速/.test(scene) && /下行 400 kbps/.test(scene) && /下行延迟 400 ms/.test(scene), scene);
  check('场景不写全 0 参数', !/抖动 0/.test(scene) && !/丢包 0/.test(scene), scene);
  const span = (st.items.find((x) => x.k === '时段') || {}).v || '';
  const want = clockOf(T0 + 80 * 1000) + '–' + clockOf(T0 + 160 * 1000) + '（1 分 20 秒）';
  check('时段显示起止与时长', span.indexOf(want) === 0, { span, want });
  check('接管范围', /全部程序/.test((st.items.find((x) => x.k === '接管范围') || {}).v || ''), st.items);
  const flow = (st.items.find((x) => x.k === '代理流量') || {}).v || '';
  check('代理流量按字节换算', /下行 12\.0 MB/.test(flow) && /上行 512 KB/.test(flow), flow);

  check('对比表 6 行', st.rows.length === 6, st.rows.map((x) => x[0]));
  const fpsRow = row(st, '平均帧率');
  check('平均帧率 42.0 / 60.0 / -30.0%', fpsRow[1] === '42.0' && fpsRow[2] === '60.0' && fpsRow[3] === '-30.0%', fpsRow);
  const reachRow = row(st, '达帧率');
  check('达帧率 70.0 / 100.0 / -30.0%', reachRow[1] === '70.0' && reachRow[2] === '100.0' && reachRow[3] === '-30.0%', reachRow);
  const lowRow = row(st, '1% Low');
  check('1% Low 42.0 / 60.0', lowRow[1] === '42.0' && lowRow[2] === '60.0', lowRow);
  const jankRow = row(st, '卡顿');
  check('卡顿 60.0 / 0.0 次每 10 分钟', jankRow[1] === '60.0' && jankRow[2] === '0.0', jankRow);
  const rxRow = row(st, '下行流量');
  check('下行流量 30 / 120', rxRow[1] === '30' && rxRow[2] === '120', rxRow);
  const cpuRow = row(st, '进程 CPU');
  check('进程 CPU 30.0 / 20.0', cpuRow[1] === '30.0' && cpuRow[2] === '20.0', cpuRow);

  const chg = (label) => st.changes.find((x) => x.label.indexOf(label) === 0) || {};
  check('帧率下滑标红', chg('平均帧率').cls === 'wn-bad', chg('平均帧率'));
  check('CPU 升高标红', chg('进程 CPU').cls === 'wn-bad' && chg('进程 CPU').text === '+50.0%', chg('进程 CPU'));
  check('流量变化不判好坏（中性）', chg('下行流量').cls === 'wn-flat', chg('下行流量'));
  check('直连零卡顿时变化显示 --', chg('卡顿').text === '--', chg('卡顿'));

  check('风险：帧率衰减', st.risks.some((x) => /风险/.test(x.text) && /30\.0%/.test(x.text)), st.risks.map((x) => x.text));
  check('注意：卡顿倍数', st.risks.some((x) => /注意/.test(x.text) && /卡顿/.test(x.text)), st.risks.map((x) => x.text));
  check('注意：达帧率下滑', st.risks.some((x) => /注意/.test(x.text) && /达帧率/.test(x.text)), st.risks.map((x) => x.text));
  check('口径说明提到轮询与端口', /每 2 秒/.test(st.hint) && /127\.0\.0\.1:8899/.test(st.hint), st.hint);
  check('无 JS 报错', r.errors.length === 0, r.errors.slice(0, 3));

  const box = await r.page.$('#weaknet-box');
  const insBox = await r.page.$('#insight-box');
  // 先把滚动位置归零再量坐标：box.screenshot() 会把元素滚进视口，
  // 之后量出来的 boundingBox 已经偏移，拿它当 fullPage 的 clip 会截歪
  await r.page.evaluate(() => window.scrollTo(0, 0));
  const boxRect = box ? await box.boundingBox() : null;
  const insRect = insBox ? await insBox.boundingBox() : null;
  if (box) await box.screenshot({ path: path.join(SHOTS_OUT, 'weaknet-report-dark.png') });
  // 连同上方的「解读总结」一起截一张，证明两者的先后关系
  if (boxRect && insRect) {
    await r.page.screenshot({
      path: path.join(SHOTS_OUT, 'weaknet-report-context.png'),
      fullPage: true,
      clip: {
        x: insRect.x,
        y: insRect.y,
        width: Math.max(insRect.width, boxRect.width),
        height: boxRect.y + boxRect.height - insRect.y,
      },
    });
  }
  await r.page.close();

  // ── ② 手机（USB 接管）来源 + 指定程序 + 多段 ─────────────────────────────
  console.log('[perf.html] 手机来源 / 多段');
  const androidSeg = seg({
    source: 'android', key: 'custom_4g', name: '4G 抖动',
    scope: 'list', scopeCount: 3,
    profile: Object.assign({}, PROFILE, { name: '4G 抖动', jitter_ms: 120, down_kbps: 800 }),
    downBytes: 3 * 1024 * 1024, upBytes: 64 * 1024,
  });
  r = await run(basePayload({
    ctrlPort: 8899, pollMs: 2000, reachable: true,
    segments: [seg(), Object.assign({}, androidSeg, { start: T0 + 200 * 1000, end: T0 + 230 * 1000 })],
  }), 'weak_multi.html');
  st = await read(r.page);
  check('两段都计入（2 段）', /2 段/.test(st.sub), st.sub);
  check('来源同时列出两端', /Windows WeakNet/.test(st.sub) && /手机（USB 接管）/.test(st.sub), st.sub);
  check('两个场景各一条', st.items.filter((x) => x.k === '场景').length === 2, st.items);
  check('时段列出两段', (st.items.find((x) => x.k === '时段') || {}).v.split('、').length === 2, st.items);
  check('指定 3 个程序', /指定 3 个程序/.test((st.items.find((x) => x.k === '接管范围') || {}).v || ''), st.items);
  check('代理流量累加（15.0 MB）', /下行 15\.0 MB/.test((st.items.find((x) => x.k === '代理流量') || {}).v || ''), st.items);
  check('多段无 JS 报错', r.errors.length === 0, r.errors.slice(0, 3));
  await r.page.close();

  // ── ③ 全程弱网：没有直连基线 ────────────────────────────────────────────
  console.log('[perf.html] 全程弱网（无直连段）');
  r = await run(basePayload({
    ctrlPort: 8899, pollMs: 2000, reachable: true,
    segments: [seg({ start: T0, end: T0 + 239 * 1000 })],
  }), 'weak_all.html');
  st = await read(r.page);
  check('全程弱网仍有区块', st.hasSec === true && /弱网\s*100%\s*时长/.test(st.badge), st.badge);
  check('直连段列显示 --', st.rows.length > 0 && st.rows.every((x) => x[2] === '--'), st.rows);
  check('提示缺少基线', st.risks.some((x) => /没有直连段做基线/.test(x.text)), st.risks.map((x) => x.text));
  await r.page.close();

  // ── ④ 没开弱网：不出现区块 ──────────────────────────────────────────────
  console.log('[perf.html] 未开弱网');
  r = await run(basePayload(null), 'weak_none.html');
  st = await read(r.page);
  check('无 data.weaknet 时不出现区块', st.hasSec === false, st.hasSec);
  check('报告主体照常', typeof st.insLead === 'string' && st.insLead.length > 10, st.insLead);
  check('无弱网时无 JS 报错', r.errors.length === 0, r.errors.slice(0, 3));
  await r.page.close();

  // ── ⑤ 段全落在采样区间之外 / 段为空数组：不出现区块 ─────────────────────
  console.log('[perf.html] 无效段');
  r = await run(basePayload({
    ctrlPort: 8899, pollMs: 2000, reachable: true,
    segments: [seg({ start: T0 - 600000, end: T0 - 300000 })],
  }), 'weak_outside.html');
  st = await read(r.page);
  check('段在采样区间外时不出现区块', st.hasSec === false, st.hasSec);
  await r.page.close();

  r = await run(basePayload({ ctrlPort: 8899, pollMs: 2000, reachable: true, segments: [] }), 'weak_empty.html');
  st = await read(r.page);
  check('开了 weaknet 但无段时不出现区块', st.hasSec === false, st.hasSec);
  await r.page.close();

  await browser.close();
  fs.rmSync(OUT, { recursive: true, force: true });

  console.log(`\n===== 弱网总结分析渲染结果: ${passed} PASS / ${failed} FAIL =====`);
  console.log('截图: ' + SHOTS_OUT);
  if (failed) {
    console.log('FAILED: ' + FAILS.join(', '));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
