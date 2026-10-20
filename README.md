# Perfara

安卓 & iOS 性能测试工具，功能类似 PerfDog，并补充了 iOS 渲染管线性能数据。
支持 PC 端采集、多份报告对比、报告分享与在线看板。

## 目录结构

| 目录 | 说明 |
| --- | --- |
| `_client_src/` | Electron 采集客户端源码（main.js / renderer / src 采集器） |
| `perfara/backend/` | 服务端 API（FastAPI） |
| `perfara/frontend/` | Web 看板前端（Vue + Vite） |
| `perfara/server/` | 服务端配套资源 |
| `perfara/collector/resources/reports/` | 本地报告模板（perf.html / library.html，入库） |
| `tools/` | 构建与维护脚本（见下） |
| `build/` | 启动器 PyInstaller 构建配置（`.spec`） |

## 工具脚本

| 脚本 | 用途 |
| --- | --- |
| `tools/build_app.py` | 打包 `app.asar`，带瘦身规则（剔除 echarts 冗余、调试镜像等，77MB → 4.2MB） |
| `tools/asar_tool.py` | asar 解包 / 打包 / 列文件 |
| `tools/make_release_zip.py` | 生成发布包（`changes` 改动文件 / `full` 完整便携版） |
| `tools/cleanup_workspace.py` | 清理备份副本与构建中间产物（支持 `--dry-run`） |
| `tools/inject_metric_info.py` | 报告页指标说明注入 |
| `tools/optimize_report_readability.py` | 报告可读性样式优化 |

## 说明

- **二进制产物不在仓库内**：Electron 运行时（`Perfara.exe` 169MB、dll、pak、`app.asar`）、
  Python 虚拟环境、便携版副本均通过 `.gitignore` 排除——可执行文件需用
  Electron 官方包自行放置，`app.asar` 用 `tools/build_app.py` 生成。
- 报告模板（`perf.html` / `library.html`）在仓库内，修改后即时生效，无需重新打包。
- 采集到的历史报告数据（`reports/history/`）属于本地数据，不入库。
