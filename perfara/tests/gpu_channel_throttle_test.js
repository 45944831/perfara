'use strict';

/**
 * GPU 通道「无节点降频」守卫（离线，不需要真机）。
 *
 * 背景（2026-11-19 采集参数优化 P1）：
 *   真机报告实证——某机型 2883 拍 GPU busy 节点全部不可读（gpu 值 100% null），
 *   但采集端每拍无条件跑一次 adb GPU 探针（p50 69ms），是纯浪费。
 *
 * 策略（渐进、可逆，口径不变）：
 *   连续 GPU_NO_NODE_STREAK 拍探测都为 null → 降频到每 GPU_IDLE_PROBE_EVERY 拍探一次；
 *   降频期间任一拍探到非 null → 立即恢复全速。读不到仍写 null，不伪造 0。
 *
 * 为什么不用启动预检 probeGpuLoad 的 null 永久跳过：
 *   预检刻意跳过 kgsl_busy 且无 root 兜底，其 null 不代表整个采集期都读不到。
 *
 * 本测试直接从产品源码 require 真实导出的纯函数，避免测副本。
 *
 * 用法: node perfara/tests/gpu_channel_throttle_test.js
 */
const path = require('path');
const M = require(path.resolve(__dirname, '..', '..', '_client_src', 'app', 'src', 'collector.js'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log(' FAIL  ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : '')); }
}

const { gpuShouldProbe, gpuNextState, GPU_NO_NODE_STREAK, GPU_IDLE_PROBE_EVERY } = M;

console.log('\n===== GPU 通道无节点降频（P1） =====\n');

check('导出 gpuShouldProbe 为函数', typeof gpuShouldProbe === 'function');
check('导出 gpuNextState 为函数', typeof gpuNextState === 'function');
check('降频阈值 >= 3', GPU_NO_NODE_STREAK >= 3, GPU_NO_NODE_STREAK);
check('降频周期 > 阈值', GPU_IDLE_PROBE_EVERY > GPU_NO_NODE_STREAK,
  { streak: GPU_NO_NODE_STREAK, every: GPU_IDLE_PROBE_EVERY });

// ── 状态推进 ────────────────────────────────────────────────────────────────
check('null 推进 streak +1', gpuNextState({ nullStreak: 0 }, null).nullStreak === 1);
check('undefined 视为无节点 +1', gpuNextState({ nullStreak: 2 }, undefined).nullStreak === 3);
check('探测异常 NaN 视为无节点 +1', gpuNextState({ nullStreak: 1 }, NaN).nullStreak === 2);
check('数值 0 视为有效节点，重置 streak', gpuNextState({ nullStreak: 9 }, 0).nullStreak === 0);
check('正数视为有效节点，重置 streak', gpuNextState({ nullStreak: 9 }, 37.5).nullStreak === 0);
check('streak 有上限（不会无限增长）',
  gpuNextState({ nullStreak: 9999 }, null).nullStreak <= GPU_NO_NODE_STREAK + 1);
check('空 state 防御性读取', gpuNextState(null, null).nullStreak === 1);

// ── 探测调度 ────────────────────────────────────────────────────────────────
check('未达阈值时每拍都探（前 N 拍全探）',
  Array.from({ length: GPU_NO_NODE_STREAK }, (_, i) =>
    gpuShouldProbe({ nullStreak: i }, i + 1)).every(Boolean));

const idle = { nullStreak: GPU_NO_NODE_STREAK };
check('达阈值后首拍（tick=1）降频仍探一次（避免永久停探）', gpuShouldProbe(idle, 1) === true);
check('达阈值后非周期拍不探',
  gpuShouldProbe(idle, 2) === false && gpuShouldProbe(idle, GPU_IDLE_PROBE_EVERY) === false);
check('达阈值后每 GPU_IDLE_PROBE_EVERY 拍探一次',
  gpuShouldProbe(idle, GPU_IDLE_PROBE_EVERY + 1) === true
  && gpuShouldProbe(idle, 2 * GPU_IDLE_PROBE_EVERY + 1) === true);
check('空 state 默认全速探测', gpuShouldProbe(null, 1) === true);

// ── 端到端模拟：2883 拍全无节点 → 探测次数大幅下降；中途恢复 → 立即全速 ──
function simulate(totalTicks, valueAt) {
  let state = { nullStreak: 0 };
  let probes = 0;
  let stateAfterRecovery = null;
  for (let tick = 1; tick <= totalTicks; tick++) {
    if (gpuShouldProbe(state, tick)) {
      probes += 1;
      const v = valueAt ? valueAt(tick) : null;
      state = gpuNextState(state, v);
      if (v != null && stateAfterRecovery == null) stateAfterRecovery = state;
    }
  }
  return { probes, state, stateAfterRecovery };
}

const fullTicks = 2883;
const noNode = simulate(fullTicks);
check(`全无节点 ${fullTicks} 拍：探测次数 < 全速的 1/3`,
  noNode.probes < fullTicks / 3, noNode.probes);
check('全无节点：降频后维持在当前 streak（未复位）',
  noNode.state.nullStreak >= GPU_NO_NODE_STREAK);

// 恢复点必须落在真实探测拍上：降频后探测发生在 tick=1,21,41,...（(tick-1)%20===0）
const recoveryTick = GPU_IDLE_PROBE_EVERY + 1; // = 21
const recovered = simulate(fullTicks, (t) => (t === recoveryTick ? 12.5 : null));
check(`中途 t=${recoveryTick}（真实探测拍）探到值那一刻 streak 被重置为 0`,
  recovered.stateAfterRecovery && recovered.stateAfterRecovery.nullStreak === 0,
  recovered.stateAfterRecovery);
// 恢复后需再累积 N 个 null 才重新降频：这段全速窗口会多出几次探测
check('恢复后再降频，探测总数高于纯无节点场景', recovered.probes > noNode.probes,
  { recovered: recovered.probes, noNode: noNode.probes });

// ── 口径守卫：源码中 data.gpu 仍是 val.gpu ?? null（读不到写 null）──────────
const fs = require('fs');
const src = fs.readFileSync(path.resolve(__dirname, '..', '..', '_client_src', 'app', 'src', 'collector.js'), 'utf8');
check('GPU 写值口径未变：data.gpu = val.gpu ?? null', /data\.gpu\s*=\s*val\.gpu\s*\?\?\s*null/.test(src));
check('降频跳过时仍构造 probeGpu 决策变量', /const probeGpu\s*=/.test(src));
check('只有 probeGpu 为真才推进状态', /if \(probeGpu\) this\._gpuState\s*=/.test(src));

console.log('\n===== 结果: ' + pass + ' PASS / ' + fail + ' FAIL =====\n');
process.exitCode = fail ? 1 : 0;
