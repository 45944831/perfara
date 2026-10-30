/**
 * 弱网总结分析：段状态机 + 接线/模板静态检查。
 *
 * 追踪口径：采集期间每 2s 轮询 WeakNet 的 /api/status，limit_on 为真的时间段记成一段；
 * 换场景（参数指纹变化）或换来源就收口另起；连续 3 次探不到接口视为 WeakNet 退出，
 * 按最后一次成功的时刻收口（不能按「发现它没了」的时刻，否则段会被凭空拉长）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const tracker = require(path.resolve(__dirname, '../../../_client_src/app/src/weaknet-tracker'));
const { WeaknetSegments } = tracker;

const PROJ = path.resolve(__dirname, '..', '..', '..');
const APP = path.join(PROJ, '_client_src', 'app');
const REPORTS = path.join(PROJ, 'perfara', 'collector', 'resources', 'reports');

let passed = 0, failed = 0;
const FAILED = [];
function check(name, cond, detail) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '  -> ' + JSON.stringify(detail)));
  cond ? passed++ : (failed++, FAILED.push(name));
}

/** 造一份与 WeakNet /api/status 同构的最小响应 */
function status(o) {
  const opt = o || {};
  const prof = Object.assign({
    name: '3G 慢速',
    latency_down_ms: 400,
    latency_up_ms: 400,
    jitter_ms: 0,
    down_kbps: 400,
    up_kbps: 400,
    loss_pct: 0,
  }, opt.profile || {});
  return {
    version: '1.4.2',
    limit_on: opt.on !== false,
    preset_key: opt.key || 'custom_3g',
    profile: prof,
    scope: { mode: opt.scope || 'all', list: opt.list || [], seen: [] },
    stats: { total: 1, active: 1, up: opt.up || 0, down: opt.down || 0, bypass: 0, uptime: 100 },
    events: [],
    listen: true,
  };
}

const NO = { pc: status({ on: false }) };

// ── 状态机 ────────────────────────────────────────────────────────────────
{
  const w = new WeaknetSegments();
  for (let i = 0; i < 5; i += 1) w.feed(NO, 100000 + i * 2000);
  const segs = w.finish(120000);
  check('全程未开弱网 → 无段', segs.length === 0, segs);
  check('接口探通即标记 reachable', w.reachable === true, w.reachable);
}

{
  const w = new WeaknetSegments();
  const T = 1_000_000;
  w.feed(NO, T - 2000);
  w.feed({ pc: status({}) }, T);
  w.feed({ pc: status({}) }, T + 2000);
  w.feed({ pc: status({}) }, T + 4000);
  const segs = w.finish(T + 6000);
  check('开→关：记 1 段', segs.length === 1, segs);
  const s = segs[0];
  check('段起点 = 首次观测到 limit_on', s && s.start === T, s && s.start);
  check('段终点 = finish 时刻（结束时仍开着）', s && s.end === T + 6000, s && s.end);
  check('段来源为 pc', s && s.source === 'pc', s && s.source);
  check('段带场景名与参数', s && s.name === '3G 慢速' && s.profile && s.profile.down_kbps === 400, s);
  check('段带接管范围', s && s.scope === 'all' && s.scopeCount === 0, s && [s.scope, s.scopeCount]);
}

{
  // 中途改参数（换场景）→ 收口旧段、另起新段
  const w = new WeaknetSegments();
  const T = 2_000_000;
  w.feed({ pc: status({}) }, T);
  w.feed({ pc: status({}) }, T + 2000);
  w.feed({ pc: status({ key: 'custom_2g', profile: { name: '2G 极慢', down_kbps: 64 } }) }, T + 4000);
  w.feed({ pc: status({ key: 'custom_2g', profile: { name: '2G 极慢', down_kbps: 64 } }) }, T + 6000);
  const segs = w.finish(T + 8000);
  check('换场景拆成 2 段', segs.length === 2, segs.map((x) => x.key));
  check('旧段在换场景时刻收口', segs[0] && segs[0].end === T + 4000, segs[0] && segs[0].end);
  check('新段从换场景时刻起算', segs[1] && segs[1].start === T + 4000, segs[1] && segs[1].start);
  check('新段参数已更新', segs[1] && segs[1].profile.down_kbps === 64, segs[1] && segs[1].profile);
}

