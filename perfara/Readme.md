# Perfara · 性能洞察平台  
# Perfara · Performance Insight Platform

---

## 中文

### 定位

**Perfara** 是一款**完全离线**的移动端与 PC 端性能测试工具，采集、看板、报告全在本机完成，不登录账号、不上传数据、不依赖云服务——可作为 **PerfDog 等商业工具的离线替代方案**：数据归你、链路透明，适合研发、测试与性能专项长期落地。

如需团队共享，同一套看板可直接部署到内网服务器（见下文「私有化部署」），无需改动代码。

### 本机看板（无需联网）

便携版启动后自动打开 **`http://127.0.0.1:8000/`**，列表、详情、趋势、对比全部在本机渲染，数据存于本地 SQLite。

> **iOS / PC / Android 全平台**共用同一套看板语义，按项目与场景筛选即可。

### 多平台支持

- **Android** — CPU / 内存 / FPS / 卡顿 / 网络 / 温度 / 功耗等  
- **iOS & iOS GPU** — 进程 CPU、内存、帧率、磁盘与线程相关指标、GPU 细分等  
- **PC** — 与移动端同一套看板语义，便于跨端对比  

采集端把 JSON 提交给本机看板后，由本地服务解析、渲染与分享。

### 界面预览（截图位于仓库 `docs/screenshots/`，均为本项目真实界面）

| 文件 | 说明 |
|------|------|
| `docs/screenshots/dashboard.png` | 本地看板：测试列表、场景标记与「复制 testid」 |
| `docs/screenshots/test-detail.png` | 测试详情：指标卡与整体统计（均值 / 峰值 / P98） |
| `docs/screenshots/report.png` | 报告页：关键指标 + 自动解读总结 |
| `docs/screenshots/report-charts.png` | 报告页：FPS / 卡顿 / 网络 / 温度多图联动 |
| `docs/screenshots/trends.png` | **趋势统计**：同场景多次测试的均值/峰值曲线，用于持续观测与防劣化 |

![本地看板](../docs/screenshots/dashboard.png)

![测试详情](../docs/screenshots/test-detail.png)

![报告页](../docs/screenshots/report.png)

![报告页曲线](../docs/screenshots/report-charts.png)

![趋势统计与防劣化示意](../docs/screenshots/trends.png)

*上图：在「趋势统计」中选定项目、平台、**场景标记**与时间范围后，可对齐同一场景的多轮测试，观察 FPS、CPU、内存等随时间的走势，支撑版本对比与劣化预警。*

### 核心能力

1. **本地看板** — 浏览器内完成列表、详情、图表与指标汇总，支持按 UID 管理数据范围；可只跑本机，也可部署到内网供团队共用。  
2. **竞品比对** — 在比对页填入 **两个 testid**，即可并排对比关键指标，快速定位差异。  
3. **趋势统计与自动防劣化** — 为用例打上**场景标记**后，在「趋势统计」中按场景筛选；每次同场景测试在时间轴上形成趋势，便于发现性能回退与波动。  
4. **开放数据路径** — 支持自建服务、自主上传与导出；详情页可复制 testid 用于分享与集成。

### 采集健康检查与自动熔断

点「开始采集」前，采集端会先用数秒完成四项**只读**检查——设备响应、整机可用内存、GPU 负载、屏幕/锁屏状态；任一项不健康都会**立即**给出可操作的原因，而不是让界面干等二十秒才报错：

| 检查项 | 不通过时的含义 |
|--------|----------------|
| 设备响应 | adb 通道不通：设备离线、USB 松动、调试授权过期 |
| 可用内存 | 低于 200MB 判失败（系统随时会杀掉目标进程，采了也白采）；低于 600MB 警告 |
| GPU 负载 | 高于 95% 警告：可能有其他应用正占用 GPU，测到的不是目标应用的负载 |
| 屏幕 / 锁屏 | 熄屏会自动替您点亮；点不亮或锁屏遮挡时会明确提示（灭屏时没有可见渲染层，帧数据全废） |

采集中另有**超时熔断**：连续两轮采样超过 0.12 秒未完成即自动停止并说明原因，避免设备卡顿被传导成 PC 端「点了没反应、曲线一片空白」。

### 客户端下载与采集

