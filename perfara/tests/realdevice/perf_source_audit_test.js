'use strict';
/**
 * 采集源审计：错采 / 漏采 / 重复采集。
 *
 * 与上一轮 perf_param_audit_test 的分工：
 *   perf_param_audit 锁「算法算错」（comm 错位、热插拔、GPU 累计、滚动窗口、Jank 单位）；
 *   本文件锁「采集源本身」：
 *     ① 重复采集 —— 同一 tick 内同一条采集命令是否被执行多次
 *     ② 口径错采 —— 分母/来源/单位选错（进程 CPU 的整机 vs 单核、meminfo 两套 Pss）
 *     ③ 漏采     —— 白名单/节点覆盖不全（464xlat 的 clat、v4- 接口）
 *
 * 全部离线，不依赖真机、不启动 adb。
 * 用法: node perf_source_audit_test.js
 */
const fs = require('fs');
const path = require('path');
const ADB = require('../../../_client_src/app/src/adb');
const algo = ADB.__algo;

const ROOT = path.join(__dirname, '../../..');
const readSrc = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name}  ${detail !== undefined ? JSON.stringify(detail) : ''}`); }
}

console.log('\n===== 采集源审计：错采 / 漏采 / 重复采集 =====\n');

// ─── ① 进程 CPU：占整机还是占单核 ─────────────────────────────────────────────
console.log('-- ① 进程 CPU 口径：分母必须是「单核平均总时长」 --');
const cpu = algo.calcCpuPct;

// 8 核 100Hz、1 秒：整机总增量 800 jiffies，单核跑满的进程增量 100
check('8 核单核跑满 → 100%（旧口径只有 12.5%）', cpu(0, 100, 800, 600, 8).procCpu === 100,
  cpu(0, 100, 800, 600, 8));
check('8 核双核跑满 → 200%，不被 100 截断', cpu(0, 200, 800, 600, 8).procCpu === 200,
  cpu(0, 200, 800, 600, 8));
check('8 核全核跑满 → 800%', cpu(0, 800, 800, 0, 8).procCpu === 800,
  cpu(0, 800, 800, 0, 8));
check('单核设备保持原口径：增量和总增量 1:1 → 100%',
  cpu(0, 100, 100, 0, 1).procCpu === 100, cpu(0, 100, 100, 0, 1));
check('整机使用率不受核数影响：idle 600/800 → 25%', cpu(0, 100, 800, 600, 8).sysCpu === 25,
  cpu(0, 100, 800, 600, 8));
check('总增量非正（回绕/重启）→ 双 null',
  cpu(0, 100, 0, 0, 8).sysCpu === null && cpu(0, 100, 0, 0, 8).procCpu === null);
check('缺进程基线 → procCpu 为 null，sysCpu 照常',
  cpu(null, 100, 800, 600, 8).procCpu === null && cpu(null, 100, 800, 600, 8).sysCpu === 25);
check('核数缺省按 1 兜底，不除零',
  cpu(0, 100, 100, 0, 0).procCpu === 100, cpu(0, 100, 100, 0, 0));

// 旧算法反例：直接除整机总增量
const legacyProc = (p, c, td) => Math.round(((c - p) / td) * 100);
check('旧算法在 8 核上确实只有 12.5%（证明修复不是空转）',
  legacyProc(0, 100, 800) === 13 || legacyProc(0, 100, 800) === 12,
  legacyProc(0, 100, 800));

// ─── ② meminfo：分项必须同一口径 ─────────────────────────────────────────────
console.log('\n-- ② 内存分项：App Summary 与明细表不能混用 --');
// 真机（Android 13）实测片段：明细表 Native Heap=1901、汇总表 Native Heap: 1360
const MEM_SAMPLE = `
Applications Memory Usage (in Kilobytes):
** MEMINFO in pid 9266 [com.demo.app] **
                   Pss  Private  Private  SwapPss      Rss
                 Total    Dirty    Clean    Dirty    Total
  Native Heap     1901     1360      532    39900     2336
  Dalvik Heap    11258     8196      292      189    15344
        Stack      284      232       52      672      284
        TOTAL    84024    15988    11164    43238   140012

 App Summary
                       Pss(KB)
           Java Heap:     9452                          28256
         Native Heap:     1360                           2336
                Code:     9812                         101276
               Stack:      232                            284
            Graphics:    2724                           2724
       Private Other:    3572
              System:    56872
           TOTAL PSS:    84024            TOTAL RSS:   140012
