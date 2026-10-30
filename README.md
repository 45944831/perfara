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
> 采集窗口与看板顶部各有一行不显眼的开源署名：本项目基于 [charmingLitteDeveloper/perfara](https://github.com/charmingLitteDeveloper/perfara) 二次开发。

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

**弱网二级页面**：采集窗口内直接调场景与参数，状态条给代理地址、连接数与上下行；返回采集不停限速，顶栏按钮变绿提示还限着

![弱网二级页面](docs/screenshots/weaknet-page.png)

---

## 功能特性

### 多平台采集

- **Android**：USB 直连或无线 adb，Android 6.0+（FPS 走 `SurfaceFlinger --timestats`，需 Android 11+，低版本自动回退 `gfxinfo`）；应用列表走 `pm list packages -3`，**不在手机上安装任何 APK**；下拉框显示手机桌面上的应用名（`src/apk-label.js` 直接解析 APK 的 `AndroidManifest.xml` + `resources.arsc`，按设备语言取名，后台逐条解析并缓存）
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

### 弱网测试（随包携带）

- 采集按钮组里的 `≈ 弱网测试` 在采集窗口内打开弱网测试页（覆盖式二级页面，配色与采集界面统一），引擎 **WeakNet** 以 `--headless` 随 Perfara 无窗口启动（`collector/resources/weaknet/WeakNet.exe`）；页面经主进程转发控制请求，端口用 `--ready-file` 握手回传，不再硬编码 8899
- 17 个内置场景（常规网络 / 弱网环境 / 极端环境三档）+ 13 项自定义参数（上下行延迟、抖动、带宽、丢包、断连率/间隔/时长、卡顿、黑洞率、拒连率、DNS 故障率），点场景即时生效
- **弱网组合**：把多段场景按顺序排成一条时间线（最多 5 段，每段选场景 + 时长，可循环），页面里直接新建/编辑/删除，点一下即播放；播放中状态显示「第 2/3 段 · Wi-Fi 良好 · 还剩 0:42」。组合与 WeakNet 图形界面共用同一份配置，两端都看得到；组合不能嵌套，场景被删掉时跳过该段
- 接管三选一：本机桌面程序（系统代理）、**手机 USB 直连**（`adb reverse` 手机 `127.0.0.1:18888` → 本机引擎 `8888` + 写手机系统代理，手机不装 App，接管时自动开限速、点「解除」或退出自动还原）、同一 Wi-Fi 的手机（局域网代理 `PC IP:8888`）
- 手机 USB 接管只对读系统代理的程序生效（自己开 TCP/UDP 的多数手游不走代理）；部分 ROM 禁止 adb 写系统设置，页面会按阶段报错并给出「禁止权限监控 / USB 调试（安全设置）」的开启指引（不写死厂商），不猜「大概成功了」
- `← 返回采集` 只关页面不停限速，顶栏按钮变绿色 `≈ 限速中`；退出 Perfara 先关限速、解除系统代理再结束引擎，不会把机器留在断网状态
- 弱网只改接管对象的网络路径，adb 采集链路不受影响，可以边限速边采，观察应用在弱网下的帧率与流量
- **报告自动带「弱网总结分析」**：采集期间每 2s 轮询 WeakNet 控制接口（端口取自握手；USB 接管的手机走同一引擎，段记到「手机（USB 接管）」名下），把限速时段记进 `data.weaknet`；报告页在「解读总结」下方追加一块——弱网时长占比、场景/时段/接管范围/代理流量、弱网段 vs 直连段的六项指标对比（帧率、达帧率、1% Low、卡顿、流量、进程 CPU）与风险建议。没开弱网就没有这一段，老报告不受影响

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

## 本次新增（v2026.10.28）· 深度测试暴露的 12 项缺陷修复（复核时追加 D17 / D18）

一轮全面深度测试（报告：`docs/深度测试报告-20261028.md`）新增 5 套测试资产 + 1 个取证脚本，
共 336+ 项断言。下面是已修项与修法，每项都由新增用例回归到 0 FAIL。

| 编号 | 症状 | 修在哪 | 修法 |
| --- | --- | --- | --- |
| **D2 严重** | 便携包首启后「点详情 500 + 列表均值整列为空」（种子库 44 处 JSON 被脱敏改坏） | `tools/make_seed_db.py:157,169` | JSON 列改为**按叶子节点脱敏**（解析→只替换字符串→重新序列化）；序列号正则补「必须同时含大写与数字」的前瞻 |
| **D1 高** | 未鉴权上传畸形 payload → 500，并把 SQL 语句、绑定参数、他人 uid 原样回显 | `perfara/backend/parsers.py:169`、`app.py:269,291` | `normalize_device` 走 `as_text` 兜底；parse_error / db_error 分支只回 `code + 人话`，堆栈改为写日志 |
| **D3 中** | 看板首屏向 `fonts.googleapis.com` 发请求，与「100% 本地」矛盾 | `perfara/frontend/dist/index.html` | 删掉 3 个外链 `<link>`；CSS 里 `--font-sans` 本就带完整系统字体栈，直接降级，不留白 |
| **D10 中** | 种子库与其数据源被 `.gitignore` 排除，发布不可复现 | `.gitignore:82` | 为 `perfara/_seed/*.db` 开负向规则，脱敏种子库随源码入库（已由两道门禁验 0 命中） |
| **D13 中** | `run_deep_batch.sh` 打印的退出码全是假的（取的是 `tail` 的状态），deep 套件「全绿」不可信 | `perfara/tests/run_deep_batch.sh` | 开 `pipefail`、用 `rc` 变量接真实退出码，末尾汇总表 + 非零收尾；顺带把新增 5 套并入批量（现为 10 套） |
| **D9 中低** | 响应头回显 `Server: uvicorn` | `perfara/launcher.py:169` | `Config(server_header=False)`；`api_deep_test.py` / `run_api_full.sh` 的临时服务同步关掉，测的才是真实启动形态 |
| **D5 中低** | SPA 兜底的前缀守卫可用同层目录名绕过（`dist_evil/`） | `perfara/backend/app.py:1057-1061` | 先 `abspath`，再按 `== dist_root` 或 `startswith(dist_root + os.sep)` 判定 |
| **D6 / D7** | `project_id=0` / `test_id=0` 被当「未传」，前者返回全量、后者触发全库重解析 | `perfara/backend/app.py:437,831` | 判据从真值判断改为 `is not None` |
| **D8** | `q=%` 被当 LIKE 通配符，一次请求把全部项目捞走 | `perfara/backend/app.py:346-352` | 转义 `\ % _` 三字符，`ilike(..., escape="\\")` |
| **D4 低** | 设备侧命令拼接：包名/组件名里的单引号能断掉引号（仅设备侧，PC 侧走 `execFile` 不过 shell） | `_client_src/app/src/adb.js:77`、`main.js:79-90` | 新增 `shellArg()`，所有 `adb shell` 拼接点统一走 POSIX 单引号转义（组件名此前完全没转义）；主进程 IPC 入口加设备序列号 / 包名白名单 |
| **D16 低中** | PC 采集「启动目标程序」经 `cmd /c start`，文件名含 `^&` 能在本机多执行一条命令 | `_client_src/app/src/pc-collector.js:143` | 不再绕 cmd，直接 `spawn(exePath, [], {detached:true})`；Node 自己转义只处理空格，`& | ^` 都退回字面字符 |
| 附加 | 种子库损坏无人拦截 | `tools/scan_seed_db.py:92,120` | 发布门禁补两个判据：5 个 JSON 列必须解析得动 + 逐条详情接口不得 500 |
| **D17 高** | 脱敏「全绿」的种子库二进制里仍能 grep 出真机机型、品牌与真实包名 | `tools/make_seed_db.py:292,360` | 根因是 SQLite 的 free page：删过/改过的页只被标记为空闲，内容原地留着，`SELECT` 查不到但文件里还在。构建末尾加 `VACUUM` 重建成干净文件，并给 `make_seed_db` / `scan_seed_db` / `seed_integrity_test` 各加一道**整文件字节扫描**，让这类残留变成发布阻断项 |
| **D18 高** | 「脱敏种子库已入库」其实只入库了一个 131 B 的 Git LFS 指针：克隆下来是指针文本，打包会把它当数据库塞进 exe；真库反会被推上 LFS 存储 | `perfara/.gitattributes` | 该文件由 UGit 自动生成，`*.db` / `*.pyc` 一律 `filter=lfs`（仓库根 `.gitattributes` 2026-10-21 已声明移除了 LFS 规则，漏了这个子目录里的）。改为 `*.db binary`：种子库不到 400 KB，普通 blob 克隆即得、也才谈得上被门禁审计 |

同日第二轮深度测试（报告：`docs/深度测试报告-20261028-第二轮.md`）又修了 **N1–N9**：
上传去重纳入 `metricConfig`、`latest_info` 与项目别名按 uid 隔离、分享令牌改随机并收紧公开 DTO、
summary 拒绝非有限浮点、上传体积/点数/字段上限、`serve.py` 默认只监听本机、
报告库转义与窗口 sandbox、测试基建假绿与残留。另补统一应用图标与看板 favicon；
真机 11 套用例复测 **370 PASS / 0 FAIL**（含 Unity 游戏 CPU 施压场景）。

**回归结果**：`bash perfara/tests/run_deep_batch.sh` 10 套全绿（退出码已可信），共 352 项断言
0 FAIL，其中 `api_deep` 148/148、看板 SPA 端到端 35/35（修复前 25 PASS / 9 FAIL）、
`seed_integrity`（仓库内种子库）7/7。
重打后的两个 exe 各过一遍发布门禁：`SQL 0 命中 / 字节层 0 命中 / 52 个 JSON 全合法 /
13 条详情 × 2 个 uid 无 500`，退出码均 0；`seed_integrity` 真跑 exe 产物 9/9（修复前 5/3）。
既有离线批量 16 套同样全绿，未引入回归。

**本轮未改的 4 项**：
D11 —— 那款真机测试游戏的名字仍留在 git 历史的 4 个 blob 里（HEAD 工作树已干净，
`release/` 与 `.workbuddy-ai/` 都不入库），要不要重写历史属产品决策；
D12 —— 「无激活码」的文案为真，但 `activation.js` 里 `activated:true` / `para2:'perefara'`
两个死垫片仍被 `main.js` 引用约 9 处，删除要与激活链路一起复核；
D14 —— 绕过启动器直接用 `Popen.terminate()` 收 `PerfaraServer.exe` 会留孤儿监听
（onefile 的 bootloader 与被拉起的子进程是两层），现有 `launcher_port_test.py` 只覆盖走启动器的路径；
D15 —— 项目自带的 e2e 脚本不清理 `%TEMP%` 下的 `perfara-e2e-*`，长跑 CI 会堆磁盘。

另外：重打后的 `Perfara.exe` / `PerfaraServer.exe` 因体积不入库，
需按下面的构建命令重出发布 zip，改动才会带到用户机器上。

---

## 下载与运行

前往 [**Releases**](https://github.com/45944831/perfara/releases) 下载最新便携版：

```
Perfara_Portable_20261028_r2.zip   （211,587,345 B，约 202MB，对应 v2026.10.28）
```

> **注意**：**最新版为 v2026.10.28**。更早的 v2026.10.27 资产保留作记录，请优先使用新版。
> 更早版本的资产（`v2026.10.20`、`v2026.10.21` 的 `_r3`、
> `v2026.10.22`、`v2026.10.23`、`v2026.10.23.1`）已全部下架。
> 最早三个的发布包含未脱敏的示例数据（真实设备序列号、机型与应用包名），该数据位于
> `collector/resources/reports/`，因该目录被 `.gitignore` 排除，源码扫描发现不了，随打包带出；
> `v2026.10.23` / `v2026.10.23.1` 则栽在同一类盲区上——**种子数据库被编进了 `PerfaraServer.exe`**，
> zip 层审计（剔 `data/` + 扫文本条目）看不见，因为它压在 PyInstaller 归档里。
> 各版本页面与变更说明保留，仅作记录。
>
> 自 v2026.10.27 起，随包种子库改为脱敏后的 `perfara/_seed/webperf.db`（由
> `python tools/make_seed_db.py` 从开发库生成），`perfara_server.spec` / `perfara.spec` 指向它，
> 且缺文件时**直接中止打包**而不是回退到开发库。发布前请跑完两道自查：
>
> ```
> python tools/scan_package.py <待发包.zip>          # zip 文本条目 + 解包 app.asar
> python tools/scan_seed_db.py  <包内 PerfaraServer.exe>   # 跑起来看它首次生成的种子库
> ```
>
> 两道都退出码 0 才可发。第二道是 2026-10-27 补的——它专门覆盖「运行期产物被当只读资源
> 编进二进制」这一类泄漏，`scan_package.py` 扫不到。
>
> **第二道在 2026-10-28 扩充为四个判据**，因为它当初只回答「有没有泄漏」，而 v2026.10.27
> 的种子库虽然 0 命中，却有 44 处 JSON 被脱敏正则改坏（新用户第一次点看板详情就是 500、
> 列表均值整列为空）：
>
> | 判据 | 查什么 | 不过则 |
> | --- | --- | --- |
> | 敏感串 | 逐列扫 6 条真机规则 | 退出码 1 |
> | **敏感串（字节层）** | 把库文件当**二进制**整体扫一遍：SQLite 删过/改过的页只是被标成 free page，内容原地还在，`SELECT` 查不到但 `grep` 查得到 | 退出码 1 |
> | JSON 完整性 | `metric_blobs.content` / `test_runs.summary` / `test_runs.raw_json` / `parsed_info.summary_json` / `metric_configs.config_json` 必须 `json.loads` 得动 | 退出码 1 |
> | 详情可用性 | 逐条 `GET /api/tests/{id}`（演示账号 + 超管各一遍）不得 500 | 退出码 1 |
>
> 根因与修法见 `docs/深度测试报告-20261028.md` 的 D2：脱敏脚本里一条「14 位以上大写+数字」
> 的序列号正则会把 JSON 里的浮点数当序列号替换，把 `"fpsAvg": 24.218…` 改成 `"fpsAvg": DEMO-SERIAL`。
> 现在 `make_seed_db.py` **对 JSON 列按叶子节点脱敏**（解析→逐字符串替换→重新序列化），
> 数字 / 布尔 / 结构一律原样保留；序列号规则也补上了「必须含数字且全大写」的前瞻。
> 字节层判据（D17）加进来当天就抓到了一次：SQL 三查全绿的种子库里，free page 还留着
> 真机机型、品牌与真实包名——`make_seed_db.py` 末尾补 `VACUUM` 把库重建成干净文件后归零。

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
| `perfara/frontend/patch-spa-metric-config.js` | 后处理 SPA 产物：注入指标配置（`dist/` 不入库，仓库里没有 Vue 源码，只能这样调） |
| `perfara/frontend/patch-spa-offline-fonts.js` | 后处理 SPA 产物：剥掉 `index.html` 的外链字体，让首屏真的不联网；`--check` 可当发布前检查 |
| `perfara/frontend/patch-spa-favicon.js` | 后处理 SPA 产物：把 `frontend/favicon/` 复制进 `dist/` 并注入 favicon `<link>`（幂等）；图标设计源在 `docs/icon/` |
| `perfara/frontend/patch-spa-attribution.js` | 后处理 SPA 产物：在 `index.html` 顶部注入「本项目基于原项目二次开发」的小字署名（幂等，已存在时会升级为最新样式）；`--check` 可当发布前检查 |

改了采集器源码后**必须**重跑 `tools/build_app.py` 再打包，否则发布包里的 `app.asar` 会落后于源码。

改了 `backend/` 或 `frontend/dist` 后**必须**重打 `perfara/perfara_server.spec`，否则便携包里的服务会落后于源码（历史上曾因此出现 `.js` 被当 `text/plain` 返回、看板整页空白）。
`dist/` 是构建产物、不入库，所以对它的任何修复都得落成脚本（见上表四个 patch-*），否则前端一重建就回去了。

```bash
# 重打便携版启动器（约 20s，产物 build/portable-dist/Perfara.exe）
python -m PyInstaller --onefile --noconsole --name Perfara \
  --icon "$PWD/_client_src/app/icon/perfara.ico" \
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

# 深度套件（18 套：启动器进程/端口、加载算法、报告边界、畸形上传、对比泳道、
# PC 启动注入、种子库完整性、弱网追踪/报告/组合/引擎/页面/手机接管、接口深度、看板 SPA 端到端）
bash perfara/tests/run_deep_batch.sh      # 末尾按真实退出码汇总，任一套红即 exit 1
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
| `20261030` | **真机接管专项验收（r17）**：手机写系统代理的权限放开后，用打包态采集端把「引擎 → USB 接管 → 限速 → 停止 / 解除 / 退出」整条链路在真机上跑了一遍（39 项全过）。手机侧限速不再靠 `toybox nc` 量（本机 ROM 的 nc 连回环都不转发数据），改成让手机 Chrome 走系统代理下载本机源站的 2 MB 文件，按下载目录落盘计时：直连 657 ms、4G 弱网 6065 ms（9.2 倍，前一轮同参数 602 → 5598 ms，同为 9 倍量级），两次都是完整 2 MB。源站只看到本机出口 IP —— 手机的 Wi-Fi 在 172.16 网段、到不了本机 192.168 网段，能下到就只能是走 USB 反向隧道。顺带修掉一个真缺陷：**接管进行中关窗会留下反向映射** —— 一次接管是 reverse → 写代理 → 装守护好几趟 adb，账本要到最后一刻才写，退出清理这时读到的是空账本，随后 connect 又把映射/代理写上。现在 `connect` / `disconnect` / `restoreAll` 走同一个串行队列，退出清理排在手上这趟接管之后，映射建好就先落账，失败分支再撤掉。`phone_proxy_test.js` 81 项（新增「接管中退出」5 项）、deep 21 套、离线 16 套全绿。发布包 `Perfara_Portable_20261030_r17`（222,245,812 B / 2894 条目，SHA-256 `29c7e0e6…db9b2e`）：`zip_smoke_test.py` 18 PASS / 0 FAIL、`scan_package.py` CLEAN、`scan_seed_db.py` 0 命中。**未上传 GitHub** |
| `20261030` | **引擎启动失败复核 + 两处加固**：用打包态 `WeakNet.exe` 复盘「启动后立即退出（code=-1）」，确认是探测脚本路径编码坏掉导致的 spawn ENOENT，引擎本身能正常拉起（host `ensure` 握手 1.8s、复用 2ms、`shutdown` 后端口释放；用户自己开着的 8899 实例不受影响，也没有留下孤儿进程）。顺带修两处：①spawn 自身的 error（exe 被杀软隔离 / 被删 / 无执行权限）以前只报「立即退出（code=-1）」，现在直接带上系统错误原文与常见原因；②引擎回 `already`（端口上已有别的实例）时只报 ctrl_port，接管后代理端口为 null，手机会 reverse 到默认 8888 —— 现在接管前先探一次 `/api/status`，取对方真实的 `listen.port`。`weaknet_host_test.js` 53/53 通过（新增两条静态守卫）；发布包 `Perfara_Portable_20261030_r16` 已本地生成（222,245,323 B / 2894 条目，SHA-256 `5916e09e…dd01e6`）：`zip_smoke_test.py` 18 PASS / 0 FAIL、`scan_package.py` CLEAN、`scan_seed_db.py` 0 命中。**未上传 GitHub** |
| `20261030` | **接管手机不再要求先开限速**：`弱网引擎没有在运行，先点「开启限速」` 这条死路去掉 ——手机接管本来就要引擎，主进程在 `weaknet-phone` 的 connect 分支里先确保引擎可用（不在就 `ensure`），拉不起来才报错并原样带回启动失败原因；页面在接管成功后同步把引擎状态置为可用（主进程刚拉起的引擎不会让页面停在「未启动」）。同时补上 `weaknet-host.ensure` 的一个洞：原来只要手里还留着 `state.info` 就直接 `ok`，引擎卡死 / 端口不答话也照样复用它，现在先探一次控制端口（1500ms），探不到按「引擎已退出」走同一套收尾（还原手机代理、系统代理、通知页面）再重新拉起。`weaknet_host_test.js` 51 项（新增「接管时引擎不在会自动拉起」「自动拉起后引擎可用」、接线静态检查）。**未打包、未上传** |
| `20261030` | **弱网页启停合并成一个按钮**：页头的 `⚡ 立即开始` 与 `▶ 开启限速` 功能重叠（手机接管过之后两者几乎一样），去掉 `⚡ 立即开始`，只留 `▶ 开启限速` / `■ 停止限速` 一个按钮。点开始时一次做完：引擎没起就拉起 → 下拉框选了手机且未接管就接管 → 按当前场景开限速；没选手机就只限本机；手机接管失败只提示、限速照开，限速没开成会把刚接管的手机退回去（提示条写「已还原手机代理」）。限速中同一个按钮变 `■ 停止限速`，只停限速，场景 / 代理 / 手机接管都保留。`weaknet_page_ui_test.js` 相应改写：「页头只剩一个启停按钮」「没选手机时开限速不碰手机」「一键开始顺手接管所选手机」「失败回滚」共 94 项。**未打包、未上传** |
| `20261030` | **弱网残留自查（第二轮）**：逐条核对接管 / 解除 / 换机 / 引擎退出 / 强杀 / 重启等路径后修掉四处。①解除失败时不再丢记账：退出、下次接管还会按账本重试，接管前记下的用户原代理也不会丢（此前失败即删记录，重试时会把 `127.0.0.1:18888` 当成本工具写的直接删，公司的代理回不去了）；②本机系统代理加崩溃兜底 —— 开启前把 HKCU 的 `ProxyEnable/ProxyServer/ProxyOverride` 快照到 `userData/weaknet-sysproxy-backup.json`（已经是本引擎接管时跳过快照，免得把 `127.0.0.1` 存成「用户原值」），引擎意外退出按快照还原并用 PowerShell 调 `InternetSetOption` 通知系统刷新，整个程序被强杀则下次启动先还原再开窗口；只在当前代理仍等于快照记录的引擎端口时才改注册表，用户中途换过代理就只丢快照；③`⚡ 立即开始` / 跟随采集在「限速没开成」时把刚接管的手机退回去，提示里写明「已还原手机代理」，不留接管着但没限速的半截状态；④失败提示条带 15s 存活期，状态轮询不再把它顺手清掉；⑤接管来的引擎（用户自己开着的 WeakNet）没有子进程 `exit` 事件，`ensure` 后每 5s 探活，连续两次探不到控制端口就按「引擎退出」走同一套收尾（还原手机代理 → 系统代理快照 → 通知页面），不再出现「窗口关了、手机还指着它的端口」；本机若在 8899 跑着引擎，`weaknet_host_test.js` 的 IPC 部分会临时接管它开限速，跑完按原值还原；⑥手机侧加启动自检：程序被任务管理器强杀 / 蓝屏时内存账本丢了，重开后对已连接手机逐个检查，只在「代理是 `127.0.0.1:18888` 且 `reverse --list` 里没有这条映射」时清代理（映射还在可能正在限速、或代理不是本工具写的，一律不碰）。新增 `sysproxy_residue_test.js` 21 项（快照/还原/端口不一致/用户改过/接线静态检查），`phone_proxy_test.js` 76 项（新增失败保账本、重试还原原代理、启动自检四类设备）、`weaknet_page_ui_test.js` 93 项（新增回滚两例）、`weaknet_host_test.js` 48 项（新增「接管实例消失触发收尾」、外部引擎限速开关还原）；deep 批量扩为 21 套。**未打包、未上传** |
| `20261030` | **弱网：修「拔线后手机还断网」+ 立即开始 / 跟随采集**：手机接管成功后推送守护脚本 `/data/local/tmp/perfara_proxy_watch.sh`（`setsid` 起会话，每 2s 看 `/proc/net/tcp{,6}` 里 `18888` 是否还在 LISTEN，连续两次消失就先 `settings put global http_proxy :0`（触发 MIUI 把 Wi-Fi 网络配置里镜像的代理一起清掉）再删 `global_http_proxy_host/port` 与 `http_proxy`；删前回读，值已被别人改过就退出，不跟别的工具抢；无 `awk` 时只记日志不清理，避免误清把限速打断）；守护装不上不影响接管，界面提示「拔线守护未安装，拔线前请先解除」。弱网页页头新增 `⚡ 立即开始`（引擎 → 接管所选手机 → 开限速，一步完成，直连场景会提示选了才有效果），右栏新增 `跟随性能采集`（localStorage 记住）：点采集 `开始` 时先接管当前设备并开限速再采样，停止 / 切设备换应用 / 应用退出自动停止 / 启动失败回滚都会把限速、系统代理、手机代理一起收掉；只开跟随时顶栏显示 `≈ 弱网·跟随`。紧随 WeakNet v1.1.12 的残留收口同步三处：接管/解除按「已接管的那台 + 端口」记账，下拉框切到别的手机再点解除也清得对（主进程在解除后会按账本把残留的其余设备一并还原，页面提示「另一台手机还挂着代理」）；换机 / 换端口重连前先按账本还原上一台，旧 reverse 映射与旧代理不再留到拔线，重连也不会把自己写的 `127.0.0.1` 当成用户原代理；自动还原失败的手动命令改成 `settings put global http_proxy :0`（`delete` 清不掉 MIUI 网络配置副本），`Address already in use` 单独点名「手机上的 18888 被代理 App 占着」。测试：`phone_proxy_test.js` 64 项（守护编排、`:0` 顺序、换机/换端口还原、端口占用、手动命令）、`weaknet_page_ui_test.js` 91 项（立即开始、跟随起停、账本提示），deep 批量 20 套。**未打包、未上传** |
| `20261029` | **弱网测试页集成「弱网组合」**：左栏新增组合卡片，引擎 `/api/combos` 的配置直接列出（与 WeakNet 图形界面共用同一份文件），点一下选中并开限速播放；`＋ 新建` 打开编辑器（名称、循环、最多 5 段「场景 + 时长」，时长最小 1s），保存/编辑/删除都走页面，删除需二次确认（4s 内再点一次）；播放进度不新增接口，用采集端已轮询的 `status.profile.name` 对上段首场景名逐段推进并从段时长倒数，显示「第 2/3 段 · Wi-Fi 良好 · 还剩 0:42」；步骤下拉同时列 17 个内置场景与自定义场景（`/api/upresets`），场景被删就跳过该段，组合不能嵌套。引擎无改动（不用重编 exe）。测试：`weaknet_page_ui_test.js` 扩到 61 项（假引擎补组合增删改与播放态）、`weaknet_host_test.js` 扩到 45 项（真引擎建 2 段组合 → 开限速 → 轮询到换段 → 删除回直连）、`weaknet_report_test.js` 53 项（`c:<id>` 按 profile 变化拆段）；手册新增 §9.3 弱网组合。本地用真 Electron + 随包引擎实跑（21 + 9 项）时发现并修掉一个旧问题：关掉采集窗口后 `WeakNet.exe` 会残留继续占 8888/8899——`weaknet-host.stop()` 原来是异步 `spawn` taskkill，紧接着的 `app.quit()` 把它一起带走，改成同步 `execFileSync` 后退出即清干净。**未打包、未上传** |
| `20261029` | **弱网改为二级页面**：`≈ 弱网测试` 不再弹 WeakNet 的 tkinter 窗口，改为采集窗口内的覆盖式页面（Perfara 配色，顶栏/胶囊/状态条/场景/自定义参数/接管开关/事件日志），`← 返回采集` 不停限速、顶栏按钮变绿 `≈ 限速中`。引擎以 `--headless` 无窗口启动并用 `--ready-file` 回传实际代理/控制端口（不再硬编码 8899）；渲染进程不直接出网（控制接口无 CORS），改走 `weaknet-launch` / `weaknet-api`（24 条路由白名单）/ `weaknet-engine-stop` 三个 IPC → 新增 `_client_src/app/src/weaknet-host.js`（握手、接管已运行实例、旧版引擎可读报错、退出回收）。退出 Perfara 先 `/api/sysproxy off` + `/api/stop` 再 `taskkill /T /F`（强杀会绕过引擎 `atexit` 的系统代理还原）；追踪器改用握手端口。测试：`weaknet_host_test.js` 38 项（真引擎限速 ≥3×、接管、旧版报错、经 IPC 全链路）、`weaknet_page_ui_test.js` 27 项（Playwright + 假 perfAPI），deep 批量扩为 17 套全绿；手册 §9 重写并换真引擎配图。**随包 `WeakNet.exe` 已用同一份 1.1.10 源码重编**（补 `--headless` / `--ready-file`，10.3 MB）；发布包 `Perfara_Portable_20261029_r8` 已本地生成（212.0 MB / 2889 条目，SHA-256 `0211d8d1…`）：`zip_smoke_test.py` 17 PASS / 0 FAIL（新增「二级页面随包」「引擎 `--headless` 握手」两项闸门）、`scan_package.py` CLEAN、`scan_seed_db.py` 0 命中。**未上传 GitHub** |`≈ 弱网测试` 不再弹 WeakNet 的 tkinter 窗口，改为采集窗口内的覆盖式页面（Perfara 配色，顶栏/胶囊/状态条/场景/自定义参数/接管开关/事件日志），`← 返回采集` 不停限速、顶栏按钮变绿 `≈ 限速中`。引擎以 `--headless` 无窗口启动并用 `--ready-file` 回传实际代理/控制端口（不再硬编码 8899）；渲染进程不直接出网（控制接口无 CORS），改走 `weaknet-launch` / `weaknet-api`（24 条路由白名单）/ `weaknet-engine-stop` 三个 IPC → 新增 `_client_src/app/src/weaknet-host.js`（握手、接管已运行实例、旧版引擎可读报错、退出回收）。退出 Perfara 先 `/api/sysproxy off` + `/api/stop` 再 `taskkill /T /F`（强杀会绕过引擎 `atexit` 的系统代理还原）；追踪器改用握手端口。测试：`weaknet_host_test.js` 38 项（真引擎限速 ≥3×、接管、旧版报错、经 IPC 全链路）、`weaknet_page_ui_test.js` 27 项（Playwright + 假 perfAPI），deep 批量扩为 17 套全绿；手册 §9 重写并换真引擎配图。**随包 `WeakNet.exe` 已用同一份 1.1.10 源码重编**（补 `--headless` / `--ready-file`，10.3 MB）；发布包 `Perfara_Portable_20261029_r8` 已本地生成（212.0 MB / 2889 条目，SHA-256 `0211d8d1…`）：`zip_smoke_test.py` 17 PASS / 0 FAIL（新增「二级页面随包」「引擎 `--headless` 握手」两项闸门）、`scan_package.py` CLEAN、`scan_seed_db.py` 0 命中。**未上传 GitHub** |
| `20261029` | **报告新增「弱网总结分析」**：采集期间每 2s 轮询 WeakNet `127.0.0.1:8899`（手机 APK 由采集端 `adb forward tcp:18999 tcp:8899` 拉回），把限速时段记为段（换场景/改参数拆段、WeakNet 退出按最后一次成功时刻收口）随 `data.js` 落盘；报告页在「解读总结」下追加区块：时长占比徽标、场景/时段/接管范围/代理流量、弱网段 vs 直连段六项对比表（帧率方向判好坏、CPU/卡顿反向、流量中性）、按衰减幅度出的风险建议。统计与解读总结同口径（先剔加载段）；四端（android/pc/ios/iosgpu）采集入口全部接线；没开弱网不渲染。新增 2 套深度用例（状态机 45 项 + 合成数据渲染 44 项），deep 批量扩为 15 套 |
| `20261029` | **集成弱网模拟**：采集按钮组新增 `≈ 弱网测试`（与开始/停止/标记/CSV/JSON 同排），拉起随包的 WeakNet 1.1.9（exe 10.8 MB + 手机端 APK），界面风格与采集窗口统一；`weaknet` 目录在 asar 外（Electron 不能 spawn asar 内文件），发布包内 2 个条目、运行期日志/设置文件不入包；`.gitignore` 排除二进制，不入库。真机联调结论：ColorOS 拒绝写 `http_proxy`（`WRITE_SECURE_SETTINGS`），PC 端 USB 模式只能建反向端口，改用 APK 的 VPN 接管后限速生效（弱 Wi-Fi 场景 256 KB 平均 57 KB/s vs 4G LTE 867 KB/s），弱网下采集窗口帧率/流量正常出数。新增图解手册 `docs/操作手册-采集与报告.md` |
| `20261028` | **深度测试后的修复轮**：种子库脱敏改坏 44 处 JSON 导致「点详情 500 + 列表无均值」（`make_seed_db.py` 改为按 JSON 叶子节点脱敏，正则补前瞻）；未鉴权上传触发 500 并回显 SQL/绑定参数/他人 uid（`normalize_device` 兜底 + 错误分支只回人话）；看板首屏不再请求 Google Fonts；`.gitignore` 放行 `_seed/*.db`，发布链可复现；`run_deep_batch.sh` 退出码取的是 `tail` 的假状态，改为真实退出码汇总；`Server: uvicorn` 响应头关闭；SPA 兜底前缀守卫改 `abspath`+`os.sep`（同层 `dist_evil/` 不再可绕）；`project_id=0` / `test_id=0` 被当未传、`q=%` 被当 LIKE 通配符，三处一并修；采集侧 adb 设备命令统一 `shellArg()` 转义并在 IPC 入口加白名单；PC 采集「启动目标程序」不再经 `cmd start`（文件名含 `^&` 曾在本机多执行一条命令）；`scan_seed_db.py` 增补「JSON 可解析 + 详情不打 500」两个发布判据。新增 5 套测试资产 + 1 个取证脚本，deep 批量扩为 10 套全绿。**复核时追加两项**：D17——脱敏三条自检全绿的种子库，把文件当二进制仍能 grep 出真机机型 / 品牌 / 真实包名（SQLite 的 free page 只标记不清零），构建末尾补 `VACUUM`（552,960→389,120 B），并给 `make_seed_db.py` / `scan_seed_db.py` / `seed_integrity_test.py` 各加一道整文件字节扫描，发布门禁由三判据扩为四判据；D18——`perfara/.gitattributes`（UGit 生成）把 `*.db` / `*.pyc` 全交给 Git LFS，所以「已入库的种子库」其实是个 131 B 指针：克隆拿不到数据、打包会把指针当库塞进 exe，而 `git push` 的 pre-push 钩子会把真库上传到 LFS 存储（叠加 D17 等于把带残留的库发到公网）；仓库根 2026-10-21 已声明停用 LFS，漏了这个子目录。改为 `*.db binary`，`git lfs ls-files` 现为 0 条 |
| `20261027` | **修复种子数据库泄漏（严重）**：`perfara_server.spec` / `perfara.spec` 原先把 `data/webperf.db`（开发机真实数据）当种子库编进 exe，首次启动复制给用户 —— 含真实设备序列号、真机机型与品牌、真实应用包名与真实用户 uid；zip 层审计（剔 `data/` + 扫文本条目）看不见，因为它在 PyInstaller 归档里。改为打包脱敏后的 `_seed/webperf.db`（`tools/make_seed_db.py` 生成，spec 缺文件直接中止），并新增 `tools/scan_seed_db.py`——真跑 exe 取首次生成的库再扫，补上审计盲区。**体积**：剔除 `devimages/DeveloperDiskImage.dmg`（8.46MB，全仓 0 引用、`ios image auto` 联网下载）与 `tests/`（0.93MB），210.5→201.6MB。**启动**：修 `database.py` 里 `if "share_md5" in cols or True` 恒真死条件导致每次启动全表扫描；列表接口按需列裁剪，不再白读 `raw_json`。顺带清理演示快照指向已删除记录的 5 条 |
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
