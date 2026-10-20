'use strict';

/** 将 { name, brand, system } 拼成一行展示文案；缺省字段不出现 */
window.formatDeviceInfoText = function formatDeviceInfoText(info) {
  if (!info || typeof info !== 'object') return '';
  const parts = [];
  if (info.name) parts.push(`名称：${info.name}`);
  if (info.brand) parts.push(`品牌：${info.brand}`);
  if (info.system) parts.push(`系统：${info.system}`);
  return parts.join('　');
};