{
  // 弱网组合：preset_key 一直是 c:<id>，靠每一段的 profile 变化拆段
  const w = new WeaknetSegments();
  const T = 2_500_000;
  const ck = 'c:700a474f';
  w.feed({ pc: status({ key: ck, profile: { name: '4G 弱网', down_kbps: 400 } }) }, T);
  w.feed({ pc: status({ key: ck, profile: { name: '4G 弱网', down_kbps: 400 } }) }, T + 2000);
  w.feed({ pc: status({ key: ck, profile: { name: 'Wi-Fi 良好', down_kbps: 0 } }) }, T + 4000);
  w.feed({ pc: status({ key: ck, profile: { name: 'Wi-Fi 良好', down_kbps: 0 } }) }, T + 6000);
  const segs = w.finish(T + 8000);
  check('组合按段拆成 2 段', segs.length === 2, segs.map((x) => x.name));
  check('组合每段带各自场景名',
    segs[0] && segs[0].name === '4G 弱网' && segs[1] && segs[1].name === 'Wi-Fi 良好',
    segs.map((x) => x.name));
  check('组合段边界落在换段时刻',
    segs[0] && segs[0].end === T + 4000 && segs[1] && segs[1].start === T + 4000,
    segs.map((x) => [x.start, x.end]));
}

{
  // USB 接管的手机：限速跑在本机引擎上，但报告里的来源必须是手机
  const w = new WeaknetSegments();
  w.phoneUsb = true;
  const T = 3_000_000;
  w.feed({ pc: status({}) }, T);
  const segs = w.finish(T + 2000);
  check('USB 接管时本机引擎的段记为手机', segs[0] && segs[0].source === 'android',
    segs[0] && segs[0].source);

  const w2 = new WeaknetSegments();
  w2.feed({ pc: status({}) }, T);
  const segs2 = w2.finish(T + 2000);
  check('没接管手机时本机引擎的段仍记为本机', segs2[0] && segs2[0].source === 'pc',
    segs2[0] && segs2[0].source);
}

{
  // 采集中途接管手机：来源变了就要在切换时刻拆段，不能把整段都算成本机
  const w = new WeaknetSegments();
  const T = 4_000_000;
  w.feed({ pc: status({}) }, T);
  w.feed({ pc: status({}) }, T + 2000);
  w.phoneUsb = true;
  w.feed({ pc: status({}) }, T + 4000);
  const segs = w.finish(T + 6000);
  check('中途接管手机按切换点拆段', segs.length === 2, segs.map((s) => s.source));
  check('拆段后前段本机、后段手机',
    segs[0] && segs[1] && segs[0].source === 'pc' && segs[1].source === 'android',
    segs.map((s) => s.source));
}

{
  // 只改显示名不算换场景（指纹跳过 name 字段）
  const w = new WeaknetSegments();
  const T = 2_500_000;
  w.feed({ pc: status({}) }, T);
  w.feed({ pc: status({ profile: { name: '改了个名字' } }) }, T + 2000);
  const segs = w.finish(T + 4000);
  check('仅改名称不拆段', segs.length === 1, segs.map((x) => x.name));
  check('段名取最新的', segs[0] && segs[0].name === '改了个名字', segs[0] && segs[0].name);
}

{
  // 中途关一下再开 → 两段（报告端按场景归并展示）
  const w = new WeaknetSegments();
  const T = 3_000_000;
  w.feed({ pc: status({}) }, T);
  w.feed(NO, T + 2000);
  w.feed({ pc: status({}) }, T + 4000);
  const segs = w.finish(T + 6000);
  check('关→再开记 2 段', segs.length === 2, segs.map((x) => [x.start, x.end]));
  check('第一段止于关闭时刻', segs[0] && segs[0].end === T + 2000, segs[0] && segs[0].end);
  check('第二段起于重开时刻', segs[1] && segs[1].start === T + 4000, segs[1] && segs[1].start);
}

{
  // WeakNet 直接退出：连续 3 次探不到接口，按最后一次成功时刻收口
  const w = new WeaknetSegments();
  const T = 4_000_000;
  w.feed({ pc: status({}) }, T);
  w.feed({ pc: status({}) }, T + 2000);
  w.feed({}, T + 4000);
  w.feed({}, T + 6000);
  check('失联 2 次仍在观察', w.segments.length === 0, w.segments);
  w.feed({}, T + 8000);
  const segs = w.finish(T + 12000);
  check('失联 3 次收口为 1 段', segs.length === 1, segs);
  check('收口在最后一次成功时刻（不按发现失联时刻）', segs[0] && segs[0].end === T + 2000, segs[0] && segs[0].end);
}

{
  // 探不到接口时不应把空结果当成 reachable
  const w = new WeaknetSegments();
  w.feed({}, 1000);
  w.feed({}, 3000);
  const segs = w.finish(5000);
  check('全程不可达 → reachable=false 且无段', w.reachable === false && segs.length === 0, { r: w.reachable, segs });
}

{
  // 指定程序范围：只统计真正走代理的那几个
  const w = new WeaknetSegments();
  const T = 5_000_000;
  w.feed({ pc: status({ scope: 'list', list: [{ name: 'a' }, { name: 'b' }] }) }, T);
  w.feed({ pc: status({ scope: 'list', list: [{ name: 'a' }, { name: 'b' }] }) }, T + 2000);
  const segs = w.finish(T + 4000);
  check('指定程序范围与数量', segs[0] && segs[0].scope === 'list' && segs[0].scopeCount === 2, segs[0] && [segs[0].scope, segs[0].scopeCount]);
}