`;
const MEM_INFO = `MemTotal:        8000000 kB
MemAvailable:    3000000 kB
`;
const mem = algo.parseMemInfoSections(MEM_SAMPLE, MEM_INFO);
check('totalPss 取 TOTAL 行 → 82 MB', mem.totalPss === 82, mem.totalPss);
check('nativeHeap 取汇总表 1360K → 1 MB（不是明细表 1901K → 2 MB）',
  mem.nativeHeap === 1, mem.nativeHeap);
check('javaHeap 取汇总表 9452K → 9 MB', mem.javaHeap === 9, mem.javaHeap);
check('system 取汇总表 56872K → 56 MB', mem.system === 56, mem.system);
check('code / graphics 同样来自汇总表',
  mem.code === 10 && mem.graphics === 3, { code: mem.code, graphics: mem.graphics });
check('dalvikHeap 作为 legacy 别名与 javaHeap 一致', mem.dalvikHeap === mem.javaHeap);
check('整机内存 8000000/3000000 KB → 7813 / 2930 MB',
  mem.memTotalMB === 7813 && mem.memAvailableMB === 2930,
  { total: mem.memTotalMB, avail: mem.memAvailableMB });

// 老 ROM 只有明细表：回退不能返回 null
const MEM_OLD = `  Native Heap     1901     1360      532    39900     2336
  Dalvik Heap    11258     8196      292      189    15344
        TOTAL    84024    15988    11164    43238   140012
`;
const memOld = algo.parseMemInfoSections(MEM_OLD, '');
check('无 App Summary 时回退明细表（nativeHeap=2 / javaHeap=11）',
  memOld.nativeHeap === 2 && memOld.javaHeap === 11,
  { nativeHeap: memOld.nativeHeap, javaHeap: memOld.javaHeap });
check('整机内存读不到时是 null，不写 0 MB',
  memOld.memTotalMB === null && memOld.memAvailableMB === null);

// ─── ③ 电池：一次命令解析 + 单位三态 ─────────────────────────────────────────
console.log('\n-- ③ 电池：合并输出解析与单位判定 --');
const bat = algo.parseBatteryDump;

// 本机实测：voltage 4(V)、temperature 290(十分度)、current_max 2000(mA)、current_now -227(mA)
const BAT_LOCAL = `Current Battery Service state:
  level: 100
  voltage: 4
  temperature: 290
---CMAX---
2000
---CUA---

---CNOW---
-227
`;
const b1 = bat(BAT_LOCAL);
check('level=100 / voltage 4V → 4000 mV', b1.level === 100 && b1.voltage === 4000,
  { level: b1.level, voltage: b1.voltage });
check('temperature 290 十分度 → 29°C', b1.temperature === 29, b1.temperature);
check('current_max=2000 判为 mA，current_now=-227 原样保留',
  b1.currentNow === -227, b1.currentNow);
check('power = |−227 mA| × 4000 mV / 1000 → 908 mW', b1.power === 908, b1.power);

// AOSP：µA 量级
const BAT_AOSP = `  level: 55
  voltage: 4200
  temperature: 335
  current now: -227000
---CMAX---
2000000
---CUA---

---CNOW---
-227000
`;
const b2 = bat(BAT_AOSP);
check('AOSP 的 µA 电流 → -227 mA', b2.currentNow === -227, b2.currentNow);
check('dumpsys 的 "current now:" 优先于 sysfs', b2.currentNow === -227);

// 行首锚点：不能把 "Max charging voltage" 当电池电压
const BAT_TRAP = `  Max charging voltage: 5000000
  level: 80
  voltage: 4100
  temperature: 300
---CMAX---

---CUA---

