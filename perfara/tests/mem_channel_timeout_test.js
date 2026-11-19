'use strict';

/**
 * mem 重通道超时熔断守卫（离线，不需要真机）。
 *
 * 背景（2026-11-19 采集参数优化 P2a）：
 *   真机报告实证——mem 通道 p95=286ms / max=383ms，是七条采集通道里毛刺最大的；
 *   getMemInfo 原本吃 10s 的 DUMPSYS_TIMEOUT_MS，设备抖动时能把整拍 tick 拖出采样周期。
 *
 * 策略：
 *   getMemInfo 接受可选 timeoutMs；采集端对 full（重）读取传熔断预算 MEM_FULL_TIMEOUT_MS。
 *   超时 → adb 层 kill 子进程并 reject → getMemInfo catch 返回全 null
 *   → collector 的 _collectMem 沿用上次缓存 PSS 并标 src:'lite'（口径不变）。
 *
 * 用法: node perfara/tests/mem_channel_timeout_test.js
 */
const fs = require('fs');
const path = require('path');
const ADB = require(path.resolve(__dirname, '..', '..', '_client_src', 'app', 'src', 'adb.js'));
const C = require(path.resolve(__dirname, '..', '..', '_client_src', 'app', 'src', 'collector.js'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log(' FAIL  ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : '')); }
}

console.log('\n===== mem 重通道超时熔断（P2a） =====\n');

const resolve = ADB.__algo.resolveMemInfoTimeout;
check('导出 resolveMemInfoTimeout 为函数', typeof resolve === 'function');

// 非法/缺省 → 回落默认值（DUMPSYS_TIMEOUT_MS=10000）
check('undefined 回落到默认值 10000', resolve(undefined) === 10000, resolve(undefined));
check('null 回落到默认值 10000', resolve(null) === 10000, resolve(null));
check('0 回落到默认值 10000', resolve(0) === 10000, resolve(0));
check('负数回落到默认值 10000', resolve(-5) === 10000, resolve(-5));
check('NaN 回落到默认值 10000', resolve(NaN) === 10000, resolve(NaN));
check('Infinity 回落到默认值 10000', resolve(Infinity) === 10000, resolve(Infinity));
check('字符串 "500" 非法，回落默认值', resolve('500') === 10000, resolve('500'));
// 合法值透传
check('合法预算 1200 原样透传', resolve(1200) === 1200, resolve(1200));
check('合法预算 80 原样透传', resolve(80) === 80, resolve(80));

// 熔断预算合理性：远高于实测 p95(286)/max(383)，避免误杀正常采样
const budget = C.MEM_FULL_TIMEOUT_MS;
check('熔断预算已导出且为正数', typeof budget === 'number' && budget > 0, budget);
check('熔断预算 > 实测 max 383ms（不误杀正常 full 采样）', budget > 383, budget);
check('熔断预算 < 默认 DUMPSYS 10s（真正起熔断作用）', budget < 10000, budget);

// 源码守卫：collector 把预算传进 full 读取；回退分支保留
const csrc = fs.readFileSync(path.resolve(__dirname, '..', '..', '_client_src', 'app', 'src', 'collector.js'), 'utf8');
check('collector full 读取传入 MEM_FULL_TIMEOUT_MS',
  /ADB\.getMemInfo\(this\.deviceId, this\.packageName, this\._pid, MEM_FULL_TIMEOUT_MS\)/.test(csrc));
check('getMemInfo 失败后沿用缓存分支仍在（src: lite）',
  /this\._memFullCache[\s\S]{0,200}src:\s*'lite'/.test(csrc));
check('超时注释标注 P2a', /P2a/.test(csrc));

// adb 源码守卫：getMemInfo 使用 resolveMemInfoTimeout 且 catch 返回全 null
const asrc = fs.readFileSync(path.resolve(__dirname, '..', '..', '_client_src', 'app', 'src', 'adb.js'), 'utf8');
const getMemBody = asrc.slice(asrc.indexOf('async function getMemInfo('), asrc.indexOf('// ─── 采集前健康检查'));
check('getMemInfo 用 resolveMemInfoTimeout 计算预算', /const budget = resolveMemInfoTimeout\(timeoutMs\)/.test(getMemBody));
check('getMemInfo catch 返回全 null（totalPss: null）', /totalPss:\s*null/.test(getMemBody));

console.log('\n===== 结果: ' + pass + ' PASS / ' + fail + ' FAIL =====\n');
process.exitCode = fail ? 1 : 0;
