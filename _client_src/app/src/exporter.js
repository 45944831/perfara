'use strict';

function toCSV(history) {
  const headers = [
    'timestamp', 'time',
    'sysCpu', 'procCpu',
    'totalPss_MB', 'nativeHeap_MB', 'javaHeap_MB', 'code_MB', 'stack_MB', 'graphics_MB', 'privateOther_MB', 'system_MB',
    'fps', 'jank', 'bigJank', 'jankRate_%',
    'rxKBps', 'txKBps',
    'batteryLevel', 'batteryVoltage', 'batteryTemp', 'currentNow_mA', 'power_mW',
    'deviceTemp', 'gpu',
    'pid',
  ];

  // 采集参数里被移除的指标没有字段：一律留空（不报错、不补 0，避免误导）
  const rows = history.map((d) => {
    const cpu = d.cpu || {};
    const mem = d.mem || {};
    const net = d.net || {};
    const bat = d.battery || {};
    const v = (x) => (x == null ? '' : x);
    return [
      d.timestamp, d.time,
      v(cpu.sysCpu), v(cpu.procCpu),
      v(mem.totalPss), v(mem.nativeHeap), v(mem.javaHeap ?? mem.dalvikHeap),
      v(mem.code), v(mem.stack), v(mem.graphics), v(mem.privateOther), v(mem.system),
      v(d.fps), v(d.jank), v(d.bigJank), v(d.jankRate),
      v(net.rxKBps), v(net.txKBps),
      v(bat.level), v(bat.voltage), v(bat.temperature), v(bat.currentNow), v(bat.power),
      v(d.temperature), v(d.gpu),
      d.pid || '',
    ].join(',');
  });

  return [headers.join(','), ...rows].join('\r\n');
}

function toJSON(history) {
  return JSON.stringify(history, null, 2);
}

module.exports = { toCSV, toJSON };
