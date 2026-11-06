/**
 * 采集结束自动生成 Excel：ZIP/OOXML 结构、分组标签页、标记区间、空值语义、四平台接线。
 *
 * 分两层验证：Node 侧测 buildSheets / buildXlsx / writeRunXlsx 的纯逻辑，
 * 再用独立 Python zipfile + ElementTree 复核产物（避免「自己写的 ZIP 自己读」自证）。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const APP = path.resolve(__dirname, '..', '..', '..', '_client_src', 'app');
const W = require(path.join(APP, 'src', 'xlsx-writer'));
const R = require(path.join(APP, 'src', 'run-xlsx'));
const MAIN = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');

let passed = 0, failed = 0, skipped = 0;
const FAILED = [];
function check(name, cond, detail) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '  -> ' + JSON.stringify(detail)));
  cond ? passed++ : (failed++, FAILED.push(name));
}

// ── fixture ──────────────────────────────────────────────────────────────────
function androidPerf(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      timestamp: 1770000000000 + i * 1000,
      time: `10:00:${String(i).padStart(2, '0')}`,
      pid: 8170,
      cpu: { sysCpu: 40 + i, procCpu: 80 + i },
      cpuCores: { usage: [10, 20, 30, 40, 50, 60, 70, 80], freq: [500, 500, 500, 500, 1300, 1300, 1600, 1500] },
      mem: { totalPss: 2000 + i, nativeHeap: 120, javaHeap: 90, code: 100, stack: 1, graphics: 30, privateOther: 40, system: 500 },
      fps: i === 5 ? 10 : 60,
      jank: i === 5 ? 3 : 0,
      bigJank: 0, smallJank: 0, tinyJank: 0, jankRate: 0,
      net: { rxKBps: 3, txKBps: 1 },
      temperature: 35, tempSource: 'battery', gpuTemp: 44, cpuTemp: 44, batteryTemp: 29, skinTemp: 32,
      battery: { level: 100 - i, voltage: 4000, temperature: 29, currentNow: -200, power: 800 },
      gpu: 55 + i,
    });
  }
  return rows;
}
function androidPayload(over) {
  return Object.assign({
    device: { name: 'Android 13 中端机型', appName: 'com.example.demo', category: 'android' },
    perf: androidPerf(12),
    tag: [[2, 5], [8, 10]],
    metricOrder: ['fps', 'cpu', 'mem', 'net', 'gpu', 'temp', 'battery'],
  }, over || {});
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-xlsx-'));

// ── xlsx-writer 基础 ────────────────────────────────────────────────────────
{
  const buf = W.buildXlsx([{ name: '表一', rows: [['列', '值'], ['FPS', 58.5]] }]);
  check('buildXlsx 返回 ZIP 魔数', Buffer.isBuffer(buf) && buf.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])), buf.length);
  check('CRC32 标准校验值', W.crc32(Buffer.from('123456789')) === 0xCBF43926, W.crc32(Buffer.from('123456789')));
  check('列号 A/Z/AA/AB', W.colName(0) === 'A' && W.colName(25) === 'Z' && W.colName(26) === 'AA' && W.colName(27) === 'AB', true);
  check('XML 转义 &<>"', W.esc('a&b<c>d"e') === 'a&amp;b&lt;c&gt;d&quot;e', W.esc('a&b<c>d"e'));

  const used = new Set();
  const a = W.safeSheetName('FPS/卡顿', used), b = W.safeSheetName('FPS/卡顿', used);
  check('表名去非法字符', a === 'FPS_卡顿', a);
  check('重名表名自动加后缀', b !== a && used.size === 2, [a, b]);
  check('表名不超过 31 字', W.safeSheetName('x'.repeat(80), new Set()).length === 31, true);
}

// ── buildSheets：分组 / 标记 / 空值 ─────────────────────────────────────────
const payload = androidPayload();
const sheets = R.buildSheets(payload);
const names = sheets.map(s => s.name);
const byName = n => sheets.find(s => s.name === n);

check('首个标签页是汇总', names[0] === '汇总', names);
check('每个性能组独占一个标签页',
  ['FPS与卡顿', 'CPU', '内存', '网络', 'GPU', '温度', '电池'].every(n => names.includes(n)), names);
check('末尾含标记区间与原始采样', names.slice(-2).join(',') === '标记区间,原始采样', names);
check('标签页顺序跟随 metricOrder',
  names.indexOf('FPS与卡顿') < names.indexOf('CPU') && names.indexOf('CPU') < names.indexOf('内存'), names);
check('metricOrder 可改变标签页顺序',
  R.buildSheets(androidPayload({ metricOrder: ['cpu', 'fps'] })).map(s => s.name).indexOf('CPU')
  < R.buildSheets(androidPayload({ metricOrder: ['cpu', 'fps'] })).map(s => s.name).indexOf('FPS与卡顿'), true);

{
  const fps = byName('FPS与卡顿');
  check('分组表行数 = 采样点 + 表头', fps.rows.length === 13, fps.rows.length);
  check('分组表头为中文可读标签', fps.rows[0].includes('FPS (帧/秒)') && fps.rows[0].includes('Jank (帧)'), fps.rows[0]);
  check('分组表带标记区间列', fps.rows[0][2] === '标记区间' && fps.rows[3][2] === '标记1' && fps.rows[1][2] === '', [fps.rows[1][2], fps.rows[3][2]]);
  check('第二个标记区间可识别', fps.rows[9][2] === '标记2', fps.rows[9][2]);
  check('FPS 数值按采样点写入', fps.rows[6][3] === 10 && fps.rows[2][3] === 60, [fps.rows[2][3], fps.rows[6][3]]);
}

{
  const cpu = byName('CPU');
  check('逐核列自动展开并带中文标签', cpu.rows[0].includes('核心0 使用率 (%)') && cpu.rows[0].includes('核心7 频率 (MHz)'), cpu.rows[0].slice(0, 8));
  // 前 3 列是序号/采样时间/标记区间，接着 2 列整机与进程 CPU，再是 8 核使用率 + 8 核频率
  const iUsage0 = cpu.rows[0].indexOf('核心0 使用率 (%)');
  const iFreq0 = cpu.rows[0].indexOf('核心0 频率 (MHz)');
  check('逐核数值正确', iUsage0 > 0 && iFreq0 > iUsage0
    && cpu.rows[1][iUsage0] === 10 && cpu.rows[1][iFreq0] === 500,
    [iUsage0, iFreq0, cpu.rows[1][iUsage0], cpu.rows[1][iFreq0]]);
}

{
  // 关掉的指标不占位：整列 null 时该标签页应消失
  const p = androidPayload();
  p.perf.forEach(r => { r.gpu = null; r.net = null; r.temperature = null; r.tempSource = null; });
  const n2 = R.buildSheets(p).map(s => s.name);
  check('未采到的组不生成空标签页', !n2.includes('GPU') && !n2.includes('网络'), n2);
  check('仍有其它性能标签页', n2.includes('FPS与卡顿') && n2.includes('CPU') && n2.includes('电池'), n2);
}

{
  // 空值语义：不补 0
  const p = androidPayload();
  p.perf[3].fps = null;
  p.perf[3].mem.totalPss = null;
  const s = R.buildSheets(p);
  const fps = s.find(x => x.name === 'FPS与卡顿'), mem = s.find(x => x.name === '内存');
  check('null 采样在明细表留空', fps.rows[4][3] === null && mem.rows[4][3] === null, [fps.rows[4][3], mem.rows[4][3]]);
  const xbuf = W.buildXlsx(s);
  check('null 单元格不写 0 到 XML', !/r="D5"[^>]*><v>0<\/v>/.test(xbuf.toString('utf8')), true);
}

{
  const tag = byName('标记区间');
  check('标记区间表每个标记一行', tag.rows.length === 3, tag.rows.length);
  check('标记区间统计含均值与最低帧率', tag.rows[1][6] === 47.5 && tag.rows[1][7] === 10, tag.rows[1]);
  check('标记区间起止与采样数正确', tag.rows[1][1] === 2 && tag.rows[1][2] === 5 && tag.rows[1][5] === 4, tag.rows[1]);
  const noTag = R.buildSheets(androidPayload({ tag: [] })).find(s => s.name === '标记区间');
  check('无标记时给出提示而不是空表', noTag.rows.length === 2 && /未打标记/.test(noTag.rows[1][1]), noTag.rows);
}

{
  const raw = byName('原始采样');
  check('原始采样含全部采样点', raw.rows.length === 13, raw.rows.length);
  check('原始采样含标记区间列', raw.rows[0][3] === '标记区间' && raw.rows[3][3] === '标记1', raw.rows[0]);
  check('原始采样保留未测量语义', payload.perf[0].gpu != null && raw.rows[1].includes(55), raw.rows[1].slice(0, 6));
}

{
  const summary = byName('汇总');
  const flat = summary.rows.map(r => r.join('|'));
  check('汇总含应用/设备/采样点数', flat.some(x => /^应用\|com\.example\.demo/.test(x))
    && flat.some(x => /^采样点数\|12/.test(x)), flat.slice(0, 10));
  check('汇总含各指标均值/最小/最大表头', flat.includes('指标|均值|最小|最大|单位|有效样本'), flat.slice(11, 13));
}

{
  // 只剩 pid 这种标识列时不该单独生成「其他指标」表（否则真机上多一张空壳页）。
  // pid 本身仍要留在「原始采样」里。
  const sheets = R.buildSheets(payload);
  check('只有 pid 时不生成其他指标表', !sheets.some(s => s.name === '其他指标'),
    sheets.map(s => s.name));
  const raw = sheets.find(s => s.name === '原始采样');
  check('pid 仍保留在原始采样', raw.rows[0].includes('进程 PID'), raw.rows[0]);
}

// ── 平台兼容 ────────────────────────────────────────────────────────────────
{
  const ios = {
    device: { name: 'iPhone', appName: 'com.example.ios', category: 'ios' },
    perf: [
      { timestamp: 1770000000000, time: '10:00:00', fps: 58, cpuUsage: 12, cpuTotalSystem: 5, physFootprint: 220, memResidentSize: 180, diskBytesRead: 1024, threadCount: 24 },
      { timestamp: 1770000001000, time: '10:00:01', fps: 59, cpuUsage: 14, cpuTotalSystem: 6, physFootprint: 222, memResidentSize: 182, diskBytesRead: 2048, threadCount: 24 },
    ],
    tag: [],
  };
  const n = R.buildSheets(ios).map(s => s.name);
  check('iOS 扁平字段生成 CPU / 内存 / FPS 标签页',
    n.includes('CPU') && n.includes('内存') && n.includes('FPS与卡顿'), n);
  check('iOS 未分组字段落到其他指标', n.includes('其他指标'), n);
  const other = R.buildSheets(ios).find(s => s.name === '其他指标');
  check('其他指标含磁盘/线程字段', other.rows[0].includes('磁盘读 (B)') && other.rows[0].includes('线程数'), other.rows[0]);
}
{
  check('flattenRow 展开嵌套与数组',
    R.flattenRow({ cpu: { sysCpu: 5 }, a: [1, 2] })['cpu.sysCpu'] === 5
    && R.flattenRow({ cpu: { sysCpu: 5 }, a: [1, 2] })['a[1]'] === 2, R.flattenRow({ cpu: { sysCpu: 5 }, a: [1, 2] }));
  check('normalizeTags 过滤非法区间',
    JSON.stringify(R.normalizeTags([[1, 3], [5, 2], 'x', [0, 0]])) === '[[1,3],[0,0]]', R.normalizeTags([[1, 3], [5, 2], 'x', [0, 0]]));
  check('文件名格式与非法字符清洗',
    /^Perfara_[\w.-]+_\d{8}-\d{6}\.xlsx$/.test(R.suggestXlsxName(androidPayload(), new Date(2026, 10, 6, 9, 8, 7))),
    R.suggestXlsxName(androidPayload(), new Date(2026, 10, 6, 9, 8, 7)));
}

// ── 落盘 + 独立 Python 复核 ────────────────────────────────────────────────
const dataJsPath = path.join(TMP, 'nested', 'data.js');
const out = R.writeRunXlsx(payload, dataJsPath);
check('writeRunXlsx 自动创建报告目录', fs.existsSync(out.file), out.file);
check('writeRunXlsx 返回字节数与标签页名', out.bytes > 2000 && out.sheets.length === names.length, out.bytes);
check('产物落在 data.js 所在目录', path.dirname(out.file) === path.dirname(dataJsPath), out.file);
check('产物是 .xlsx 扩展名', out.file.endsWith('.xlsx'), out.file);

// 文件名只精确到秒，同秒两次必须改名而不是静默覆盖（覆盖等于丢上一次的数据）
{
  const again = R.writeRunXlsx(payload, dataJsPath);
  check('同秒重复生成不覆盖旧文件', again.file !== out.file, [path.basename(out.file), path.basename(again.file)]);
  check('重复生成加 _2 后缀', /_2\.xlsx$/.test(again.file), path.basename(again.file));
  const third = R.writeRunXlsx(payload, dataJsPath);
  check('第三次生成加 _3 后缀', /_3\.xlsx$/.test(third.file), path.basename(third.file));
  check('三个文件都真实存在且大小一致',
    [out.file, again.file, third.file].every(f => fs.existsSync(f) && fs.statSync(f).size > 2000),
    [out.file, again.file, third.file].map(f => fs.statSync(f).size));
}

const PY = `
import sys, json, zipfile, xml.etree.ElementTree as ET
p = sys.argv[1]
z = zipfile.ZipFile(p)
assert z.testzip() is None, 'zip corrupt'
parts = z.namelist()
need = ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
        'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'docProps/core.xml', 'docProps/app.xml']
assert all(n in parts for n in need), 'missing part'
for n in parts:
    if n.endswith('.xml') or n.endswith('.rels'):
        ET.fromstring(z.read(n))
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
wb = ET.fromstring(z.read('xl/workbook.xml'))
names = [s.get('name') for s in wb.findall('.//m:sheet', NS)]
def cells(i):
    r = ET.fromstring(z.read('xl/worksheets/sheet%d.xml' % i))
    out = []
    for c in r.findall('.//m:c', NS):
        t = c.find('m:is/m:t', NS)
        v = c.find('m:v', NS)
        out.append([c.get('r'), c.get('t'), (t.text if t is not None else (v.text if v is not None else None))])
    return out
print(json.dumps({
    'parts': len(parts), 'names': names,
    's1': cells(1)[:20], 'fps': cells(2)[:20],
    'styles': '<b/>' in z.read('xl/styles.xml').decode('utf-8'),
    'frozen': 'ySplit="1"' in z.read('xl/worksheets/sheet2.xml').decode('utf-8'),
}, ensure_ascii=False))
`;
const py = spawnSync('python', ['-c', PY, out.file], { encoding: 'utf8' });
if (py.status !== 0 && py.error && py.error.code === 'ENOENT') {
  skipped++;
  console.log('  SKIP Python zipfile 独立复核（本机无 python）');
} else {
  check('Python zipfile 复核通过', py.status === 0, (py.stderr || '').slice(0, 400));
  if (py.status === 0) {
    const r = JSON.parse(py.stdout.trim());
    check('OOXML 部件齐全', r.parts >= 15, r.parts);
    check('workbook 标签页名与构建结果一致（中文）', JSON.stringify(r.names) === JSON.stringify(names), r.names);
    const s1 = JSON.stringify(r.s1);
    check('汇总表含中文与采样点数', /采样点数/.test(s1) && /12/.test(s1), s1.slice(0, 260));
    const s2 = JSON.stringify(r.fps);
    check('FPS 表含中文表头与数值单元格', /FPS \(帧\/秒\)/.test(s2) && /"60"/.test(s2), s2.slice(0, 300));
    check('表头加粗样式存在', r.styles === true, r.styles);
    check('分组表冻结首行', r.frozen === true, r.frozen);
  }
}

// ── 主进程接线（静态） ──────────────────────────────────────────────────────
check('main 引入 run-xlsx', /require\('\.\/src\/run-xlsx'\)/.test(MAIN), true);
const xlsxCalls = MAIN.match(/^\s+_writeRunXlsxSafe\(payload, dataJsPath, '/gm) || [];
check('四个 stop handler 都接了 Excel', xlsxCalls.length === 4, xlsxCalls.length);
check('Excel 跟随 data.js 实际落盘目录', /const dataJsPath = reportsDataJs\.writeDataJs\(payload\)/.test(MAIN), true);
check('Excel 失败不影响停止流程', /function _writeRunXlsxSafe[\s\S]{0,500}catch \(e\)/.test(MAIN), true);
check('生成结果推送到采集日志', /已生成 Excel：/.test(MAIN), true);

// 报告目录里的 Excel 含真实采集数据，绝不能随发布包分发
const PACK = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'tools', 'make_release_zip.py'), 'utf8');
check('发布包剔除报告目录下的 Excel',
  /'collector\/resources\/reports\/':\s*\('\.xlsx',\s*'\.xls'\)/.test(PACK), true);

// 开发态报告目录在 _client_src/app/reports/，同样会被 build_app.py 打进 asar
const BUILD = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'tools', 'build_app.py'), 'utf8');
check('asar 打包剔除 .xlsx / .xls', /'\.xlsx',\s*'\.xls'/.test(BUILD), true);
check('asar 打包剔除开发态 reports/data.js', /'reports\/data\.js'/.test(BUILD), true);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
console.log(`\n===== Excel 导出测试结果: ${passed} PASS / ${failed} FAIL / ${skipped} SKIP =====`);
if (failed) {
  console.log('FAILED: ' + FAILED.join(', '));
  process.exit(1);
}
