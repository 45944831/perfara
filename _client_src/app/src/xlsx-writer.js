'use strict';

/**
 * 零依赖 .xlsx 生成器（OOXML / SpreadsheetML）。
 *
 * 运行期只带 echarts，没有 exceljs / jszip / openpyxl；.xlsx 本质是一个 ZIP 包，
 * 这里用 Node 内置 zlib + 手写 ZIP 中央目录，直接产出 Excel / WPS 可打开的工作簿。
 * 只实现用到的能力：多工作表、中文表名、表头加粗、冻结首行、自动筛选、
 * 数值与内联字符串单元格。不写公式、不写共享字符串、不依赖任何 npm 包。
 */

const zlib = require('zlib');

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL  = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG  = 'http://schemas.openxmlformats.org/package/2006/relationships';

// ── ZIP ──────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** DOS 日期时间：bit 高位起 yyyyyyy mmmm ddddd / hhhhh mmmmmm sssss */
function dosStamp(d) {
  const year = Math.max(1980, d.getFullYear());
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { date: date & 0xFFFF, time: time & 0xFFFF };
}

/**
 * 压缩等级。实测（43200 采样点、510 万单元格）：
 *   L6 → 2188ms / 18.2MB ｜ L4 → 1154ms / 20.6MB ｜ L1 → 628ms / 23.1MB
 * 报告是给人打开看的本地产物，多 2MB 换掉 1s 的卡顿更划算；再往下（L1）体积
 * 涨到 23MB 就不值了，故取 L4。
 */
const DEFLATE_LEVEL = 4;

/**
 * 把 { 文件名: Buffer } 打成 ZIP（deflate）。
 * 只支持 < 4GB / < 65535 项，远够一次采集报告使用。
 */
function makeZip(entries, when) {
  const stamp = dosStamp(when || new Date());
  const items = [];
  for (const [name, raw] of entries) {
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
    items.push({ name, data, packed: zlib.deflateRawSync(data, { level: DEFLATE_LEVEL }), crc: crc32(data) });
  }
  return assembleZip(items, stamp);
}

/** 异步版：所有部件并行压缩（libuv 线程池），主线程不被 deflate 阻塞 */
async function makeZipAsync(entries, when) {
  const stamp = dosStamp(when || new Date());
  const items = await Promise.all(entries.map(([name, raw]) => new Promise((resolve, reject) => {
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
    zlib.deflateRaw(data, { level: DEFLATE_LEVEL }, (err, packed) => {
      if (err) return reject(err);
      resolve({ name, data, packed, crc: crc32(data) });
    });
  })));
  return assembleZip(items, stamp);
}

