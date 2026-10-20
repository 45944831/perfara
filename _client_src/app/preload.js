const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('perfAPI', {
  getAppName: () => ipcRenderer.invoke('get-app-name'),
  getConfigOut: () => ipcRenderer.invoke('get-config-out'),
  getMachineUid: () => ipcRenderer.invoke('get-machine-uid'),
  activationGetState: () => ipcRenderer.invoke('activation-get-state'),
  activationSubmit: (code) => ipcRenderer.invoke('activation-submit', code),
  activationOpenFetchUrl: () => ipcRenderer.invoke('activation-open-fetch-url'),
  onActivationRefresh: (callback) => {
    ipcRenderer.on('activation-refresh', () => callback());
  },

  trialBudgetGet: () => ipcRenderer.invoke('trial-budget-get'),
  onTrialBudgetTick: (callback) => {
    ipcRenderer.on('trial-budget-tick', (_e, payload) => callback(payload));
  },
  onTrialBudgetExhausted: (callback) => {
    ipcRenderer.on('trial-budget-exhausted', () => callback());
  },
  onTrialBudgetChanged: (callback) => {
    ipcRenderer.on('trial-budget-changed', (_e, payload) => callback(payload));
  },

  getReportsPathInfo: () => ipcRenderer.invoke('get-reports-path-info'),
  openLocalReport: (fileName) => ipcRenderer.invoke('open-local-report', fileName),

  getDevices: () => ipcRenderer.invoke('get-devices'),
  getAndroidDeviceInfo: (deviceId) => ipcRenderer.invoke('get-android-device-info', deviceId),
  getIosDeviceInfo: (udid) => ipcRenderer.invoke('get-ios-device-info', udid),
  connectWifi: (ipPort) => ipcRenderer.invoke('connect-wifi', ipPort),
  autoConnectWifi: (deviceId) => ipcRenderer.invoke('auto-connect-wifi', deviceId),
  disconnectWifi: (ipPort) => ipcRenderer.invoke('disconnect-wifi', ipPort),
  getPackages: (deviceId) => ipcRenderer.invoke('get-packages', deviceId),
  androidIsPerfaraInstalled: (deviceId) =>
    ipcRenderer.invoke('android-is-perfara-installed', deviceId),
  androidPreparePackages: (deviceId) =>
    ipcRenderer.invoke('android-prepare-packages', deviceId),
  getPid: (deviceId, packageName) => ipcRenderer.invoke('get-pid', deviceId, packageName),
  startCollect: (deviceId, packageName, deviceLabel, appLabel, metricConfig) =>
    ipcRenderer.invoke('start-collect', deviceId, packageName, deviceLabel, appLabel, metricConfig),
  stopCollect: () => ipcRenderer.invoke('stop-collect'),
  androidClearHistory: () => ipcRenderer.invoke('android-clear-history'),
  clearReportShots: () => ipcRenderer.invoke('clear-report-shots'),
  exportData: (format) => ipcRenderer.invoke('export-data', format),
  setTags: (category, tags) => ipcRenderer.invoke('set-tags', category, tags),

  onPerfData: (callback) => {
    ipcRenderer.on('perf-data', (_event, data) => callback(data));
  },
  onCollectLog: (callback) => {
    ipcRenderer.on('collect-log', (_event, msg) => callback(msg));
  },
  onCollectError: (callback) => {
    ipcRenderer.on('collect-error', (_event, msg) => callback(msg));
  },
  onCollectStopped: (callback) => {
    ipcRenderer.on('collect-stopped', (_event, payload) => callback(payload));
  },
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('perf-data');
    ipcRenderer.removeAllListeners('collect-log');
    ipcRenderer.removeAllListeners('collect-error');
    ipcRenderer.removeAllListeners('collect-stopped');
  },

  // ── iOS API ────────────────────────────────────────────────────────────────
  iosGetDevices:    ()           => ipcRenderer.invoke('ios-get-devices'),
  iosGetApps:       ()           => ipcRenderer.invoke('ios-get-apps'),
  iosStartCollect:  (bundleId, execName, appName, udid, metricConfig) =>
    ipcRenderer.invoke('ios-start-collect', bundleId, execName, appName, udid, metricConfig),
  iosStopCollect:   ()           => ipcRenderer.invoke('ios-stop-collect'),
  iosClearHistory:  ()           => ipcRenderer.invoke('ios-clear-history'),
  iosExportData:    (format)     => ipcRenderer.invoke('ios-export-data', format),
  iosSetTags:       (tags)       => ipcRenderer.invoke('set-tags', 'ios', tags),

  onIosPerfData: (callback) => {
    ipcRenderer.on('ios-perf-data', (_event, data) => callback(data));
  },
  onIosLog: (callback) => {
    ipcRenderer.on('ios-collect-log', (_event, msg) => callback(msg));
  },
  onIosError: (callback) => {
    ipcRenderer.on('ios-collect-error', (_event, msg) => callback(msg));
  },
  onIosCollectStopped: (callback) => {
    ipcRenderer.on('ios-collect-stopped', (_event, payload) => callback(payload));
  },
  removeIosListeners: () => {
    ipcRenderer.removeAllListeners('ios-perf-data');
    ipcRenderer.removeAllListeners('ios-collect-log');
    ipcRenderer.removeAllListeners('ios-collect-error');
    ipcRenderer.removeAllListeners('ios-collect-stopped');
  },

  // ── iOS GPU API ────────────────────────────────────────────────────────────
  iosGpuStartCollect: (meta) => ipcRenderer.invoke('ios-gpu-start-collect', meta),
  iosGpuStopCollect:  ()           => ipcRenderer.invoke('ios-gpu-stop-collect'),
  iosGpuClearHistory: ()           => ipcRenderer.invoke('ios-gpu-clear-history'),
  iosGpuExportData:   (format)     => ipcRenderer.invoke('ios-gpu-export-data', format),
  iosGpuSetTags:      (tags)       => ipcRenderer.invoke('set-tags', 'ios_gpu', tags),

  onIosGpuData: (callback) => {
    ipcRenderer.on('ios-gpu-data', (_event, data) => callback(data));
  },
  onIosGpuDataBatch: (callback) => {
    ipcRenderer.on('ios-gpu-data-batch', (_event, batch) => callback(batch));
  },
  onIosGpuLog: (callback) => {
    ipcRenderer.on('ios-gpu-log', (_event, msg) => callback(msg));
  },
  onIosGpuError: (callback) => {
    ipcRenderer.on('ios-gpu-error', (_event, msg) => callback(msg));
  },
  removeIosGpuListeners: () => {
    ipcRenderer.removeAllListeners('ios-gpu-data');
    ipcRenderer.removeAllListeners('ios-gpu-data-batch');
    ipcRenderer.removeAllListeners('ios-gpu-log');
    ipcRenderer.removeAllListeners('ios-gpu-error');
  },

  // ── PC（本机进程）API ─────────────────────────────────────────────────────
  pcPickExe: () => ipcRenderer.invoke('pc-pick-exe'),
  pcStartCollect: (exePath, metricConfig) => ipcRenderer.invoke('pc-start-collect', exePath, metricConfig),
  pcStopCollect: () => ipcRenderer.invoke('pc-stop-collect'),
  pcClearHistory: () => ipcRenderer.invoke('pc-clear-history'),
  pcExportData: (format) => ipcRenderer.invoke('export-pc-data', format),
  pcSetTags: (tags) => ipcRenderer.invoke('set-tags', 'pc', tags),

  onPcPerfData: (callback) => {
    ipcRenderer.on('pc-perf-data', (_e, data) => callback(data));
  },
  onPcCollectLog: (callback) => {
    ipcRenderer.on('pc-collect-log', (_e, msg) => callback(msg));
  },
  onPcCollectError: (callback) => {
    ipcRenderer.on('pc-collect-error', (_e, msg) => callback(msg));
  },
  onPcCollectStopped: (callback) => {
    ipcRenderer.on('pc-collect-stopped', (_e, payload) => callback(payload));
  },
  removePcListeners: () => {
    ipcRenderer.removeAllListeners('pc-perf-data');
    ipcRenderer.removeAllListeners('pc-collect-log');
    ipcRenderer.removeAllListeners('pc-collect-error');
    ipcRenderer.removeAllListeners('pc-collect-stopped');
  },
});

