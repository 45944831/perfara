'use strict';

/**
 * 1.3 每采样点溯源元数据的**单一真值源**，四端共用。
 *
 * 形状刻意保持 4 个短字段（source / scope / quality / unitVersion）：
 * 长时采集最多 43200 点，多写一个字段就是几万次重复。
 * 更细的「某指标用了哪条通道」由 metric-schema.buildProvenance 在报告层聚合，
 * 不塞进每个采样点。
 *
 * 与报告层 provenance 的分工：
 *   - 这里回答「这一拍数据整体从哪来、是不是降级了」；
 *   - 那里回答「整个报告里每个指标的覆盖率、口径、质量」。
 */

const SCHEMA_VERSION = '9';  // v5: P-01 SmallJank 档梯统一（电影帧 1/2/3 倍递进）、
                             //      P-04 目标帧率设备自报优先 + 档位表同源
                             // v6（S-01 / S-02）：刷新率档位表 5 份副本统一为 11 档
                             //      （去 45，补 24/48/100/185，兜底改 ceil(p95)），
                             //      deviceTargetHz 改读 targetHz 并校验 targetSource；
                             //      TinyJank 逐帧通道基准由 avgMs 改为 p50（与直方图通道同源）
                             // v7（D-19 / D-20 / 非标档位）：刷新率改从 settings 优先读、
                             //      dumpsys 排除 mDefault* 框架默认；data.js 补 loading 段，
                             //      报告侧设备自报目标帧率真正生效；吸附加上界 1.10，
                             //      200Hz 面板不再被抬到 240 —— 目标帧率变了，跨版本不可直接比
                             // v8（D-21）：峰值刷新率受 supportedModes 面板能力硬上界约束，
                             //      60Hz 面板机不再被 framework vote 误报成 120Hz；
                             //      只动目标帧率派生项（达帧率/低帧占比），跨版本不可直接比
                             // v9（跨品牌温度）：thermalservice 归类改为 AOSP mType 强制枚举优先、
                             //      mName 别名兜底，兼容 Samsung AP/BAT/LRB/LRF/LRP、
                             //      小写 battery 与带空格命名；外壳多颗取平均，
                             //      排除 BCL 非温度虚拟量。主温度来源由 board 变 battery，
                             //      skinTemp/cpuTemp 由空变有值 —— 跨版本不可直接比

const PLATFORM_SOURCE = {
  android: 'adb-dumpsys',
  pc: 'psutil+PresentMon',
  ios: 'sysmon',
  ios_gpu: 'Apple-GPU-Counters',
};

/** 平台默认口径：iOS 的 sysmon 是进程级，PC 也是进程级；Android 优先按应用 */
const PLATFORM_SCOPE = {
  android: 'app',
  pc: 'process',
  ios: 'process',
  ios_gpu: 'gpu-pipeline',
};

/**
 * @param {string} platform 'android' | 'pc' | 'ios' | 'ios_gpu'
 * @param {Object} [sample] 本拍采样点，用来判断网络是否降级
 * @returns {{source:string, scope:string, quality:string, unitVersion:string}}
 */
function makeSampleMeta(platform, sample) {
  const p = String(platform || '').toLowerCase();
  const s = (sample && typeof sample === 'object') ? sample : {};
  const net = s.net;
  const netScope = net && net.netScope;
  // 网络回退到整机是唯一会让「整拍口径」降级的情形：
  // 其它指标读不到写 null，属于单指标缺失（报告层 quality=missing），不是整拍降级。
  const degraded = netScope === 'device';
  return {
    source: PLATFORM_SOURCE[p] || 'unknown',
    scope: degraded ? 'device' : (PLATFORM_SCOPE[p] || 'unknown'),
    quality: degraded ? 'degraded' : 'ok',
    unitVersion: SCHEMA_VERSION,
  };
}

/**
 * 汇总逐拍 meta（给 provenance.perSample）：验证「三端确实都带了」，
 * 也让报告能回答「有多少拍走过降级通道」。
 */
function summarizeSampleMeta(perf) {
  const rows = Array.isArray(perf) ? perf : [];
  const out = {
    samples: rows.length,
    withMeta: 0,
    platforms: Object.create(null),
    qualities: Object.create(null),
    degraded: 0,
    unitVersions: Object.create(null),
  };
  for (const r of rows) {
    const m = r && r.meta;
    if (!m || typeof m !== 'object') continue;
    out.withMeta++;
    out.platforms[m.source] = (out.platforms[m.source] || 0) + 1;
    out.qualities[m.quality] = (out.qualities[m.quality] || 0) + 1;
    out.unitVersions[m.unitVersion] = (out.unitVersions[m.unitVersion] || 0) + 1;
    if (m.quality === 'degraded') out.degraded++;
  }
  return out;
}

module.exports = {
  SCHEMA_VERSION, PLATFORM_SOURCE, PLATFORM_SCOPE,
  makeSampleMeta, summarizeSampleMeta,
};