/** 按 ZIP 结构拼字节（本地文件头 + 中央目录 + EOCD），压缩结果由调用方提供 */
function assembleZip(items, stamp) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data, packed, crc } of items) {
    const fname = Buffer.from(name, 'utf8');

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034B50, 0);
    lh.writeUInt16LE(20, 4);            // version needed
    lh.writeUInt16LE(0x0800, 6);        // UTF-8 filename
    lh.writeUInt16LE(8, 8);             // deflate
    lh.writeUInt16LE(stamp.time, 10);
    lh.writeUInt16LE(stamp.date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(packed.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(fname.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, fname, packed);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014B50, 0);
    ch.writeUInt16LE(20, 4);            // version made by
    ch.writeUInt16LE(20, 6);            // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(stamp.time, 12);
    ch.writeUInt16LE(stamp.date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(packed.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(fname.length, 28);
    ch.writeUInt16LE(0, 30);            // extra
    ch.writeUInt16LE(0, 32);            // comment
    ch.writeUInt16LE(0, 34);            // disk start
    ch.writeUInt16LE(0, 36);            // internal attrs
    ch.writeUInt32LE(0, 38);            // external attrs
    ch.writeUInt32LE(offset, 42);       // local header offset
    central.push(ch, fname);

    offset += lh.length + fname.length + packed.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054B50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(items.length, 8);
  eocd.writeUInt16LE(items.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, eocd]);
}

// ── XML ──────────────────────────────────────────────────────────────────────

/**
 * 需要转义的字符集。先用它做一次「有没有」判断：一份 12 小时报告有 500 万个
 * 单元格，其中绝大多数（时间、数值、指标名）不含任何特殊字符，逐个跑 6 条
 * replace 纯属浪费——实测这一层占了序列化时间的一大半。
 */
const NEEDS_ESC = /[&<>"'\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

function esc(s) {
  const str = String(s);
  if (!NEEDS_ESC.test(str)) return str;
  return str
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')  // XML 1.0 非法控制字符
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function colName(n) {
  let s = '';
  let i = n + 1;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

/** Excel 表名：≤31 字符、不含 : \ / ? * [ ]，同名加序号 */
function safeSheetName(name, used) {
  let n = String(name || 'Sheet').replace(/[:\\/?*\[\]]/g, '_').trim() || 'Sheet';
  if (n.length > 31) n = n.slice(0, 31);
  let base = n, i = 2;
  while (used.has(n)) {
    const suffix = '_' + i++;
    n = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(n);
  return n;
}

/** 单元格：数字走 <v>，其余一律内联字符串；null/undefined/NaN 留空 */
function cellXml(ref, value, style) {
  if (value == null || value === '') return '';
  const s = style ? ` s="${style}"` : '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${s}><v>${value}</v></c>`;
  }
  if (typeof value === 'boolean') {
    return `<c r="${ref}"${s} t="inlineStr"><is><t>${value ? 'TRUE' : 'FALSE'}</t></is></c>`;
  }
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

function sheetXml(sheet) {
  const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
  const width = rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0) || 1;
  const lastRef = `${colName(Math.max(0, width - 1))}${Math.max(1, rows.length)}`;

  // 列名只算一次：旧实现每个单元格都调一次 colName（带 while 循环），
  // 12 小时报告就是 500 万次重复计算，而列名总共只有几十个。
  const colNames = new Array(width);
  for (let i = 0; i < width; i++) colNames[i] = colName(i);

  const body = rows.map((row, ri) => {
    const arr = Array.isArray(row) ? row : [];
    const style = ri === 0 ? 1 : 0;
    const rowNo = ri + 1;
    const cells = new Array(arr.length);
    for (let ci = 0; ci < arr.length; ci++) {
      cells[ci] = cellXml(colNames[ci] + rowNo, arr[ci], style);
    }
    return `<row r="${rowNo}">${cells.join('')}</row>`;
  }).join('');

  // 列宽：首列时间类给 20，其余按表头长度估，夹在 10~26
  const head = Array.isArray(rows[0]) ? rows[0] : [];
  const cols = [];
  for (let i = 0; i < width; i++) {
    const label = String(head[i] == null ? '' : head[i]);
    const w = i === 0 ? 20 : Math.min(26, Math.max(10, label.length * 2 + 4));
    cols.push(`<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`);
  }

  const filter = rows.length > 1 ? `<autoFilter ref="A1:${lastRef}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="${NS_MAIN}">`
    + `<dimension ref="A1:${lastRef}"/>`
    + `<sheetViews><sheetView workbookViewId="0">`
    + `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>`
    + `</sheetView></sheetViews>`
    + `<sheetFormatPr defaultRowHeight="15"/>`
    + `<cols>${cols.join('')}</cols>`
    + `<sheetData>${body}</sheetData>`
    + `${filter}</worksheet>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<styleSheet xmlns="${NS_MAIN}">`
    + `<fonts count="2">`
    + `<font><sz val="11"/><name val="Calibri"/></font>`
    + `<font><b/><sz val="11"/><name val="Calibri"/></font>`
    + `</fonts>`
    + `<fills count="3">`
    + `<fill><patternFill patternType="none"/></fill>`
    + `<fill><patternFill patternType="gray125"/></fill>`
    + `<fill><patternFill patternType="solid"><fgColor rgb="FFDCE6F1"/><bgColor indexed="64"/></patternFill></fill>`
    + `</fills>`
    + `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`
    + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
    + `<cellXfs count="2">`
    + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
    + `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>`
    + `</cellXfs>`
    + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>`
    + `</styleSheet>`;
}

// ── 对外 ─────────────────────────────────────────────────────────────────────

/**
 * @param {Array<{name:string, rows:Array<Array<*>>}>} sheets 每张表第一行为表头
 * @param {{title?:string, creator?:string, when?:Date}} [meta]
 * @returns {Buffer} .xlsx 文件字节
 */
/**
 * 组装 OOXML 的各个部件（不含压缩）。
 * 同步/异步两条导出路径共用，避免两份序列化逻辑走偏。
 */
function buildParts(sheets, meta) {
  if (!Array.isArray(sheets) || sheets.length === 0) throw new Error('没有可写入的工作表');
  const when = (meta && meta.when) || new Date();
  const used = new Set();
  const named = sheets.map(s => ({ name: safeSheetName(s.name, used), rows: s.rows }));
  const n = named.length;

  const types = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    ...named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`),
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    '</Types>',
  ].join('');

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="${NS_PKG}">`
    + `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>`
    + `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>`
    + `<Relationship Id="rId3" Type="${NS_REL}/extended-properties" Target="docProps/app.xml"/>`
    + `</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>`
    + named.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    + `</sheets></workbook>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="${NS_PKG}">`
    + named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${n + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>`
    + `</Relationships>`;

  const iso = when.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" `
    + `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" `
    + `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `<dc:title>${esc((meta && meta.title) || 'Perfara 采集数据')}</dc:title>`
    + `<dc:creator>${esc((meta && meta.creator) || 'Perfara')}</dc:creator>`
    + `<cp:lastModifiedBy>Perfara</cp:lastModifiedBy>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created>`
    + `<dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>`
    + `</cp:coreProperties>`;

  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">`
    + `<Application>Perfara</Application></Properties>`;

  // 每张表的 XML 用 thunk 延后生成：同步路径立刻调用，异步路径两次生成之间让出主线程，
  // 否则 12 小时报告光是拼 XML 就是 1.9s 的单个长任务（窗口直接无响应）。
  const entries = [
    { name: '[Content_Types].xml', buf: Buffer.from(types, 'utf8') },
    { name: '_rels/.rels', buf: Buffer.from(rootRels, 'utf8') },
    { name: 'docProps/core.xml', buf: Buffer.from(core, 'utf8') },
    { name: 'docProps/app.xml', buf: Buffer.from(app, 'utf8') },
    { name: 'xl/workbook.xml', buf: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', buf: Buffer.from(wbRels, 'utf8') },
    { name: 'xl/styles.xml', buf: Buffer.from(stylesXml(), 'utf8') },
    ...named.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      make: () => Buffer.from(sheetXml(s), 'utf8'),
    })),
  ];
  return { entries, when };
}