- **采集端 / 客户端工具说明（飞书文档）**  
  [https://my.feishu.cn/wiki/C7ClwzJvii4lCXk7e1AcWGEInSc?from=from_copylink](https://my.feishu.cn/wiki/C7ClwzJvii4lCXk7e1AcWGEInSc?from=from_copylink)

下载后按文档连接自有 **Data / Web** 服务即可上传；数据可在看板中浏览、管理与下载（具体以客户端与接口说明为准）。

### 私有化部署（服务端）

1. **依赖**：Python 3，安装 `requirements.txt`。  
2. **python需要大于python3.8**：


3. **启动（二选一）**

```bash
# 默认 127.0.0.1:8000（仅本机）
uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

或使用项目根目录 **`serve.py`**（适合 Linux 一键启动，路径与数据库按项目根解析）：

```bash
# 修改端口示例（Windows / Linux 通用）[推荐] ，或者取serve中改端口和IP
set WEBPERF_PORT=8099
python serve.py
```

```bash
# Linux / macOS
export WEBPERF_PORT=8099
# 服务无鉴权，默认只听本机；确需局域网访问再显式打开下一行
# export WEBPERF_HOST=0.0.0.0
python3 serve.py
```

| 环境变量 | 说明 |
|----------|------|
| `WEBPERF_HOST` | 监听地址，默认 `127.0.0.1`（服务无鉴权，仅本机；局域网需显式设为 `0.0.0.0`） |
| `WEBPERF_PORT` | 监听端口，默认 `8000` |
| `WEB_PERF_DB` | SQLite 数据库文件绝对路径；未设置时默认为 `<项目根>/data/webperf.db` |

浏览器访问 `http://<主机>:<端口>/`；API 为同源 `/api/*`。更完整的接口与上传格式见仓库内 **`README.md`**。

### 便携式 EXE（Windows 免安装）

不需要 Python 环境，单个 exe 双击即用（内置后端 + 前端页面 + 图表配置）。

```bash
# 打包（需本机装过 Python 3.9+；Windows 双击 build_exe.bat 亦可）
pip install -r requirements.txt pyinstaller
pyinstaller perfara.spec --noconfirm --clean
# 产物：dist/Perfara.exe
```

使用：

| 操作 | 说明 |
|------|------|
| 双击 `Perfara.exe` | 启动服务并自动打开浏览器（默认 `http://127.0.0.1:8000/`） |
| `Perfara.exe --port 8099` | 指定端口；端口被占用时自动顺延 |
| `Perfara.exe --host 0.0.0.0` | 允许局域网访问（默认仅本机） |
| `Perfara.exe --no-browser` | 不自动打开浏览器 |
| `Perfara.exe --data-dir D:\perfara-data` | 指定数据目录 |

- **数据位置**：exe 同目录的 `data/webperf.db`（首次运行自动初始化）与 `logs/app.log`；整个文件夹拷走即可迁移，升级 exe 不会覆盖已有数据。
- 启动后浏览器打开 `http://127.0.0.1:8000/?uid=perfara123` 可直接看演示数据；正式使用请换成自己的 UID。
- 关闭控制台窗口即停止服务。

### 私有化部署（采集端指向自有看板）

将采集客户端解压或安装后，编辑：

`resources/configout/config.js`

将其中 **开放 Data / Web 服务地址** 改为你方部署的看板根 URL（与浏览器访问地址一致，含协议与端口），保存后重启客户端，即可向自有环境上报数据。

### 开源与仓库

- **私有化 / 自建参考**： [https://github.com/codinghiker/perfara](https://github.com/codinghiker/perfara)

---

## English

### Positioning

**Perfara** is a **fully offline** performance testing tool for mobile and PC workloads: capture, dashboard, and reports all run locally—no account, no upload, no cloud dependency. It serves as an **offline alternative** to commercial tools like **PerfDog**: your data, your machine, a transparent pipeline. If a team needs to share results, the same dashboard can be deployed on an intranet server without code changes.

### Local dashboard (no network required)

After launching the portable build, the dashboard opens at **`http://127.0.0.1:8000/`**. Lists, details, trends, and comparisons render locally; data lives in a local SQLite file.

> **iOS / PC / Android** share the same dashboard semantics—filter by project and scenario.

### Multi-platform

- **Android** — CPU, memory, FPS, jank, network, thermal, power, and more  
- **iOS & iOS GPU** — Process CPU, memory, frame pacing, disk & scheduling-related metrics, GPU breakdowns  
- **PC** — Same dashboard semantics as mobile for cross-platform benchmarking  

Submit performance JSON to the local dashboard; the local service parses, charts, and shares results.

### Screenshots

All screenshots live in `docs/screenshots/` and come from this project's real UI:

| File | Description |
|------|-------------|
| `docs/screenshots/dashboard.png` | Local dashboard: test list, scenario tags, "copy testid" |
| `docs/screenshots/test-detail.png` | Test detail: metric cards and mean / peak / P98 table |
| `docs/screenshots/report.png` | Report: key metrics plus automatic diagnosis summary |
| `docs/screenshots/report-charts.png` | Report: FPS, jank, network and thermal charts |
| `docs/screenshots/trends.png` | **Trends**: mean vs peak curves across runs for the same scenario |

![Local dashboard](../docs/screenshots/dashboard.png)

![Test detail](../docs/screenshots/test-detail.png)

![Report](../docs/screenshots/report.png)

![Report charts](../docs/screenshots/report-charts.png)

![Trend statistics & regression awareness](../docs/screenshots/trends.png)

*Select project, platform, **scenario tag**, and date range under **Trends** to align multiple runs of the same scenario and track FPS, CPU, memory over time—ideal for release comparison and anti-regression.*

### Highlights

1. **Local dashboard** — Lists, details, charts, and summaries in the browser; UID-scoped data access. Runs on one machine or on an intranet server.  
2. **Competitor / A-B compare** — Enter **two `testid` values** on the compare page for side-by-side metrics.  
3. **Trends & anti-degradation** — Tag scenarios on each run; filter by scenario in **Trends** to see evolution and catch performance drift early.  
4. **Open data path** — Self-host, upload, and export; copy `testid` from detail pages for sharing and automation.

### Pre-capture health check & auto circuit breaker

Before capture starts, the client spends a few seconds on four **read-only** checks — device responsiveness, free memory, GPU load, and screen/lock state. Any unhealthy item fails fast with an actionable reason instead of leaving the UI hanging. During capture, a watchdog stops the run if two consecutive sampling rounds exceed 0.12s, so a stuttering device never turns into "no response, empty chart".

### Client download & capture

- **Client tooling & capture guide (Feishu doc)**  
  [https://my.feishu.cn/wiki/C7ClwzJvii4lCXk7e1AcWGEInSc?from=from_copylink](https://my.feishu.cn/wiki/C7ClwzJvii4lCXk7e1AcWGEInSc?from=from_copylink)

Point the client at your own **Data / Web** endpoint after deployment. Browse, manage, and download data from the dashboard per your workflow.

### Self-hosting (server)

1. **Prerequisites**: Python 3 and `requirements.txt`.  



2. **Run (pick one)**

```bash
# local only by default
uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

Or use **`serve.py`** at the repo root:

```bash
set WEBPERF_PORT=8099
python serve.py
```

```bash
export WEBPERF_PORT=8099
# 服务无鉴权，默认只听本机；确需局域网访问再显式打开下一行
# export WEBPERF_HOST=0.0.0.0
python3 serve.py
```

| Variable | Purpose |
|----------|---------|
| `WEBPERF_HOST` | Bind address (default `127.0.0.1`; the server has no auth, use `0.0.0.0` only for trusted LANs) |
| `WEBPERF_PORT` | Port (default `8000`) |
| `WEB_PERF_DB` | Absolute path to SQLite file; default `<repo>/data/webperf.db` |

Open `http://<host>:<port>/`; APIs are same-origin under `/api/*`. See **`README.md`** in the repository for full API and upload schema.

### Portable EXE (Windows, no install)

Single-file executable bundling backend + built frontend + chart configs — no Python required.

```bash
pip install -r requirements.txt pyinstaller
pyinstaller perfara.spec --noconfirm --clean
# output: dist/Perfara.exe
```

- Double-click `Perfara.exe` → starts the server and opens `http://127.0.0.1:8000/`.
- Flags: `--port`, `--host 0.0.0.0` (LAN access), `--no-browser`, `--data-dir <path>`.
- Data lives next to the exe in `data/webperf.db` and `logs/app.log`; copy the whole folder to migrate, and upgrading the exe never overwrites existing data.
- Close the console window to stop the service.

### Self-hosting (client → your server)

Edit:

`resources/configout/config.js`

Set the **public Data / Web base URL** to your deployed dashboard root (scheme, host, and port). Restart the client to report to your environment.

### Repository

- **Reference / self-host**: [https://github.com/codinghiker/perfara](https://github.com/codinghiker/perfara)

---

*Perfara — Measure. Visualize. Stay in control.*
