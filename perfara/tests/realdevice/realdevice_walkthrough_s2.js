'use strict';
/**
 * 真机完整走查 —— 阶段 2：指标组过滤 / 报告落盘 / KPI 汇总 / CSV·JSON 导出
 *
 * 用法: node realdevice_walkthrough_s2.js <deviceId> [packageName]
 */
const Module = require('module');
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-walk-s2-'));
const _origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getPath: () => TMP, getName: () => 'perfara' } };
  }
  return _origLoad.apply(this, arguments);
};

const APP = 'E:/WorkBuddy1/2026-10-19-13-59-27/_client_src/app';
process.resourcesPath = 'E:/WorkBuddy1/2026-10-19-13-59-27/perfara/collector/resources';

const CollectorMod = require(path.join(APP, 'src/collector.js'));
const Collector = CollectorMod.Collector || CollectorMod;
const exporter = require(path.join(APP, 'src/exporter.js'));
const reportsData = require(path.join(APP, 'src/reports-data-js.js'));

const DEVICE = process.argv[2] || '设备序列号';
const PKG = process.argv[3] || 'com.example.game';

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name}  ${detail !== undefined ? JSON.stringify(detail) : ''}`); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 用指定 metricConfig 采 N 秒，返回样本数组 */
async function collectWith(mc, seconds, label) {
  const c = new Collector(DEVICE, PKG, 1000, mc);
  const samples = [];
  const errs = [];
  c.on('data', d => samples.push(d));
  c.on('error', e => errs.push(e.message));
  try { await c.start(); }
  catch (e) { console.log(`  [${label}] start 失败: ${e.message}`); return { samples, errs, startError: e.message }; }
  await sleep(seconds * 1000);
  try { c.stop(); } catch (_) {}
  return { samples, errs };
}

(async () => {
  console.log(`\n===== 阶段 2：指标组过滤与报告链路（device=${DEVICE} pkg=${PKG}）=====\n`);

  // ---- 2.1 全参数采集 ----
  console.log('[2.1] 全参数采集 15 秒');
  const full = await collectWith(null, 15, '全参数');
  check('全参数采集到样本', full.samples.length >= 8, { count: full.samples.length });
  check('全参数无错误', full.errs.length === 0, full.errs.slice(0, 2));
  if (full.samples.length) {
    const s = full.samples[full.samples.length - 1];
    const has = (f) => Object.prototype.hasOwnProperty.call(s, f);
    check('全参数含 cpu', has('cpu'));
    check('全参数含 cpuCores', has('cpuCores'));
    check('全参数含 mem', has('mem'));
    check('全参数含 net', has('net'));
    check('全参数含 battery', has('battery'));
    check('全参数含 temperature', has('temperature'));
    check('全参数含 gpu', has('gpu'));
    check('全参数含 fps 键', has('fps'));
  }

  // ---- 2.2 只留 CPU 组的采集 ----
  console.log('\n[2.2] metricConfig 只开 cpu');
  const cpuOnly = await collectWith({ fps: false, cpu: true, mem: false, net: false, gpu: false, temp: false, battery: false }, 8, '仅CPU');
  check('仅CPU采集到样本', cpuOnly.samples.length >= 4, { count: cpuOnly.samples.length });
  if (cpuOnly.samples.length) {
    const s = cpuOnly.samples[cpuOnly.samples.length - 1];
    const has = (f) => Object.prototype.hasOwnProperty.call(s, f);
    check('仅CPU 保留 cpu', has('cpu'));
    check('仅CPU 保留 cpuCores', has('cpuCores'));
    check('仅CPU 移除 mem', !has('mem'));
    check('仅CPU 移除 net', !has('net'));
    check('仅CPU 移除 battery', !has('battery'));
    check('仅CPU 移除 temperature', !has('temperature'));
    check('仅CPU 移除 gpu', !has('gpu'));
    check('仅CPU 移除 fps', !has('fps'));
    check('仅CPU 保留 timestamp/pid', has('timestamp') && has('pid'));
  }

  // ---- 2.3 全部关闭 ----
  console.log('\n[2.3] metricConfig 全关');
  const none = await collectWith({ fps: false, cpu: false, mem: false, net: false, gpu: false, temp: false, battery: false }, 6, '全关');
  check('全关仍采到样本（时间戳骨架）', none.samples.length >= 3, { count: none.samples.length });
  if (none.samples.length) {
    const s = none.samples[none.samples.length - 1];
    check('全关仅保留 timestamp/time/pid',
      Object.keys(s).every(k => ['timestamp', 'time', 'pid'].includes(k)), Object.keys(s));
  }

  // ---- 2.4 filterDataByConfig 纯函数 ----
  console.log('\n[2.4] filterDataByConfig 纯函数');
  const mc = CollectorMod.normalizeMetricConfig({ fps: false, cpu: true, mem: false });
  const filtered = CollectorMod.filterDataByConfig({
    timestamp: 1, time: 'x', pid: 2, cpu: { a: 1 }, mem: { b: 2 }, fps: 60, net: {}, battery: {}, temperature: 1, gpu: 1,
  }, mc);
  check('filter 移除 fps', !('fps' in filtered), Object.keys(filtered));
  check('filter 移除 mem', !('mem' in filtered), Object.keys(filtered));
  check('filter 保留 cpu', 'cpu' in filtered);
  check('filter 保留 timestamp', 'timestamp' in filtered);

  // ---- 2.5 CSV 导出 ----
  console.log('\n[2.5] CSV/JSON 导出');
  const csv = exporter.toCSV(full.samples);
  const lines = csv.split('\r\n');
  check('CSV 行数 = 样本数+表头', lines.length === full.samples.length + 1, { lines: lines.length, samples: full.samples.length });
  check('CSV 表头含关键列', /timestamp/.test(lines[0]) && /fps/.test(lines[0]) && /procCpu/.test(lines[0]), lines[0].slice(0, 120));
  check('CSV 每行列数一致', lines.slice(1).every(l => l.split(',').length === lines[0].split(',').length));
  const csvNone = exporter.toCSV(none.samples);
  const c0 = csvNone.split('\r\n')[1] || '';
  check('全关时 CSV 指标列为空', /,,,/.test(c0), c0.slice(0, 80));
  const json = exporter.toJSON(full.samples);
  check('JSON 导出可解析', Array.isArray(JSON.parse(json)) && JSON.parse(json).length === full.samples.length);
  // JSON 内联安全：</script 会被提前闭合
  const payloadWithScript = exporter.toJSON([{ timestamp: 1, note: '</script><script>alert(1)</script>' }]);
  check('JSON 导出保留原样（转义由调用方处理）', payloadWithScript.includes('</script>'));

  // ---- 2.6 summarizePerf KPI ----
  console.log('\n[2.6] summarizePerf KPI 汇总');
  const payload = {
    perf: full.samples,
    tags: [],
    device: { name: 'Android 13 中端机型', brand: '厂商', system: 'Android 13' },
    app: { id: PKG, name: PKG },
    metricConfig: null,
  };
  // 注意：签名是 summarizePerf(perf数组, metricConfig)，不是 payload 对象
  const sum = reportsData.summarizePerf(full.samples, null);
  check('summarizePerf 返回对象', !!(sum && typeof sum === 'object'), Object.keys(sum || {}));
  check('KPI 含 fps', !!(sum && sum.kpi && sum.kpi.fps), sum && sum.kpi && sum.kpi.fps);
  check('KPI fps 有 avg 数值', !!(sum && sum.kpi.fps && typeof sum.kpi.fps.avg === 'number'), sum && sum.kpi.fps);
  check('KPI 含 cpu/mem 段', !!(sum && sum.kpi.cpu && sum.kpi.mem), sum && Object.keys(sum.kpi || {}));
  check('KPI 含 loading 段', !!(sum && sum.loading), sum && Object.keys(sum.loading || {}));
  check('samples 计数正确', sum && sum.samples === full.samples.length, sum && sum.samples);
  // 全 null 的 fps 不应把 avg 拉成 0
  const nullOnly = reportsData.summarizePerf(
    full.samples.map(s => ({ ...s, fps: null, jank: null, bigJank: null, smallJank: null, tinyJank: null, jankRate: null })), null);
  check('全 null FPS 时 avg 为 null 而非 0',
    nullOnly.kpi.fps.avg === null || nullOnly.kpi.fps.avg === undefined, nullOnly.kpi.fps);

  // ---- 2.7 metricConfig 传给 summarizePerf ----
  console.log('\n[2.7] summarizePerf 按 metricConfig 过滤');
  const sumFiltered = reportsData.summarizePerf(full.samples,
    { fps: false, cpu: true, mem: false, net: false, gpu: false, temp: false, battery: false });
  check('过滤后 KPI 不含 fps 族', !('fps' in sumFiltered.kpi), Object.keys(sumFiltered.kpi));
  check('过滤后仍含 cpu', !!sumFiltered.kpi.cpu, sumFiltered.kpi.cpu);
  check('过滤后不含 mem', !('mem' in sumFiltered.kpi), Object.keys(sumFiltered.kpi));

  // ---- 2.8 archiveReport 落盘 ----
  console.log('\n[2.8] archiveReport 落盘');
  let archived = null;
  try {
    // 必须用生产同源的路径：archiveReport 以 dataJsPath 的父目录为归档根，
    // 传别处会导致「文件落到了别处、报告库却找不到」。
    archived = reportsData.archiveReport(payload, reportsData.getReportsDataJsPath());
    check('archiveReport 返回对象', !!(archived && typeof archived === 'object'), archived && Object.keys(archived));
  } catch (e) {
    check('archiveReport 正常返回', false, e.message);
  }
  if (archived) {
    const histDir = reportsData.getHistoryDir();
    const exists = fs.existsSync(histDir);
    check('历史目录已创建', exists, histDir);
    if (exists) {
      const files = fs.readdirSync(histDir);
      check('历史目录有落盘文件', files.length > 0, { dir: histDir, files: files.slice(0, 5) });
      // 按 archived.file 精确定位本次归档的报告文件（不能取目录第一个 —— 那是 index.js）
      // archived.file 是相对 reports 根目录的路径（如 "history/xxx.js"），
      // 而 histDir 本身就是 history 目录 —— 直接拼会多一层，要用 basename。
      const repName = archived.file ? path.basename(archived.file) : '';
      const repFile = path.join(histDir, repName);
      check('归档报告文件存在', repName && fs.existsSync(repFile), { file: archived.file, repFile });
      if (repName && fs.existsSync(repFile)) {
        const raw = fs.readFileSync(repFile, 'utf8');
        check('.js 以 var data = 开头', /^var data\s*=/.test(raw.trim()), raw.slice(0, 40));
        check('.js 内不含裸 </script', !raw.includes('</script'));
        const i = raw.indexOf('{'), j = raw.lastIndexOf('}');
        let parsed = null;
        try { parsed = JSON.parse(raw.slice(i, j + 1)); } catch (e) {}
        check('.js 内 JSON 可解析', !!parsed, parsed ? Object.keys(parsed) : 'parse failed');
        check('落盘含 perf 数组', !!(parsed && Array.isArray(parsed.perf)), parsed && parsed.perf && parsed.perf.length);
        check('落盘 perf 样本数与采集一致', parsed && parsed.perf && parsed.perf.length === full.samples.length,
          parsed && parsed.perf && parsed.perf.length);
        check('落盘含 device/app 元信息', !!(parsed && parsed.device && parsed.app), parsed && { d: parsed.device, a: parsed.app });
        // kpi 只存在**索引**里（报告页自己从 perf 算），报告文件里不重复存
        check('报告文件不含冗余 kpi（索引里有）', !('kpi' in parsed), Object.keys(parsed));
        check('落盘含 metricConfig', 'metricConfig' in parsed, parsed && parsed.metricConfig);
      }
    }
    // 报告索引
    const idx = reportsData.readReportIndex();
    check('报告索引可读', Array.isArray(idx), Array.isArray(idx) ? idx.length : typeof idx);
    check('报告索引含本次归档', Array.isArray(idx) && idx.some(x => x && x.id === archived.id),
      Array.isArray(idx) ? idx.map(x => x && x.id) : idx);
    check('索引条目 file 字段指向真实文件',
      Array.isArray(idx) && idx.every(x => !x.file || fs.existsSync(path.join(histDir, path.basename(x.file)))),
      Array.isArray(idx) ? idx.map(x => x.file) : idx);
    // 报告库列表用的是**索引里的 kpi**（报告文件本身不存 kpi）
    const mine = Array.isArray(idx) ? idx.find(x => x && x.id === archived.id) : null;
    check('索引条目含 kpi（报告库列表用）', !!(mine && mine.kpi && mine.kpi.fps), mine && mine.kpi && Object.keys(mine.kpi || {}));
    check('索引条目含 samples/durationSec', !!(mine && mine.samples === full.samples.length && mine.durationSec != null),
      mine && { s: mine.samples, d: mine.durationSec });
  }

  console.log(`\n===== 阶段 2 结果：PASS ${pass} / FAIL ${fail} =====`);
  if (fails.length) console.log('失败项: ' + fails.join(' | '));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); process.exit(2); });