function materialize(entries) {
  return entries.map(e => [e.name, e.buf || e.make()]);
}

async function materializeAsync(entries) {
  const out = [];
  for (const e of entries) {
    out.push([e.name, e.buf || e.make()]);
    // 让出一轮事件循环：每张表几万行 XML，一次拼完就是秒级无响应
    await new Promise(r => setImmediate(r));
  }
  return out;
}

/**
 * @param {Array<{name:string, rows:Array<Array<*>>}>} sheets 每张表第一行为表头
 * @param {{title?:string, creator?:string, when?:Date}} [meta]
 * @returns {Buffer} .xlsx 文件字节
 */
function buildXlsx(sheets, meta) {
  const { entries, when } = buildParts(sheets, meta);
  return makeZip(materialize(entries), when);
}

/**
 * 异步版本：生成 XML 与压缩都分帧/并行，主线程不再被占住。
 *
 * 12 小时报告（43200 采样点 / 510 万单元格）实测：同步路径里 deflate 2.2s +
 * 拼 XML 1.9s 两个长任务连在一起，期间 Electron 主进程完全卡死（窗口无响应、
 * 采集日志停更）。异步路径把这两段都拆开，UI 全程可响应。
 */
async function buildXlsxAsync(sheets, meta) {
  const { entries, when } = buildParts(sheets, meta);
  return makeZipAsync(await materializeAsync(entries), when);
}

module.exports = { buildXlsx, buildXlsxAsync, makeZip, makeZipAsync, crc32, esc, colName, safeSheetName };
