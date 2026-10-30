/**
 * 应用桌面名解析：apk-label（AXML/ARSC 二进制解析）+ app-labels（缓存/队列）。
 *
 * 用合成缓冲区构造清单和资源表，不依赖真机、也不含任何真实应用数据；
 * 真机上的取值效果由 release 验收时的实测覆盖。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJ = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(PROJ, '_client_src', 'app', 'src');
const lbl = require(path.join(SRC, 'apk-label.js'));
const appLabels = require(path.join(SRC, 'app-labels.js'));

let passed = 0, failed = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; FAILS.push(name); console.log('  FAIL  ' + name + '  -> ' + JSON.stringify(detail)); }
}

// ─── 二进制构造 ──────────────────────────────────────────────────────────────

function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; }

/** UTF-8 字符串池（flags=0x0100） */
function stringPool(strings) {
  const encoded = strings.map((s) => Buffer.from(s, 'utf8'));
  const dataParts = [];
  const offsets = [];
  let cursor = 0;
  for (const e of encoded) {
    offsets.push(cursor);
    const len = Buffer.alloc(2); // 只支持 < 128 字节：UTF-16 长度=字节长度
    len[0] = e.length;
    len[1] = e.length;
    dataParts.push(len, e, Buffer.from([0]));
    cursor += len.length + e.length + 1;
  }
  const data = Buffer.concat(dataParts);
  const headerSize = 28;
  const offsetsSize = offsets.length * 4;
  const stringsStart = headerSize + offsetsSize;
  const size = stringsStart + data.length;
  return Buffer.concat([
    u16(0x0001), u16(headerSize), u32(size),
    u32(strings.length), u32(0), u32(0x0100), u32(stringsStart), u32(0),
    ...offsets.map(u32),
    data,
  ]);
}

/**
 * 造一个只有 <application android:label=…> 的 AXML。
 * @param {{type:number,data:number}} attr typed value（TYPE_STRING 或 TYPE_REFERENCE）
 */
function buildManifest(attr) {
  const strings = ['application', 'label', 'http://schemas.android.com/apk/res/android'];
  const pool = stringPool(strings);
  const attrSize = 20;
  const attrStart = 20;
  const body = Buffer.alloc(16 + attrStart + attrSize);
  body.writeUInt16LE(0x0102, 0);          // start element
  body.writeUInt16LE(16, 2);              // headerSize
  body.writeUInt32LE(body.length, 4);     // size
  body.writeUInt32LE(0, 8);               // lineNumber
  body.writeUInt32LE(0xffffffff, 12);     // comment
  body.writeUInt32LE(0, 16);              // ns
  body.writeUInt32LE(0, 20);              // name = application
  body.writeUInt16LE(attrStart, 24);
  body.writeUInt16LE(attrSize, 26);
  body.writeUInt16LE(1, 28);              // attributeCount
  body.writeUInt16LE(0, 30);
  body.writeUInt16LE(0, 32);
  body.writeUInt16LE(0, 34);
  const a = 16 + attrStart;
  body.writeUInt32LE(2, a);               // ns = android
  body.writeUInt32LE(1, a + 4);           // name = label
  body.writeUInt32LE(0xffffffff, a + 8);  // rawValue
  body.writeUInt16LE(8, a + 12);          // Res_value.size
  body.writeUInt8(0, a + 14);
  body.writeUInt8(attr.type, a + 15);
  body.writeUInt32LE(attr.data, a + 16);

  const headerSize = 8;
  const size = headerSize + pool.length + body.length;
  const head = Buffer.alloc(headerSize);
  head.writeUInt16LE(0x0003, 0);
  head.writeUInt16LE(headerSize, 2);
  head.writeUInt32LE(size, 4);
  return Buffer.concat([head, pool, body]);
}

/** 造一段 type chunk：config 的 lang/country + 若干 entry */
function typeChunk(typeId, config, entries) {
  const entryCount = entries.length;
  const configSize = 32;
  const headerSize = 20 + configSize;
  const entriesStart = headerSize + entryCount * 4;
  const entryBufs = [];
  let cursor = 0;
  const offsets = [];
  for (const e of entries) {
    offsets.push(cursor);
    const buf = Buffer.alloc(16);
    buf.writeUInt16LE(8, 0);        // ResTable_entry.size
    buf.writeUInt16LE(0, 2);        // flags
    buf.writeUInt32LE(0, 4);        // key
    buf.writeUInt16LE(8, 8);        // Res_value.size
    buf.writeUInt8(0, 10);
    buf.writeUInt8(e.type, 11);
    buf.writeUInt32LE(e.data, 12);
    entryBufs.push(buf);
    cursor += buf.length;
  }
  const entriesBuf = Buffer.concat(entryBufs);
  const size = entriesStart + entriesBuf.length;
  const head = Buffer.alloc(headerSize);
  head.writeUInt16LE(0x0201, 0);
  head.writeUInt16LE(headerSize, 2);
  head.writeUInt32LE(size, 4);
  head.writeUInt8(typeId, 8);
  head.writeUInt8(0, 9);            // flags
  head.writeUInt32LE(entryCount, 12);
  head.writeUInt32LE(entriesStart, 16);
  head.writeUInt32LE(configSize, 20);          // ResTable_config.size
  const cfgLang = config.lang || '';
  const cfgCountry = config.country || '';
  if (cfgLang) head.write(cfgLang, 28, 'latin1');
  if (cfgCountry) head.write(cfgCountry, 30, 'latin1');
  return Buffer.concat([
    head,
    ...offsets.map(u32),
    entriesBuf,
  ]);
}

