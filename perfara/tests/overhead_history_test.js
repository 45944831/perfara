'use strict';

/**
 * 1.3 / 1.4 / 1.5 离线验证：
 *   - 四端逐拍 meta 同形状、降级可识别、报告层聚合；
 *   - 注入慢 shell 后开销告警真会触发（不是只写了代码没接线）；
 *   - 注入 15000 点：分段落盘 + 合并回报告，一个点都不丢。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const src = (p) => path.join(ROOT, p);
const SampleMeta = require(src('_client_src/app/src/sample-meta.js'));
const Schema = require(src('_client_src/app/src/metric-schema.js'));
const Seg = require(src('_client_src/app/src/segmented-history.js'));
const Collector = require(src('_client_src/app/src/collector.js'));
const XL = require(src('_client_src/app/src/run-xlsx.js'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ok  ' + name); }
  else { fail += 1; console.log(' FAIL ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : '')); }
}
console.log('\n===== 1.3/1.4/1.5 溯源 · 开销 · 长时分段 =====\n');

// ── 1.3 逐拍 meta ───────────────────────────────────────────────────────────
{
  const plats = ['android', 'pc', 'ios', 'ios_gpu'];
  const metas = plats.map(p => SampleMeta.makeSampleMeta(p, {}));
  check('四端 meta 都有 4 个规定字段', metas.every(m =>
    Object.keys(m).sort().join(',') === 'quality,scope,source,unitVersion'));
  check('四端 unitVersion 统一为口径版本 2',
    metas.every(m => m.unitVersion === Schema.SCHEMA_VERSION));
  check('四端来源互不相同且都非空',
    new Set(metas.map(m => m.source)).size === 4 && metas.every(m => m.source !== 'unknown'));
  check('Android 默认应用口径 / 正常质量',
    metas[0].scope === 'app' && metas[0].quality === 'ok');
  const degraded = SampleMeta.makeSampleMeta('android', { net: { netScope: 'device' } });
  check('网络回退整机时整拍标 degraded + device',
    degraded.quality === 'degraded' && degraded.scope === 'device', degraded);
  const appNet = SampleMeta.makeSampleMeta('android', { net: { netScope: 'app' } });
  check('按 UID 统计时不误标降级', appNet.quality === 'ok' && appNet.scope === 'app');

  const rows = [
    { meta: metas[0] }, { meta: degraded }, { meta: degraded }, {},
  ];
  const sum = SampleMeta.summarizeSampleMeta(rows);
  check('逐拍汇总：withMeta / degraded 计数正确',
    sum.withMeta === 3 && sum.degraded === 2, sum);
  check('逐拍汇总按来源分桶', sum.platforms['adb-dumpsys'] === 3, sum.platforms);
  const prov = Schema.buildProvenance(rows, 'android', {});
  check('provenance.perSample 带上逐拍汇总', !!prov.perSample
    && prov.perSample.withMeta === 3 && prov.perSample.degraded === 2, prov.perSample);
  check('老报告无 meta 时不生成 perSample',
    !Schema.buildProvenance([{ fps: 60 }], 'android', {}).perSample);
}

// ── 1.4 采离开销告警 ─────────────────────────────────────────────────────────
{
  const a = Collector.assessTickCost;
  check('assessTickCost 已导出', typeof a === 'function');
  check('不足 30 拍不判定（避开冷启动抖动）', a(new Array(10).fill(400), 1000).ready === false);
  check('正常耗时不告警', a(new Array(40).fill(50), 1000).over === false);
  check('注入慢 shell（P50 400ms > 周期 30%）触发告警',
    a(new Array(40).fill(400), 1000).over === true);
  check('慢但低于 200ms 绝对门槛仍不告警（短采样周期）',
    a(new Array(40).fill(150), 100).over === false);
  check('阈值随采样周期缩放',
    a(new Array(40).fill(400), 1000).limit === 300
    && a(new Array(40).fill(400), 2000).limit === 600);
  check('非法值被过滤', a(new Array(40).fill(NaN), 1000).ready === false);
  const colSrc = fs.readFileSync(src('_client_src/app/src/collector.js'), 'utf8');
  check('每拍记录各通道 shell 耗时', /const shellMs = \{\}/.test(colSrc)
    && /shellMs\[j\[0\]\] = Date\.now\(\) - t0/.test(colSrc));
  check('shellMs 写进历史点', /data\.shellMs = shellMs/.test(colSrc));
  check('Excel 汇总页聚合各通道耗时', /各采集通道平均耗时/.test(
    fs.readFileSync(src('_client_src/app/src/run-xlsx.js'), 'utf8')));
  check('报告页展示采集耗时 P50/P95', /采集耗时/.test(
    fs.readFileSync(src('perfara/collector/resources/reports/perf.html'), 'utf8')));
}

// ── 1.5 分段落盘 + 合并（15000 点注入） ──────────────────────────────────────
function fakeFs() {
  const files = new Map();
  return {
    files,
    mkdirSync() {}, rmdirSync() {},
    writeFileSync(p, text) { files.set(p, text); },
    readFileSync(p) { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
    unlinkSync(p) { files.delete(p); },
  };
}
{
  check('planSpill 未到上限返回 0', Seg.planSpill(9, 10, 3) === 0);
  check('planSpill 到上限返回 chunkSize', Seg.planSpill(10, 10, 3) === 3);
  const f = fakeFs();
  const sh = new Seg.SegmentedHistory({
    max: 500, chunkSize: 100, dir: 'C:/fake/perfara_segments', fs: f,
  });
  const buffer = [];
  for (let i = 0; i < 15000; i++) sh.push(buffer, { timestamp: 1000 + i, fps: 60 + (i % 3) });
  const diag = sh.diagnostics();
  check('15000 点注入后内存缓冲被钉在上限附近', buffer.length <= 500, buffer.length);
  check('溢出点已落盘分片（不是丢弃）', diag.spilledPoints > 14000
    && diag.segmentCount > 100, diag);
  check('没有静默丢失', diag.droppedPoints === 0, diag);
  check('分片文件确实写入', f.files.size === diag.segmentCount, f.files.size);
  const merged = sh.drain(buffer);
  check('合并后 15000 点一个不少', merged.length === 15000, merged.length);
  check('合并后时间顺序严格递增（分片在前、内存尾部在后）',
    merged.every((r, i) => i === 0 || r.timestamp > merged[i - 1].timestamp));
  check('首尾时间戳正确', merged[0].timestamp === 1000
    && merged[14999].timestamp === 15999);
  check('drain 后临时分片已清理', f.files.size === 0, f.files.size);
  check('drain 后账本归零', sh.segments.length === 0);
}
{
  // 写盘失败：必须显式计数 + 日志，且内存不能无限涨
  const f = fakeFs();
  f.writeFileSync = () => { throw new Error('EACCES'); };
  const logs = [];
  const sh = new Seg.SegmentedHistory({
    max: 100, chunkSize: 20, dir: 'C:/fake/fail', fs: f, log: (m) => logs.push(m),
  });
  const buffer = [];
  for (let i = 0; i < 400; i++) sh.push(buffer, { timestamp: i });
  check('写盘失败时内存仍受限（不会 OOM）', buffer.length <= 100, buffer.length);
  check('写盘失败显式计数', sh.diagnostics().droppedPoints > 0, sh.diagnostics());
  check('写盘失败有日志（不静默）', logs.some(m => /已丢弃/.test(m)), logs.slice(0, 2));
}

// ── 四平台 payload 实跑（1.3 验收） ──────────────────────────────────────────
{
  const platforms = ['android', 'pc', 'ios', 'ios_gpu'];
  for (const cat of platforms) {
    const perf = [];
    for (let i = 0; i < 12; i++) {
      perf.push({
        timestamp: 1770000000000 + i * 1000, time: '10:00:0' + (i % 10),
        fps: 58 + (i % 3), jank: i % 2,
        meta: SampleMeta.makeSampleMeta(cat, {}),
        tickMs: 40, shellMs: { cpu: 20, fps: 18 },
      });
    }
    const payload = { device: { category: cat, name: 'test-device' }, perf, tag: [] };
    const sheets = XL.buildSheets(payload);
    const ok = sheets.some(s => s.name === '汇总') && sheets.some(s => s.name === '数据质量');
    check(`${cat} payload 能生成汇总与数据质量页`, ok, sheets.map(s => s.name));
    const raw = sheets.find(s => s.name === '原始采样');
    check(`${cat} meta/shellMs 不污染原始采样列`, raw && !raw.rows[0]
      .some(c => typeof c === 'string' && /^meta\.|^shellMs\./.test(c)));
  }
  check('iOS 明确禁用 4 组并列「本平台不采集」', (() => {
    const iosPerf = [{ timestamp: 1, time: 'x', fps: 60, cpuUsage: 10,
      meta: SampleMeta.makeSampleMeta('ios', {}) }];
    const sheets = XL.buildSheets({ device: { category: 'ios' }, perf: iosPerf, tag: [] });
    const names = sheets.map(s => s.name);
    const summary = sheets.find(s => s.name === '汇总');
    const q = sheets.find(s => s.name === '数据质量');
    return !names.includes('网络') && !names.includes('温度')
      && !names.includes('电池') && !names.includes('GPU')
      && JSON.stringify(summary.rows).includes('本平台不采集')
      && JSON.stringify(q.rows).includes('本平台不采集');
  })());
}

// ── 静态接线 ────────────────────────────────────────────────────────────────
{
  for (const p of ['collector.js', 'pc-collector.js', 'ios-collector.js', 'ios-gpu-collector.js']) {
    const t = fs.readFileSync(src(`_client_src/app/src/${p}`), 'utf8');
    check(`${p} 接入 sample-meta`, /require\('\.\/sample-meta'\)/.test(t)
      && /makeSampleMeta\(/.test(t));
  }
  const main = fs.readFileSync(src('_client_src/app/main.js'), 'utf8');
  const stopBlock = (main.slice(main.indexOf("ipcMain.handle('stop-collect'"))
    .split('const weaknet')[0]) || '';
  check('stop-collect 在 stop 前合并分片', /androidSpilled = collector\.drainHistory\(\)/.test(stopBlock)
    && stopBlock.indexOf('drainHistory()') < stopBlock.indexOf('collector.stop()'), stopBlock.slice(0, 400));
  check('报告取更完整的一份（不重复拼接）', /androidSpilled\.length >= perfHistory\.length/.test(main));
}

console.log(`\n===== 溯源 · 开销 · 长时分段测试结果: ${pass} PASS / ${fail} FAIL =====\n`);
process.exit(fail ? 1 : 0);