---CNOW---
`;
const b3 = bat(BAT_TRAP);
check('"Max charging voltage: 5000000" 不会被当成电池电压',
  b3.voltage === 4100, b3.voltage);
check('cmax 缺失时按数值兜底：|−50| 不超万 → mA', bat(
  '  level: 1\n  voltage: 4000\n---CMAX---\n\n---CUA---\n\n---CNOW---\n-50\n').currentNow === -50);

// ─── ④ 网络接口白名单（漏采） ────────────────────────────────────────────────
console.log('\n-- ④ 网络接口：464xlat 的 clat / v4- 不能漏 --');
const ok = ['wlan0', 'wlan1', 'rmnet_data0', 'rmnet0', 'ccmni13', 'ccmni0',
            'clat4', 'v4-wlan0', 'eth0', 'rndis0'];
const bad = ['lo', 'ifb0', 'ifb1', 'dummy0', 'sit0', 'tunl0', 'ip6tnl0',
             'ip6_vti0', 'ip_vti0', 'ap0', 'p2p0', ''];
check('物理/蜂窝/转换接口全部计入',
  ok.every((n) => algo.isMeteredIface(n)), ok.filter((n) => !algo.isMeteredIface(n)));
check('回环与隧道全部排除',
  bad.every((n) => !algo.isMeteredIface(n)), bad.filter((n) => algo.isMeteredIface(n)));
check('带前导空格也能识别', algo.isMeteredIface('  wlan0 ') === true);

// ─── ⑤ 源码级：同一 tick 不重复执行同一采集源 ────────────────────────────────
console.log('\n-- ⑤ 重复采集：同一 tick 每条命令只执行一次 --');
const adbSrc = readSrc('_client_src/app/src/adb.js');
const collectorSrc = readSrc('_client_src/app/src/collector.js');

check('采集主循环不再分别调 getCpuStats / getCpuCoreStats',
  !/jobs\.push\(\['cpu',\s*ADB\.getCpuStats/.test(collectorSrc)
  && !/jobs\.push\(\['cores',\s*ADB\.getCpuCoreStats/.test(collectorSrc));
check('采集主循环改用一次性 getCpuSnapshot',
  /jobs\.push\(\['cpu',\s*ADB\.getCpuSnapshot/.test(collectorSrc));
check('getCpuSnapshot 一次 shell 同时取 /proc/stat 与 /proc/<pid>/stat',
  /function getCpuSnapshot/.test(adbSrc)
  && /---PIDSTAT---/.test(adbSrc) && /---FREQ---/.test(adbSrc));
check('getCpuCoreStats 只是 getCpuSnapshot 的包装（不再独立读 /proc/stat）',
  /async function getCpuCoreStats\(deviceId\) \{\s*const s = await getCpuSnapshot/.test(adbSrc));

check('thermal 支持 noBatteryRead，避免与 battery 重复跑 dumpsys battery',
  /noBatteryRead/.test(adbSrc));
check('采集器在采了电池时才跳过 thermal 的电池兜底',
  /noBatteryRead:\s*!!mc\.battery/.test(collectorSrc));
check('温度兜底复用同一 tick 的电池读数（不再让 thermal 自己再读一次）',
  /thermalMainRaw != null \? thermalMainRaw : batTemp/.test(collectorSrc));

check('FPS 的 framestats 分支复用同一份输出算总帧增量',
  /gfxTotalDelta\(out,\s*key,\s*now,\s*log\)/.test(adbSrc));
const gfxinfoCalls = (adbSrc.match(/adbShell\(deviceId, `dumpsys gfxinfo/g) || []).length;
check('dumpsys gfxinfo 的实际调用只剩「framestats + 异常兜底」两处',
  gfxinfoCalls === 2, gfxinfoCalls);
check('电池采集只下发一条 shell（含三个节点标记）',
  /---CMAX---/.test(adbSrc) && /---CUA---/.test(adbSrc) && /---CNOW---/.test(adbSrc)
  && !/await adbShell\(deviceId, 'cat \/sys\/class\/power_supply\/battery\/current_max/.test(adbSrc));
check('内存采集只下发一条 shell（meminfo + /proc/meminfo）',
  /---PROCMEM---/.test(adbSrc)
  && !/await adbShell\(deviceId, 'cat \/proc\/meminfo/.test(adbSrc));

// ─── ⑥ 源码级：温度主值不得回退结温 ──────────────────────────────────────────
console.log('\n-- ⑥ 温度主值来源：结温不得冒充机身温度 --');
check('parseThermalService 的 main 取 BATTERY → SKIN → body，不给 CPU',
  /if \(battery\)\s*\{ main = battery\.value/.test(adbSrc)
  && /else\s*\{\s*main = null;\s*source = 'die';/.test(adbSrc.replace(/\n/g, ' ')));
check('采集器写入的 temperature 只来自 thermalMain（或电池兜底）',
  /data\.temperature = thermalMain;/.test(collectorSrc));

console.log('\n──────────────────────────────────────────');
console.log(`  ${pass} PASS / ${fail} FAIL`);
if (fails.length) console.log('  失败项:\n   - ' + fails.join('\n   - '));
console.log('──────────────────────────────────────────\n');
process.exit(fail ? 1 : 0);