function buildArsc(valueStrings, chunks) {
  const pool = stringPool(valueStrings);
  const pkgHeaderSize = 288;
  const pkgBody = Buffer.alloc(pkgHeaderSize);
  pkgBody.writeUInt16LE(0x0200, 0);
  pkgBody.writeUInt16LE(pkgHeaderSize, 2);
  pkgBody.writeUInt32LE(0x7f, 8);      // package id
  const pkgSize = pkgHeaderSize + chunks.reduce((n, c) => n + c.length, 0);
  pkgBody.writeUInt32LE(pkgSize, 4);
  const pkg = Buffer.concat([pkgBody, ...chunks]);

  const head = Buffer.alloc(12);
  head.writeUInt16LE(0x0002, 0);
  head.writeUInt16LE(12, 2);
  head.writeUInt32LE(12 + pool.length + pkg.length, 4);
  head.writeUInt32LE(1, 8);            // packageCount
  return Buffer.concat([head, pool, pkg]);
}

const TYPE_STRING = 0x03;
const TYPE_REFERENCE = 0x01;
const LABEL_ID = 0x7f0f0000;

// ─── 解析器 ──────────────────────────────────────────────────────────────────

console.log('[1] AXML 清单');
{
  const refManifest = buildManifest({ type: TYPE_REFERENCE, data: LABEL_ID });
  const m = lbl.readManifestLabel(refManifest);
  check('引用型 label 读到 resId', m && m.resId === LABEL_ID && m.text === null, m);

  const litManifest = buildManifest({ type: TYPE_STRING, data: 0 /* 指向 "application"，只为验证走到 text 分支 */ });
  const lm = lbl.readManifestLabel(litManifest);
  check('字面量 label 直接取字符串', lm && lm.text === 'application', lm);

  check('垃圾数据不抛异常', lbl.readManifestLabel(Buffer.from('not-axml-at-all')) === null);
  check('空 buffer 返回 null', lbl.readManifestLabel(Buffer.alloc(0)) === null);
}

console.log('[2] ARSC 取值');
{
  const zh = typeChunk(15, { lang: 'zh', country: 'CN' }, [
    { type: TYPE_STRING, data: 0 },
    { type: TYPE_STRING, data: 0 },
  ]);
  const def = typeChunk(15, {}, [
    { type: TYPE_STRING, data: 2 },
    { type: TYPE_STRING, data: 2 },
  ]);
  const arsc = buildArsc(['示例应用', '别名应用', 'Example App'], [def, zh]);

  check('中文设备取中文名', lbl.readArscString(arsc, LABEL_ID, { lang: 'zh', country: 'cn' }) === '示例应用',
    lbl.readArscString(arsc, LABEL_ID, { lang: 'zh', country: 'cn' }));
  check('无语言信息取默认配置', lbl.readArscString(arsc, LABEL_ID, null) === 'Example App',
    lbl.readArscString(arsc, LABEL_ID, null));
  check('英文设备取默认配置', lbl.readArscString(arsc, LABEL_ID, { lang: 'en', country: 'us' }) === 'Example App');

  // 高分配置里没有这条资源时必须回退，而不是直接判死
  const zhPartial = typeChunk(15, { lang: 'zh', country: 'CN' }, [
    { type: TYPE_STRING, data: 1 },
  ]);
  const partial = buildArsc(['示例应用', '别名应用', 'Example App'], [def, zhPartial]);
  check('zh 缺条目回退默认配置',
    lbl.readArscString(partial, 0x7f0f0001, { lang: 'zh', country: 'cn' }) === 'Example App',
    lbl.readArscString(partial, 0x7f0f0001, { lang: 'zh', country: 'cn' }));

  // 应用里大量 label 是别名（entry → entry），必须跟链
  const alias = typeChunk(15, {}, [
    { type: TYPE_REFERENCE, data: 0x7f0f0001 },
    { type: TYPE_STRING, data: 2 },
  ]);
  const aliasArsc = buildArsc(['示例应用', '别名应用', 'Example App'], [alias]);
  check('引用别名跟到字符串',
    lbl.readArscString(aliasArsc, LABEL_ID, null) === 'Example App',
    lbl.readArscString(aliasArsc, LABEL_ID, null));

  check('不存在的 entry 返回 null', lbl.readArscString(aliasArsc, 0x7f0f00ee, null) === null);
  check('垃圾 buffer 不抛异常', lbl.readArscString(Buffer.from('nope'), LABEL_ID, null) === null);
}

