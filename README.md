# Perfara

![Platform](https://img.shields.io/badge/platform-Android%20%7C%20iOS%20%7C%20Windows-blue)
![Offline](https://img.shields.io/badge/offline-100%25%20local-success)
![Release](https://img.shields.io/github/v/release/45944831/perfara)

**一款完全离线的移动端 / PC 端性能测试工具**，对标 PerfDog，并补充了 iOS 渲染管线专项数据。

采集全程走本地 USB（或局域网 adb）直连设备，报告在看板与本地单文件 HTML 中查看——
**不登录账号、不上传数据、不依赖任何云服务**，装好即用，断网也能跑。

---

## 为什么是「离线」项目

| 环节 | 实现方式 |
| --- | --- |
| 采集 | `adb shell` / iOS 工具链直连设备，读取 `dumpsys`、`/proc`、`SurfaceFlinger --timestats`、`gfxinfo framestats` 等系统计数器 |
| 看板服务 | FastAPI 跑在 `127.0.0.1:8000`，只监听本机回环地址 |
| 数据存储 | SQLite（`perfara/data/webperf.db`）与本地 JSON，全部留在本机，随包携带、可整包拷走 |
| 报告 | 单文件 HTML，echarts 与数据全部内联，双击即可离线打开、微信/邮件直接转发 |
| 授权 | 无激活码、无联网校验、无试用时长限制 |
| 依赖 | 便携版自带 Electron 运行时、Python 运行时、adb、iOS 工具链，**无需安装 Python / Node** |

> 一句话：拔掉网线，功能一个都不少。

---

## 界面预览

> 以下截图均取自本项目真实运行界面（真机采集数据 + 本地看板 / 本地报告），未做美化替换。

**本地看板**：按日期范围、项目名称筛选测试记录，列表直接给出 FPS / CPU / 内存均值与场景标记；「复制 testid」拿到该条记录的 32 位 ID，用于详情链接与竞品比对

![本地看板](docs/screenshots/dashboard.png)

**测试详情**：FPS、Jank、进程 / 系统 CPU、物理内存、线程数、磁盘读写分卡展示，「整体统计」给出均值 / 峰值 / P98

![测试详情](docs/screenshots/test-detail.png)

**报告页**：关键指标卡 + 自动解读总结（综合评分、达帧率缺口、卡顿归因、风险与优化提示）

![报告页](docs/screenshots/report.png)

**报告页曲线**：FPS 与分级卡顿、网络上下行、GPU 温度、设备温度同屏联动

![报告页曲线](docs/screenshots/report-charts.png)

**趋势统计**：同场景多次测试的均值 / 峰值曲线，用于持续观测与防劣化

![趋势统计](docs/screenshots/trends.png)

---

## 功能特性

### 多平台采集

- **Android**：USB 直连或无线 adb，Android 6.0+（FPS 走 `SurfaceFlinger --timestats`，需 Android 11+，低版本自动回退 `gfxinfo`）；应用列表走 `pm list packages -3`，**不在手机上安装任何 APK**
- **iOS**：真机性能采集，含 CPU / 内存 / FPS / 网络 / 电量 / 温度；便携版自带 `ios.exe` + Python + `pymobiledevice3` 工具链，无需自行安装 Python
- **iOS GPU 专项**：渲染管线细分数据（GPU 占用、带宽、纹理、着色器、缓存、ALU 等）
- **PC**：按进程采集本机 CPU / 内存 / GPU / 磁盘 / 线程等指标

### 帧率与流畅度（PerfDog 同口径）

除了基础的 FPS / Jank，还提供整套派生指标：

| 指标 | 口径 |
| --- | --- |
| 达帧率 | 平均 FPS ÷ 目标帧率 |
| 均帧 Avg(FTime) | 各采样点帧间隔（1000/FPS）的均值 |
| 帧耗时标准差 / 方差 | Std(FTime) / Var(FTime) |
| 低帧占比 | FPS 低于目标 80% 的采样占比 |
| 1%Low | 帧耗时最长 1% 的均值折算帧率 |
| Drop | 相邻两点下降 > 8 帧的次数，按小时折算 |
| FPS≥目标 | 达到目标帧率的采样占比 |
| 稳帧范围 MedRange | 偏离中位数 ±20% 内的占比 |
| Stutter | 帧间隔 > 2×目标帧间隔的时间占比 |
| Jank / BigJank / SmallJank / TinyJank | 分级卡顿帧数，并给出**每 10 分钟**归一化次数 |

> 目标帧率由帧率分布 P95 自动吸附到 30/45/60/90/120/144/165，无需手工配置。

**加载阶段自动排除**：冷启动、换场景、读关卡时 FPS 会连续几秒掉到个位数，这段不代表游戏内表现。
上表所有帧率指标（含看板列表的「FPS 均值」）都会自动剔除这类「掉下去又能回来」的连续低帧段：

- 判定条件：连续 ≥3 个采样点低于目标帧率 50%，且之后 5 秒内回升到目标帧率 80% 以上
- 持续低帧**不会**被剔除——那是真实的性能不足，不能洗
- 剔除总量超过 40% 时整段作废，避免把坏数据算成好数据
- 曲线照常显示，被排除区间用琥珀色底纹标出，报告顶部写明「已排除 N 段共 Xs」
- 统计表保留 `FPS(全程)` 行给出原始均值，剔除前后都能看到

采集中取不到帧数据（应用不在前台 / 无渲染层 / 首帧未就绪）时写 `null` 而不是 `0`，避免被当成真实掉帧把 1%Low 打到 0。

### 系统指标

CPU（系统 / 进程 / 各核心使用率与频率 / **CPU 限频**）、内存（PSS、Java Heap、Native Heap、Code、Graphics…）、
网络上下行、GPU 使用率、GPU 温度、机身温度、电池（电量 / 电压 / 电流 / 功耗）、磁盘 I/O、
**上下文切换**、线程数、系统事件。

### 报告与看板

- **单文件离线报告**：`perf.html`，内联 echarts + 数据，可离线打开、转发、归档
- **报告库**：`library.html` 汇总历次报告，支持按设备 / 应用筛选
- **指标对比**：最多 6 份报告同屏对比（可保存为独立的自包含对比报告）。曲线按「分段并列」排布——每次运行独占一段、段间留间隙，段首圈号对应图例，横轴为该次运行已进行的秒数，悬停可看「哪次运行 · 第几秒」
- **指标说明内置**：每个指标的算法口径、单位、优劣方向都写在报告页里，看数不靠猜
- **采集参数可按组裁剪**：不要的指标组直接关掉，既省 adb 开销，报告里也不占版面
- **框选区间重算**：拖动图表区间，统计表按选区重新计算

---

## 本次新增（v2026.10.20）

- **移除 APK 依赖**：删除 `perfara.apk` 的安装与广播拉取应用列表逻辑，应用列表统一走 `pm list packages -3`。
  采集全部通过 USB + adb 读取，手机上不装任何东西，发布包减小 5.4MB。
- **修复打包版「点开始立即停止」**：`lazy()` 的相对路径基准由 `src/` 改为 app 根目录。
  原先 `./src/collector` 被解析成 `src/src/collector`，导致五个采集模块在打包版里全部加载失败，
  Android / iOS / PC 三条链路都起不来。
- **启动失败不再静默**：日志面板被隐藏时，失败原因也会直接显示在界面上。
- **无渲染层保护**：连续 5 秒 `fps=0` 时弹出提示条（应用不在前台 / 没有渲染层）；
  报告统计表补「帧率质量」空状态说明行，不再让整族帧率指标静默消失。
- **回归测试补强**：新增 `lazy_module` 相对路径用例（24 项）、`perf_html` 全 0 帧用例（19 项）、
  `report_serialize_bench` 序列化基准。

## 本次新增（v2026.10.20.1）

- **修复关闭程序后进程残留**：便携版启动器原先只结束了 PyInstaller onefile 的 bootloader 父进程，
  真正的 `PerfaraServer.exe` 子进程被留下占着端口；下次启动端口被占就顺延 8001/8002/8003，越积越多。
  现在退出时直接结束本包服务进程的父/子两层，并确认端口释放；服务进程同时挂在 Job Object 上，
  启动器被强杀也会连带清理；启动时还会先清理本包遗留进程。启动器源码 `tools/launcher_portable.py` 已入库。
- **修复打包版看板白屏**：`server/PerfaraServer.exe` 落后于 `backend/app.py` 的 MIME 修正，
  前端 `.js` 被当 `text/plain` 返回导致页面空白；已按新增的 `perfara/perfara_server.spec` 重打。
- **文案修正**：看板提示里的「32 位分享令牌」改为「32 位 ID」，与「复制 testid」按钮一致。

## 本次新增（v2026.10.21）· 体积与性能专项

按 `docs/优化方案-体积与性能.md` 与 `docs/参数调优建议.md` 落地，全部改动均已实测。

**体积（解压后，实测）**

| 项 | 改前 | 改后 | 手段 |
| --- | ---: | ---: | --- |
| `ios-tools/bin/` | 87 MB | 61 MB | 移出 `lowgpu.json`（27.7 MB，全仓无读取代码，exe 内也无该字面量） |
| `app.asar` | 4.26 MB / 312 文件 | 1.72 MB / 58 文件 | 剔除 `node_modules/zrender`（echarts.min.js 已自带） |
| 发布包内置 Python | 93.4 MB / 5231 文件 | **67.8 MB**（剔除 2423 文件 / 25.5 MB） | 打包时剔除 tcl / include / libs / idlelib / ensurepip / pydoc_data / venv / pip / 反编译工具（包体 + `dist-info` + `Scripts` 启动器）/ WinPython 启动器 |
| 发布 zip | 233.9 MB（r6） | **210.5 MB** | 上述三项 + 排除 `build/`、`dist/`、`logs/`、`-wal/-shm` |

> Python 裁剪只在 `make_release_zip.py` 的 `full` 模式生效，**本地 `perfara/` 目录不删任何文件**，出问题改清单重打即可。

**性能**

| 项 | 改前 | 改后 |
| --- | --- | --- |
| 首屏 JS 传输（`index-*.js`） | 1,345,571 B | **449,936 B**（gzip，-66%） |
| 服务冷启动 → `/api/health` 200 | 2.34 s | **2.13 s**（uvicorn 固定 h11 + asyncio，跳过 auto 探测） |
| 单 tick adb 进程创建 | 最多叠加 10 个 tick × 9 个进程 | **门闩钉死 1 个 tick**（超时同时从 10s 收到 4s） |
| PID 查询 | 每 tick 一次 | **每 5 tick 一次**，进程消失仍在 5 s 内发现 |
| 无效分享 token 兜底扫描 | `limit(5000)` 拉全字段（最坏 ~70 MB 内存） | **`limit(200)` 且只取 `id`**（实测 5 ms 返回 404） |
| 报告页渲染点数 | 全量（1 h = 3600 点/series） | **上限 2000 点/series**，超出隔点抽稀 |
| 报告页数据灌入 | 每点 × 12 张图各 setOption 一次 | **批量追加，每图只重绘一次** |
| SQLite | 无 PRAGMA（写等 fsync，易 `database is locked`） | **WAL + synchronous=NORMAL + busy_timeout=5000** |
| 历史归档 | 每次 `.js` + `.json` 两份 | **只留 `.js`**（内容一致，省一半磁盘） |
| 采集端内存样本 | 3600（正好 1 h，更久会丢开头） | **14400（4 h）** |
| 日志面板 | DOM 无上限 | **上限 500 行** |
| echarts 加载 | 4 个采集页 + 报告页均同步加载 1.07 MB | **异步注入**，窗口先出来、图表后补 |

> 报告页抽稀只作用于**渲染视图**：`state.times` / `state.series` 仍是全量数据，
> 子场景统计、框选统计、加载段剔除都按真实下标计算（已用 3600 点数据逐位核对）。
> 子场景与加载段的边界下标会被强制保留为抽稀锚点，底纹不会因抽稀而消失。

### 真机验证（Android 13 中端机型）

用真机跑了采集 → 上传 → 报告全链路，**发现并修掉 4 个只在真机/游戏场景暴露的问题**：

| 问题 | 表现 | 原因 | 修复 |
| --- | --- | --- | --- |
| framestats 解析在 Android 10+ 全失效 | `gfxinfo framestats` 通道解析出 0 帧，静默降级到「Total frames 增量」，丢掉了 Jank 明细 | 写死 `cols[1]=vsync`、`cols[13]=completed`；Android 10 起 `Flags` 后插入 `FrameTimelineVsyncId` 等列（18→22 列），`cols[1]` 变成小整数，被 `vsync > 1e9` 全部丢弃 | 改为**按表头名**取列（`Vsync` / `FrameCompleted`），自动兼容 18/22 列 |
| 游戏无法从界面启动 | 选游戏点「开始」直接报「该应用没有可启动入口」 | 部分厂商定制 ROM 上 `am start -a MAIN -c LAUNCHER -p <pkg>` 返回 `unable to resolve Intent`，代码一见该报错就提前放弃，连 monkey 都不试 | 先用 `cmd package resolve-activity` 解析组件，再 `am start -n <pkg/cls>`；失败依次降级，**不再提前 return** |
| 后台应用采不到 FPS | 目标应用进程活着但在后台时，整段 FPS 全是 null | `ensureAppRunning` 只看 PID 存在就返回「无需启动」，而取帧依赖**可见图层** | 新增 `isAppForeground()`；在后台时用 `am start -n` 把任务切到前台 |
| 陈旧帧缓冲导致假 0 | 静态画面下 `fps` 恒为 0，曲线贴底并被当成真实掉帧 | framestats 是「最近 N 帧」滚动窗口，N 用满后跨度可达 190s，`frames/dur` 算的是几分钟前的平均值 | 窗口跨度 > 30s 或帧缓冲未前进时**不再用它算 fps**，交给 Total frames 增量；仍无变化则报无数据（写 null） |

另外修掉一个**数据归属**问题：`ensure_project_for_payload` 里用
`(Project.package_name == pkg) | (Project.app_name == app_name)` 查项目，
当 `pkg` 为 `None` 时 SQLAlchemy 会生成 `package_name IS NULL`，
**匹配到任意一个包名为空的项目** —— 不同应用的上传会被并进同一个项目。
改为「值为空就不参与匹配」。

真机回归结果：一款真机游戏端到端 **39/39**、
浏览器 `com.example.browser` **39/39**、报告页渲染 **11/11**；
`test_api_full.py` 64 PASS、`test_metric_config_upload.py` 25/25、
`run_perf_html_test.js` 19/19、`run_collector_pages_test.js` 36/36、`jank_algo_test.js` 30/30。

> 已知未修：framestats 的 `tinyJank` 用 `FrameCompleted - Vsync` 作帧耗时，
> 60Hz 下该值恒为 2 个 vsync（≈33.6ms），会让 TinyJank 计数偏高（timestats 通道为 0）。
> 这属于指标口径定义问题，改动会影响与 PerfDog 的数值可比性，需产品确认后再动。

## 本次新增（v2026.10.21 · 真机完整走查）· 4 个真缺陷修复

在上述体积与性能专项之后，又用真机（Android 13 中端机型）
把「设备发现 → 采集 → 报告落盘 → 页面渲染」整条链路**完整走查一遍**，
新增 3 套走查脚本共 **117 项断言**（`perfara/tests/realdevice/realdevice_walkthrough_s{1,2,3}.js`），
结果 **117/117 全绿**，过程中查出并修掉 4 个此前没暴露的缺陷：

| 缺陷 | 表现 | 根因 | 修复 |
| --- | --- | --- | --- |
| 点「开始」干等 **23.5 秒**才报错 | 用户感知就是「点了没反应」 | `ensureAppRunning` 对**包根本没装**的设备也逐条尝试 3 种启动命令 + 每次 5s 轮询；`noEntry` 计数又被 `else noEntry = 0` 重置，导致「三种方式都无入口」这个终态永远不成立 | 新增 `isPackageInstalled()`（`pm path`，~90ms）先判存在性；`noEntry` 改为累计；命令明确报「无入口」时跳过轮询直接换下一种方式；`adb()` 抛错时 stdout 与 stderr 合并（设备端结论 `No activities found to run` 在 stdout，只取 stderr 会丢判据） |
| 「复用已有进程」被误报成「已启动」 | 日志误导 + 白等 5 秒稳定期 | `am start -n` 对已在后台的进程返回 `its current task has been brought to the front`，原代码一律记 `launched=true` | 改为返回 `switched:true`，采集端据此只等 1.5s |
| **FPS 假 0** 污染报告 | 静止 / 被遮挡 / 后台时曲线贴底，把 FPS 均值与 1%Low 拉低 | timestats 匹配到图层但本周期一帧未产出时 `delta=0 → fps=0`，被当成真实掉帧 | 新增 `method:'no-frames'`，采集端写 `null`（曲线断开），`FPS_NO_DATA_METHODS` 同步扩充 |
| 单文件分享报告**根本没内联 echarts** | 导出文件仅 213 KB、canvas=0、离线打开仍请求 `cdn.jsdelivr.net`，与「自包含、离线可看」矛盾 | `main.js` 找 `<script src="echarts.min.js">` 标签，但 `perf.html` 已改成异步加载器（`window.echartsReady`），根本没有该标签 → 内联逻辑完全失效 | 新增 `inlineEcharts()` 兼容两种模板结构（标签式 `library.html` / 异步加载器式 `perf.html`） |

效果：

| 场景 | 修复前 | 修复后 |
| --- | ---: | ---: |
| 目标包未安装 | 23.5 s | **101 ms** |
| 包已装但无启动入口 | ~24 s | **958 ms** |
| 正常拉起 | — | 773 ms |
| 单文件报告体积 / canvas 数 | 213 KB / 0 | **1218 KB / 12** |
| 单文件报告离线打开 | 仍请求 CDN | **零外部请求** |

> 走查同时暴露了一个**环境问题**：Escrcpy 等第三方工具自带的 adb 会抢占 5037 端口，
> 导致项目自带 adb 的 `devices` 返回空。排查时用 `netstat -ano | grep 5037` 确认端口归属即可，
> 不要直接判定「没插设备」。

---

## 本次新增（v2026.10.21 · 采集前健康检查 + 超时熔断）

设备卡顿曾经会一路传导到 PC 界面：点「开始」之后 `ensureAppRunning` 逐条尝试启动命令、
每种方式再轮询 5 秒 PID，最坏 20 多秒才给结论；采集中一旦 adb 通道卡死，
门闩又被永不 resolve 的 promise 焊死，界面停在「采集中」再也不动。
这一版把「设备不健康」和「设备卡死」都在有限时间内变成**可操作的结论**。

### 采集前健康检查（`ADB.preflightCheck`，动应用之前执行）

四项并行探测、各自有硬超时，总耗时有界（真机实测 0.7 s）：

| 检查 | 通过 | 警告（放行） | 失败（直接拦下） |
| --- | --- | --- | --- |
| 设备响应 | `echo` 2.5 s 内返回 | — | 超时/报错，附 adb 原文（`device not found` / `offline`） |
| 整机内存 | 可用 ≥ 600 MB | 可用 < 600 MB | 可用 < 200 MB（LMK 随时杀目标进程，数据不可用） |
| GPU 负载 | < 95% | ≥ 95%（有别的应用占着 GPU，结果会偏高） | — |
| 屏幕状态 | 已点亮 | 锁屏（应用被 keyguard 挡着） | 熄灭且唤不醒（**没有可见渲染层，三条取帧通道全废**） |

读不到的一律降级成「未知」并记一条说明，**不**因此判失败——机型/权限差异太大，
误判失败比漏判更糟。熄屏时会自动替用户点亮（`KEYCODE_WAKEUP`），点亮不了才报错。

### 采集超时熔断（`Collector`，两级防线）

| 防线 | 触发条件 | 动作 |
| --- | --- | --- |
| 单轮看门狗 | 某一轮采样超过 16 s 未完成 | 中止本轮、清掉 inflight adb 进程、把门闩交还下一轮（否则 `_tickBody` 里永不 resolve 的 promise 会把门闩焊死，后面再也采不动）；连续 2 轮即熔断 |
| 无数据巡检 | 连续 20 s 没有任何采样点产出（含 `fps=null` 的无帧点） | 熔断：自动停止 + 说明原因 |

另有 `start()` 全流程 30 s 硬超时（含拉起应用与稳定期等待）——健康检查、安装检查、
无入口快速失败已把常见卡点砍掉，超过 30 s 只能说明设备迟迟不就绪。

熔断时停止原因 `device_stall` 会直接显示在主界面（不只写进可能被隐藏的日志面板），
采集准备期间提示条还会跟随日志实时更新（`[adb] …` / `[健康检查] …`），
用户能看见「在等什么」而不是对着一句「准备中」猜。

### 顺带修掉的一处回归

「假 0 修复」把无帧数据点改写成 `null` 之后，`updateFpsWarn` 仍写着
`if (fps === null) return`，导致灭屏/应用退后台时**告警条再也不亮**——
用户对着一片空白曲线没有任何提示。现已把 `null` 与 `0` 一视同仁
（都表示「这一秒没有帧数据」），并补上屏幕熄灭这一可能原因。

真机实测：游戏登录页是静态界面时 FPS 全程 `null`，现在第 5 秒起主界面即提示
「已连续 N 秒未取到帧数据：被测应用可能不在前台、屏幕熄灭或没有渲染层」。

---

## 下载与运行

前往 [**Releases**](https://github.com/45944831/perfara/releases) 下载最新便携版：

```
Perfara_Portable_20261023_r2.zip   （约 210MB，对应 v2026.10.23.1）
```

> **注意**：**只有 v2026.10.23.1 提供下载**。此前所有版本的资产（`v2026.10.20`、`v2026.10.21` 的 `_r3`、
> `v2026.10.22`、`v2026.10.23` 的首版）已全部下架——前三个的发布包里含未脱敏的示例数据
> （真实设备序列号、机型与应用包名），该数据位于 `collector/resources/reports/`，因该目录被
> `.gitignore` 排除，源码扫描发现不了，随打包直接带出；`v2026.10.23` 首版虽已脱敏，
> 但不含 r2 的卡顿口径与 iOS/PC 无帧数据修复。各版本页面与变更说明保留，仅作记录。
>
> 自 v2026.10.23 起，示例数据、测试用例与文档中的机型/ROM/应用标识已全部脱敏，
> 且 `app.asar` 不再包含开发期测试报告（`reports/history`）；`data/` 整目录不进包。
> 发布前请用
> `python tools/scan_package.py <待发包.zip>` 自查（**会解包 `app.asar` 一起扫**，退出码非 0 即勿发）。

1. 解压到任意目录（路径不要含特殊字符）
2. 双击 **`Perfara.exe`**
3. 启动器会自动拉起本地看板（`127.0.0.1:8000`）与采集客户端

无需安装，无需 Python / Node 环境，卸载直接删目录。

> **分发方式说明**：便携版等大体积产物**不入库**，统一以 Release 资产发布。
> 仓库已停用 Git LFS —— 若需拉取源码历史，直接 clone 即可（仓库约 5.5 MB，无需下载任何 LFS 对象）。


### 三步开始采集

1. 手机开启 **USB 调试**，连上电脑，在手机上点「允许调试」
2. 客户端里选择设备 → 选择应用 → 点「开始」
3. 采集结束后打开本地报告（或到看板查看历史 / 做对比）

> 采集期间请保持被测应用在前台。应用切到后台后系统不再产生渲染层，FPS / Jank 采不到，
> 客户端会弹出橙色提示条——这不是工具故障，切回前台即可恢复。

---

## 目录结构

| 目录 | 说明 |
| --- | --- |
| `_client_src/app/` | Electron 采集客户端源码（`main.js` / `renderer/` / `src/` 采集器） |
| `perfara/backend/` | 看板服务端 API（FastAPI + SQLite） |
| `perfara/frontend/` | Web 看板前端（Vue + Vite） |
| `perfara/collector/resources/reports/` | 报告模板（`perf.html` / `library.html`，入库，改完即时生效） |
| `perfara/tests/` | 回归测试脚本（29 套，属代码资产，禁止清理） |
| `docs/screenshots/` | README 界面预览截图（取自本项目真实运行界面） |
| `tools/` | 构建与维护脚本 |
| `build/` | 启动器 PyInstaller 构建配置（`.spec`） |

## 构建与工具

| 脚本 | 用途 |
| --- | --- |
| `tools/build_app.py` | 打包 `app.asar`，带瘦身规则（剔除 echarts 冗余、zrender、调试镜像等，73MB → 1.6MB / 58 文件） |
| `tools/asar_tool.py` | asar 解包 / 打包 / 列文件（纯 Python，不依赖 Node） |
| `tools/make_release_zip.py` | 生成发布包（`changes` 改动文件 / `full` 完整便携版）；`full` 会按 `PRUNE_PREFIXES` / `PRUNE_SITE_PKGS` / `PRUNE_FLAT_DIRS` / `PRUNE_SCRIPT_STEMS` 剔除内置 Python 的纯运行期无用项 |
| `tools/cleanup_workspace.py` | 清理备份副本与构建中间产物（默认 `--dry-run`；`perfara/tests` 等回归资产在 PROTECTED 白名单内，永不清理） |
| `tools/inject_metric_info.py` | 报告页指标说明注入 |
| `tools/optimize_report_readability.py` | 报告可读性样式优化 |
| `tools/launcher_portable.py` | 便携版启动器源码：起看板服务 → 起采集客户端 → 客户端退出后**连根**收掉服务（含遗留进程清理、Job Object 强杀兜底、端口释放确认） |
| `perfara/perfara_server.spec` | 打包便携包里的 `server/PerfaraServer.exe`（后台服务，无控制台） |

改了采集器源码后**必须**重跑 `tools/build_app.py` 再打包，否则发布包里的 `app.asar` 会落后于源码。

改了 `backend/` 或 `frontend/dist` 后**必须**重打 `perfara/perfara_server.spec`，否则便携包里的服务会落后于源码（历史上曾因此出现 `.js` 被当 `text/plain` 返回、看板整页空白）。

```bash
# 重打便携版启动器（约 20s，产物 build/portable-dist/Perfara.exe）
python -m PyInstaller --onefile --noconsole --name Perfara \
  --distpath build/portable-dist --workpath build/portable-work \
  --specpath build/portable-spec --noconfirm tools/launcher_portable.py

# 重打便携包服务（约 75s，产物 perfara/dist/PerfaraServer.exe）
cd perfara && ../tools/.venv/Scripts/python.exe -m PyInstaller perfara_server.spec --noconfirm
```

## 回归测试

```bash
# 后端接口（需先起一个临时服务，见脚本头部说明）
python perfara/tests/test_api_full.py

# 报告页 / 采集页 UI（playwright-core + 本机 Edge 无头）
node perfara/tests/e2e_metric_config/run_perf_html_test.js
node perfara/tests/e2e_metric_config/run_collector_pages_test.js
node perfara/tests/e2e_metric_config/run_android_start_ux_test.js   # 点开始后的提示/告警/熔断

# 采集前健康检查 + 超时熔断（假 adb / 假 shell 离线跑，不需要真机）
node perfara/tests/realdevice/preflight_breaker_test.js

# 算法与报告数据（jank / 去重 / 分组 / 对比 / 序列化 / 渲染）
node perfara/tests/realdevice/jank_algo_test.js
node perfara/tests/realdevice/lazy_module_test.js
```

## 常见问题

**Q：报告里达帧率、均帧、低帧占比是空的？**
A：这组指标依赖目标帧率，而目标帧率由帧率分布 P95 推出。若采集期间应用没有渲染（后台 / 锁屏 / 被切走），
FPS 全为 0，整族指标就无从计算。现在报告会显式提示「本次采集未取到有效帧」，客户端也会弹提示条。

**Q：检测不到设备？**
A：确认 USB 调试已开启并授权；Windows 可检查设备管理器里的 ADB 驱动；无线调试需与手机同网段。

**Q：iOS 采集需要什么？**
A：便携版已自带 iOS 工具链（`ios.exe` + Python + `pymobiledevice3`），不需要装 Python。
Windows 上建议安装 Apple 驱动（iTunes 或「Apple 设备」应用）让手机被系统识别；首次连接需在手机上点「信任此电脑」。
iOS 17+ 走本机隧道（`127.0.0.1:60105`），客户端会自动建立。

**Q：仓库里为什么没有 exe？**
A：Electron 运行时（`Perfara.exe`、dll、pak、`app.asar`）体积远超 GitHub 单文件 100MB 限制，
通过 `.gitignore` 排除；完整可执行文件以 Release 资产分发。
便携版 zip 同样不入库（曾用 Git LFS 存放，2026-10-21 起已停用 LFS，全部改走 Release 资产），
所以 clone 仓库只有约 5.5 MB，不需要额外下载任何大文件。

**Q：采集数据会上传到哪？**
A：不会离开本机。看板服务只监听 `127.0.0.1`，数据存在本地 SQLite；报告是本地 HTML 文件。

## 版本历史

| 版本 | 内容 |
| --- | --- |
| `20261023` | **修复采集通道断开时「假活」**：所有采集调用全失败时旧逻辑用 0 兜底照常产样本，`_lastDataTs` 被刷新导致无数据熔断永不触发（界面「采集中」、曲线一条零线）；改为全失败不产样本 + 连续 3 轮立即熔断（实测 2.2s）。新增 `probeChannel()` 探活，区分「应用被杀」与「连接断开」，不再把 USB 掉线误诊为应用崩溃。打包卫生：asar 剔除 `reports/history`、`reports/shots`；示例数据/用例/文档中的机型·ROM·应用标识全量脱敏 |
| `20261023` | **修复卡顿分级口径**：framestats 路径把 `FrameCompleted−Vsync`（呈现延迟，60Hz 三缓冲 ≈33.6ms、120Hz ≈7.6ms）当帧间隔，TinyJank 阈值被每一帧越过 → TinyJank ≈ 总帧数；改为按相邻 `Vsync` 差值计算，基准与 timestats 路径统一为 `max(vsync, 平均帧间隔)×1.5`。**修复 iOS / PC 假 0**：无帧数据时写 `null` 而非 `0`（iOS 旧逻辑还会丢掉整条样本，连 CPU/内存一起丢）；PC 侧 `fpsSource` 保留供提权提示。测试基建：批量脚本退出码改为取被测进程真实状态（原来取的是 `tail` 的，恒为 0）；用例默认包名从占位符改为 `com.android.chrome` |
| `20261021` | 采集前健康检查（设备响应/整机内存/GPU 负载/屏幕状态，并行有界探测 + 熄屏自动唤醒）+ 采集超时熔断（单轮看门狗 16s、无数据巡检 20s、start 全流程 30s 硬超时），熔断原因直达主界面；顺带修掉 fps=null 后告警条不再亮起的回归 |
| `20261021` | 体积与性能专项：asar 剔 zrender（4.26→1.72MB）、移出 lowgpu.json（-27.7MB）、发布包裁剪内置 Python（93.4→67.8MB）、服务端 GZip（首屏 JS -66%）、SQLite WAL、tick 重入门闩 + adb 超时 4s + PID 每 5 tick、报告页抽稀与批量渲染、echarts 异步加载、日志面板 500 行上限、归档只留 `.js` |
| `20261021` | 帧率统计自动排除加载阶段掉帧（假 0 改为 null + 加载段识别），报告页底纹标注并保留「FPS(全程)」对照 |
| `20261021` | 真机完整走查 117 项：修复点「开始」干等 23.5s（未装包 23.5s→101ms）、复用已有进程误报为已启动、FPS 假 0（改为 `no-frames` 写 null）、单文件报告未内联 echarts（213KB→1218KB、canvas 0→12、零外部请求） |
| `20261021` | 停用 Git LFS，便携包统一以 GitHub Releases 资产分发（仓库体积 5.5MB，clone 无需下载 LFS 对象） |
| `20261021` | **修复对比报告曲线连成一条线**：① canvas 尺寸 bug（echarts 无容器监听 + 图表逐个 append 进 grid，前两张 canvas 定死在 1434/698px 而被右侧图表盖住，只剩左边一小条）② 改为「分段并列泳道」，每次运行独占一段、段间留间隙，段首圈号标注、单点运行有可见符号、悬停提示「圈号 + 第 N 秒」 |
| `v2026.10.20.1` | 修复关闭程序后 `PerfaraServer.exe` 进程残留与端口漂移、打包版看板白屏（`.js` MIME）、看板文案改为 testid |
| `v2026.10.20` | 移除 APK 依赖、修复打包版采集无法启动、启动失败可见、无渲染层提示与报告空状态 |
| `20261020` | 补齐 PerfDog 口径指标（1%Low / Drop / FPS≥目标 / 稳帧范围 / 标准差 / Stutter / Jank·10min / 上下文切换 / CPU 限频） |

## 说明

- 本工具只读取系统公开的性能计数器，不采集应用内业务数据、不抓包、不读取用户文件。
- 请仅对自己有权测试的设备与应用使用。
- 报告模板在仓库内，修改后即时生效，无需重新打包。
- 采集产生的历史数据（`reports/history/`、`perfara/data/`）属本地数据，不入库。