{
  // 计数器差值：代理流量
  const w = new WeaknetSegments();
  const T = 6_000_000;
  w.feed({ pc: status({ down: 1000, up: 200 }) }, T);
  w.feed({ pc: status({ down: 5000, up: 900 }) }, T + 2000);
  w.feed({ pc: status({ down: 9000, up: 1200 }) }, T + 4000);
  const segs = w.finish(T + 6000);
  check('下行流量按计数器差值', segs[0] && segs[0].downBytes === 8000, segs[0] && segs[0].downBytes);
  check('上行流量按计数器差值', segs[0] && segs[0].upBytes === 1000, segs[0] && segs[0].upBytes);
  check('中间态字段不落盘', segs[0] && !('_down0' in segs[0]) && !('_sig' in segs[0]), Object.keys(segs[0] || {}));
}

{
  // finish 取走即清空，下一轮采集不会带上上一轮的段
  const w = new WeaknetSegments();
  w.feed({ pc: status({}) }, 1000);
  const a = w.finish(3000);
  const b = w.finish(5000);
  check('finish 取走后清空', a.length === 1 && b.length === 0, { a: a.length, b: b.length });
}

check('轮询默认 2s / 端口 8899', tracker.POLL_MS === 2000 && tracker.CTRL_PORT === 8899, [tracker.POLL_MS, tracker.CTRL_PORT]);
check('不再暴露 APK 转发端口', tracker.PHONE_PORT === undefined, tracker.PHONE_PORT);

// ── 接线 / 模板（防止打包漏文件或漏接线）────────────────────────────────────
const mainSrc = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
check('main 引入弱网追踪模块', /require\('\.\/src\/weaknet-tracker'\)/.test(mainSrc), true);
const starts = (mainSrc.match(/startWeaknetTracking\(/g) || []).length;
check('四个采集入口都开始追踪（含定义）', starts === 5, starts);
const stops = (mainSrc.match(/stopWeaknetTracking\(/g) || []).length;
// 四个停止路径 + 启动失败回滚 + 函数定义
check('各停止路径都取走追踪结果', stops === 6, stops);
check('main 不再依赖 APK 端口转发', !/forwardTcp/.test(mainSrc), true);
check('接管/解除手机同步来源标签', /weaknetTracker\.setPhoneUsb\(/.test(mainSrc), true);
check('引擎退出先还原手机代理', /phoneProxy\.restoreAll\(\)/.test(mainSrc), true);
check('引擎不在时拒绝接管手机', /weaknetHost\.probe\(info\.ctrlPort\)/.test(mainSrc), true);
const writes = (mainSrc.match(/weaknet: weaknet \|\| undefined/g) || []).length;
check('android/pc/ios/iosgpu 落盘都带 weaknet', writes === 3, writes);
check('PC 报告显式补 weaknet 字段', /payload\.weaknet = weaknet \|\| undefined/.test(mainSrc), true);

const adbSrc = fs.readFileSync(path.join(APP, 'src', 'adb.js'), 'utf8');
check('adb.js 导出 reverse 映射接口', /reverseTcp, removeReverse, listReverses/.test(adbSrc), true);
check('adb reverse 走 tcp: 映射', /'reverse', `tcp:\$\{phonePort\}`, `tcp:\$\{remote\}`/.test(adbSrc.replace(/\n\s*/g, ' ')), true);

const perfHtml = fs.readFileSync(path.join(REPORTS, 'perf.html'), 'utf8');
check('perf.html 含弱网总结分析脚本', perfHtml.includes('__WEAKNET_REPORT_V1__'), true);
check('区块标题为「弱网总结分析」', /弱网总结分析/.test(perfHtml), true);
check('区块插在解读总结之后', /insertBefore\(sec, host\.nextSibling\)/.test(perfHtml), true);
check('没有 data.weaknet 就不渲染', /!data\.weaknet\) return true/.test(perfHtml), true);
check('加载段剔除复用页面主体口径', /window\.PerfStats\s*=\s*\{/.test(perfHtml) && /PerfStats\.analyseLoading/.test(perfHtml), true);
check('重算用原始 perf 数组（不走图上的抽稀点）', /var rows = Array\.isArray\(data\.perf\)/.test(perfHtml), true);

const dataJsSrc = fs.readFileSync(path.join(APP, 'src', 'reports-data-js.js'), 'utf8');
check('归档整份 payload（weaknet 随 history 一起保留）', /JSON\.stringify\(payload\)/.test(dataJsSrc), true);

console.log(`\n===== 弱网总结分析测试结果: ${passed} PASS / ${failed} FAIL =====`);
if (failed) {
  console.log('FAILED: ' + FAILED.join(', '));
  process.exit(1);
}
