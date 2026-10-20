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
| `perfara/tests/` | 回归测试脚本（13 套，属代码资产，禁止清理） |
| `tools/` | 构建与维护脚本（见下） |
| `build/` | 启动器 PyInstaller 构建配置（`.spec`） |

## 工具脚本

| 脚本 | 用途 |
| --- | --- |
| `tools/build_app.py` | 打包 `app.asar`，带瘦身规则（剔除 echarts 冗余、调试镜像等，77MB → 4.2MB） |
| `tools/asar_tool.py` | asar 解包 / 打包 / 列文件 |
| `tools/make_release_zip.py` | 生成发布包（`changes` 改动文件 / `full` 完整便携版） |
| `tools/cleanup_workspace.py` | 清理备份副本与构建中间产物（默认 `--dry-run`，`--apply` 才真删；`perfara/tests` 等回归资产在 PROTECTED 白名单内，永不清理） |
| `tools/inject_metric_info.py` | 报告页指标说明注入 |
| `tools/optimize_report_readability.py` | 报告可读性样式优化 |

## 便携版下载

`release/Perfara便携版_完整_20261020.zip`（224MB，通过 **Git LFS** 存储）

- 在 GitHub 打开该文件，点右上角 **Download raw file** 即可拿到完整压缩包
  （LFS 文件请勿用 `raw.githubusercontent.com` 直链，那会拿到指针文本）
- 解压后双击 **`Perfara离线版.exe`** 即可运行，无需安装，无需 Python/Node 环境
- 含：Electron 运行时、`app.asar`、iOS 工具链、adb、报告模板、启动器

> 提示：LFS 文件需要 `git lfs install` 后 clone 才会自动拉取；
> 只想看代码可 `GIT_LFS_SKIP_SMUDGE=1 git clone`，跳过 224MB 下载。

## 说明

- **二进制产物不在仓库内**：Electron 运行时（`Perfara.exe` 169MB、dll、pak、`app.asar`）、
  Python 虚拟环境、便携版副本均通过 `.gitignore` 排除——可执行文件需用
  Electron 官方包自行放置，`app.asar` 用 `tools/build_app.py` 生成。
- 便携版 exe 超 GitHub 单文件 100MB 限制，因此以 zip 形式放 `release/` 并用 LFS 存储。
- 报告模板（`perf.html` / `library.html`）在仓库内，修改后即时生效，无需重新打包。
- 采集到的历史报告数据（`reports/history/`）属于本地数据，不入库。
- 回归测试用 `playwright-core` + 本机 Edge 无头跑，见 `perfara/tests/` 下各脚本的头部说明。