console.log('[3] labelFromApk 合流');
{
  const def = typeChunk(15, {}, [{ type: TYPE_STRING, data: 0 }]);
  const arsc = buildArsc(['示例应用', '别名应用', 'Example App'], [def]);
  const manifest = buildManifest({ type: TYPE_REFERENCE, data: LABEL_ID });
  check('清单 + 资源表', lbl.labelFromApk(manifest, arsc, null) === '示例应用');
  check('缺资源表时返回 null', lbl.labelFromApk(manifest, null, null) === null);
}

// ─── 缓存与队列 ──────────────────────────────────────────────────────────────

console.log('[4] app-labels 缓存与重试');
(async () => {
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-labels-')), 'app-labels.json');
  appLabels.init(cacheFile);

  let calls = 0;
  const failOnce = new Set(['com.example.flaky']);
  const fakeAdb = {
    getDeviceLocale: async () => ({ lang: 'zh', country: 'cn' }),
    resolveAppLabel: async (_d, pkg) => {
      calls += 1;
      if (failOnce.has(pkg)) { failOnce.delete(pkg); return null; } // 模拟 adb 抖动
      if (pkg === 'com.example.noname') return '';                   // 确认没有名字
      return `名字-${pkg.split('.').pop()}`;
    },
  };
  const packages = [
    { pkg: 'com.example.alpha', versionCode: 1 },
    { pkg: 'com.example.beta', versionCode: 2 },
    { pkg: 'com.example.flaky', versionCode: 3 },
    { pkg: 'com.example.noname', versionCode: 4 },
  ];

  const events = [];
  await appLabels.resolveAll({
    deviceId: 'FAKEDEV1',
    packages,
    adb: fakeAdb,
    onUpdate: (items, prog) => events.push({ items, prog }),
  });
  const names = new Map();
  for (const e of events) for (const it of e.items) names.set(it.pkg, it.label);
  check('全部包拿到名字（含一次失败后重试成功）', names.size === 3 && names.get('com.example.flaky') === '名字-flaky', [...names]);
  check('结束事件带 finished', events.some(e => e.prog.finished && e.prog.done === 4));
  check('空结果也会计进度', events.some(e => e.prog.done === 4));

  // 第二轮：全部命中缓存，不再调 adb
  calls = 0;
  const second = [];
  await appLabels.resolveAll({
    deviceId: 'FAKEDEV1',
    packages,
    adb: fakeAdb,
    onUpdate: (items, prog) => second.push({ items, prog }),
  });
  check('第二轮零 adb 调用', calls === 0, calls);
  check('第二轮直接 finished', second.some(e => e.prog.finished));

  const attach = packages.map(p => ({ ...p, label: p.pkg }));
  const hit = await appLabels.attachCached('FAKEDEV1', attach, fakeAdb);
  check('attachCached 填充缓存名', hit === 3
    && attach.find(p => p.pkg === 'com.example.alpha').label === '名字-alpha'
    && attach.find(p => p.pkg === 'com.example.noname').label === 'com.example.noname', attach.map(p => p.label));

  // versionCode 变了（应用升级）必须重解
  calls = 0;
  await appLabels.resolveAll({
    deviceId: 'FAKEDEV1',
    packages: [{ pkg: 'com.example.alpha', versionCode: 99 }],
    adb: fakeAdb,
    onUpdate: () => {},
  });
  check('版本号变化触发重解', calls === 1, calls);

  // shouldPause：采集中不跑，取消后恢复
  calls = 0;
  let paused = true;
  const pending = appLabels.resolveAll({
    deviceId: 'FAKEDEV1',
    packages: [{ pkg: 'com.example.gamma', versionCode: 5 }],
    adb: fakeAdb,
    onUpdate: () => {},
    shouldPause: () => paused,
  });
  await new Promise(r => setTimeout(r, 300));
  check('采集暂停期间不发起解析', calls === 0, calls);
  paused = false;
  await pending;
  check('恢复后解析完成', calls === 1, calls);

  fs.rmSync(path.dirname(cacheFile), { recursive: true, force: true });

  console.log(`\n结果：${passed} PASS / ${failed} FAIL`);
  if (failed > 0) { console.log('FAILED: ' + FAILS.join(', ')); process.exit(1); }
  console.log('APPLY_LABELS_TEST_OK');
})().catch(e => { console.error('UNCAUGHT', e); process.exit(1); });
