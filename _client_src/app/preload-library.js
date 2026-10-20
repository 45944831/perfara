/**
 * 报告库窗口专用 preload。
 *
 * 报告库页面（reports/library.html）是 file:// 静态页，默认没有任何文件系统权限，
 * 因此「删除报告」必须经由主进程完成。这里只暴露最小必要接口，
 * 页面通过 window.reportLib 判断当前是否具备删除能力。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reportLib', {
  /** 删除若干份报告；返回 { ok, removedIds, failed } */
  deleteReports: (ids) => ipcRenderer.invoke('library-delete-reports', ids),
  /** 用系统浏览器打开某份报告的详情页（perf.html?r=<id>） */
  openReport: (id) => ipcRenderer.invoke('library-open-report', id),
  /** 在系统文件管理器中打开该报告的存放位置（文件存在则选中该文件） */
  openReportLocation: (id) => ipcRenderer.invoke('library-open-report-location', id),
  /** 把这份报告打包成一个自包含的单文件 HTML（数据+图表库全内联），可直接分享 */
  exportSharedReport: (id) => ipcRenderer.invoke('library-export-shared-report', id),
  /** 把当前对比（多条报告）整体打包成一个自包含的单文件 HTML，可直接分享 */
  exportCompareReport: (ids) => ipcRenderer.invoke('library-export-compare-report', ids),
  /** 当前报告库所在目录（用于提示文案，失败返回空串） */
  historyDir: () => ipcRenderer.invoke('library-history-dir'),
});
