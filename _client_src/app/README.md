# PerfAndroid

Electron 桌面端 Android / iOS 性能采集与图表展示（ADB、go-ios、Python 采集脚本）。

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm start` | 开发运行 |
| `npm run build` | Windows 打包（会先执行 `prebuild` 清理 `dist`） |
| `npm run install-ios-python` | 将 `py-ios-device` 依赖安装到自带的 `ios-tools/python` |

首次打包 iOS 采集前，若提示缺少 Python 模块（如 `construct`），请先执行 `npm run install-ios-python`。

### iOS 16 及以下：命令行采集 GPU Counters（USB）

与 py-ios-device 文档中的 `pyidevice instruments gpu_counters`（README 里亦写作 `gup_counters`）同源：通过 USB lockdown 连接 Instruments GPU 服务。独立脚本：`ios-tools/python/python/Scripts/gpu_counters_pre_ios17.py`。

**环境**：使用本仓库自带 Python 时（需已 `npm run install-ios-python`）：

```bash
cd ios-tools
python\python\python.exe python\python\Scripts\gpu_counters_pre_ios17.py -v
```

从仓库根目录也可：

```bash
ios-tools\python\python\python.exe ios-tools\python\python\Scripts\gpu_counters_pre_ios17.py -v
```

若本机已安装 `py-ios-device` 且能 `import ios_device`，也可用 `python gpu_counters_pre_ios17.py`。

**常用参数**：

| 参数 | 含义 |
|------|------|
| `--udid <UDID>` | 多设备时指定设备 |
| `--network` | 使用无线配对/网络方式连接的设备 |
| `--json` | 采集结束后输出与 `reports/data.js` 相同的结构：`{ "device": {...}, "perf": [ ... ] }`（`device` 在脚本内固定，无需填写应用名） |
| `--json-lines` | 采集中每行一条 JSON，仅单个 **perf** 对象（NDJSON）；与 `--json` 二选一 |
| `-o FILE` / `--output FILE` | 将 `--json` 结果写入文件（不写则打印到 stdout） |
| `--var-data` | 与 `--json` 合用，输出 `var data=<JSON>;` 便于粘贴进 `data.js` |
| `--duration <秒>` | 采集时长；`0`（默认）表示按 Ctrl+C 结束 |
| `-v` / `--verbose` | 在 stderr 打印状态与错误 |

**示例**：

```bash
# 类官方示例：表格风格输出（时间、指标名、数值）
python gpu_counters_pre_ios17.py -v

# 与 reports/data.js 同结构的 JSON，写入文件
python gpu_counters_pre_ios17.py --json --duration 60 -o reports/gpu_usb.json -v

# NDJSON（仅 perf 行），便于管道
python gpu_counters_pre_ios17.py --json-lines --duration 30 -v > gpu.ndjsonl
```

**说明**：需设备已信任电脑；若长时间 `code=1`，请在手机上进入实际使用 Metal 的场景（如游戏前台）。**iOS 17+** 请使用 `go-ios` 隧道 + `collect_ios_gpu.py tunnel`，勿依赖本 USB 脚本。

---

## 图表分组与指标单位

### Android 性能数据

图表配置见 `renderer/charts.js`（`CHART_CONFIGS`）。

| 分组 | 指标 | 单位 | 说明 |
|------|------|------|------|
| **cpu** | `cpu.sysCpu`、`cpu.procCpu` | % | 采样间隔内 CPU 占用（0–100） |
| **mem** | `mem.totalPss` | MB | `dumpsys meminfo` PSS |
| **memDetail** | `mem.nativeHeap`、`mem.javaHeap`、`mem.code`、`mem.stack`、`mem.graphics`、`mem.privateOther`、`mem.system` | MB | 各列 PSS 分量 |
| **fps** | `fps` | fps | 帧率 |
| | `jank`、`bigJank` | 次/采样间隔 | 该间隔内卡顿次数 |
| | `jankRate`（导出等） | % | 卡顿帧占比 |
| **net** | `net.rxKBps`、`net.txKBps` | KB/s | 网卡字节差分 |
| **gpu** | `gpu` | % | GPU 利用率（0–100） |
| **temp** | `temperature` 或 `battery.temperature` | °C | 热区/电池温度 |
| **current** | `battery.currentNow` | mA | 电流（由 µA 等归一） |
| **power** | `battery.power` | mW | `mA × mV / 1000` |
| **cpuCores** | `cpuCores.usage[]` | % | 每核 0–100 |
| **cpuFreq** | `cpuCores.freq[]` | MHz | 由 kHz 换算 |

---

### iOS 性能数据（CPU / Mem / FPS 等）

采集脚本：`ios-tools/python/python/Scripts/collect_ios.py`。图表配置见 `renderer/iphone.js`（`IOS_CHART_CONFIGS`）。

| 分组 | 指标 | 单位 | 说明 |
|------|------|------|------|
| **cpu** | `cpuUsage` | % | 进程 CPU |
| | `cpuTotalSystem`、`cpuTotalUser` | % | 系统内核 / 用户负载 |
| **fps** | `fps` | fps | 约 1s 窗口内推算 |
| | `jank`、`big_jank` | 次/秒 | 与每秒输出对齐的计数 |
| | `stutter` | 无量纲（0–1） | 卡顿时长占比 |
| **mem** | `physFootprint`、`memResidentSize` | MB（图表） | 底层为字节，展示时 ÷1048576 |
| **memdetail** | `memRPrvt`、`memRShrd`、`memAnon`、`memCompressed`、`memPurgeable` | MB（图表） | 底层为字节 |
| **disk** | `_diskReadKBps`、`_diskWriteKBps` | KB/s | 由 `diskBytesRead` / `diskBytesWritten` 累计字节差分 ÷1024；与约 1s 一条对齐时即 KB/s |
| **events** | `_ctxSwitchPs`、`_intWakeupsPs`、`_vmPageInsPs` | 次/秒 | 对 `ctxSwitch`、`intWakeups`、`vmPageIns` 累计值做相邻差 |

---

### iOS GPU（Xcode / Instruments 风格指标）

采集脚本：`ios-tools/python/python/Scripts/collect_ios_gpu.py`。图表配置见 `renderer/iphone_gpu.js`（`GPU_CHART_CONFIGS`）。

| 分组 | 指标 | 单位 |
|------|------|------|
| **occupancy** | `Vertex Occupancy`、`Fragment Occupancy`、`Compute Occupancy` | % |
| **aluPerf** | `ALU Utilization`、`F32 Utilization`、`F16 Utilization`、`ALU Limiter` | % |
| **texture** | `Texture Sample Utilization`、`Texture Filtering Limiter`、`Texture Sample Limiter`、`Texture Cache Limiter` | % |
| **bandwidth** | `GPU Read Bandwidth`、`GPU Write Bandwidth` | GB/s |
| **cache** | `GPU Last Level Cache Utilization`、`GPU Last Level Cache Limiter`、`MMU Utilization`、`MMU Limiter` | % |
| **shader** | `Fragment Input Interpolation Limiter`、`Fragment Input Interpolation Utilization`、`Threadgroup/Imageblock Load Utilization`、`Threadgroup/Imageblock Store Utilization` | % |

卡片等指标如 `Partial Renders Count` 为**计数**（无固定速率单位）。

---

### iOS 低版本 GPU（LowGPU，`ios_gpulow`）

`src/ios-gpu-collector.js` 中 `LOW_GPU_GROUPS`：`texture`、`bandwidth`、`compute`、`cache`、`buffer`、`threadgroup`、`fragment`。用于将 `lowgpu.json` 各组对象**展平**进单条数据；单位与同名的 Xcode GPU counter 一致（多为 **%** 或 **GB/s**）。缺失字段不影响其它序列（前端按 `null` 容错）。

---

## 激活：启动拉取与未激活试用

### 未激活试用（功能 1）— 在哪里配、是否全局

- **配置文件路径**：项目根目录 **`configout/config.js`**（内容为 `var upload={ ... };`）。打包安装后，优先读取 **`resources/configout/config.js`**（与 `src/reports-config.js` 中 `configOutPaths` 一致）。
- **配置项**：在 `upload` 对象里增加或修改 **`unactivatedTrialSec`**（数字，单位：**秒**），表示**本软件本次运行**内、**未激活**用户可用的**试用总时长池**（由主进程 `src/trial-session.js` 维护，IPC：`trial-budget-get`）。
  - 例：`"unactivatedTrialSec": 200`：进程启动后首次需要时初始化为 **200**；**仅在处于采集状态时**，每经过 **10 秒**从池中 **减 10**（200→190→…）；**停止采集则暂停扣减**。池子为 **0** 后未激活用户**不可再点「开始」**（主进程拒绝启动，界面也会关闭试用态）。
  - **`0` 或未写**：不开放试用（未激活时主区不可用，须先激活）。
- **全局生效**：**Android、iOS 性能、iOS GPU** 共用一个池；切换页面不重置剩余秒数。
- **服务端 `code===2` 时**：视为关闭试用——界面拿到的有效试用秒数会变为 **0**（与配置里写多少无关），未激活时主区恢复为须先激活。该状态写入本机 userData；**下次启动**若 `loginurl` 返回 **`code===0`** 并成功写入激活码，或用户在界面 **激活成功**，会清除该限制，未激活时的试用再按 `configout/config.js` 中的 `unactivatedTrialSec` 生效。

### `configout/config.js` 其余字段

在 `var upload={...}` 中还可配置：

| 字段 | 说明 |
|------|------|
| `loginurl` | 应用启动后主进程会 **GET 一次**；查询参数：`uid`（机器设备 ID）、`para1`（默认字符串 `test`，见下） |
| `loginPara1` | 可选；若不写或为空则 `para1` 为 `test` |
| `uploadurl` | 性能数据上报地址（**仅**在用户点击上传时用 POST，见下） |
| `unactivatedTrialSec` | **未激活试用总秒数（本进程池）**；全局；`0` 表示关闭试用 |

服务端 JSON 示例：`{"activitecode":"","code":0}`（字段名 `activitecode` 与现有拼写一致）。`code===0` 时用返回的 `activitecode` 更新本地激活记录，并**恢复**未激活试用按配置生效；`1` 不更新；`2` 清除为占位码 `"test"`，且**有效试用时长强制为 0**（见上一节）。**网络不通或请求失败时不改本地激活文件**；之后仍会走原有激活校验逻辑。渲染进程通过 **`get-config-out`** 读取到的 `unactivatedTrialSec` 已包含上述 `code===2` 的覆盖。

### 两接口用法：`loginurl` 与 `uploadurl`

以下为客户端实际行为，便于服务端区分「启动校验 / 浏览器取码 / 上报正文」。

#### `loginurl`（激活 licence，与 `uploadurl` 无关）

| 场景 | HTTP | Query 与说明 |
|------|------|----------------|
| **应用启动**（`runStartupLoginFetch`） | `GET` | `uid` = `getMachineUid()`；`para1` = `loginPara1`（配置非空）否则 **`test`**；固定 **`type=test`**（与下方「浏览器取码」区分） |
| **界面「获取激活码」打开系统浏览器**（`activation-open-fetch-url`） | `GET` | `uid` 同上；`para1` = **`uid` 本身**；**不含** `type` 参数（也不在 Query 中传本地激活码字符串） |

**举例（假定 `loginurl` 为 `https://example.com/api/auth/licence`，本机 `uid` 为 `MACHINE_ABC123`，且未配置 `loginPara1` 故启动时 `para1=test`）：**

1. **应用启动时**（主进程 `GET`，带 `type=test`）  
   `https://example.com/api/auth/licence?uid=MACHINE_ABC123&para1=test&type=test`

2. **点击「获取激活码」打开浏览器时**（`para1=uid`，无 `type`）  
   `https://example.com/api/auth/licence?uid=MACHINE_ABC123&para1=MACHINE_ABC123`

实际域名与路径以 `configout/config.js` 中 `loginurl` 为准；`uid` 为运行时 `getMachineUid()` 结果。

启动 GET 的响应体按 JSON 解析，字段 `activitecode`、`code` 等见上文；浏览器打开仅用于用户人工取码，不解析响应。

#### `uploadurl`（性能数据上报）

| 场景 | HTTP | Query 与说明 |
|------|------|----------------|
| **用户点击上传报告**（`upload-report-data`） | `POST`（或配置的 `uploadmethod`） | `uid`、`para1`（有激活码用激活码，否则 `test`）；**不含** `type`；Body 为与 `reports/data.json` 等价的 JSON |

应用启动时**不会**对 `uploadurl` 发 GET；无 `type` 参数。

### 代码位置（起始行）

| 功能 | 文件 | 起始行（约） |
|------|------|----------------|
| 启动时 GET `loginurl?…&type=test`、解析后更新激活文件、并 `activation-refresh` | `main.js` | **`runStartupLoginFetch`** |
| 浏览器打开 `loginurl` 取码（无 `type`） | `main.js` | **`activation-open-fetch-url`** |
| 根据 `code` / `activitecode` 写 `activitecode.json`；`code=2` 时写试用关闭标记 | `src/activation.js` | **`applyLoginFetchResult`**、**`isServerTrialDisabled`** |
| `get-config-out` 在 `code=2` 后把 `unactivatedTrialSec` 置 0 | `main.js` | **`get-config-out` 的 ipc 处理** |
| 默认配置键 `unactivatedTrialSec`、`loginPara1` | `src/reports-config.js` | **7**（`DEFAULT_CONFIG`） |
| 未激活试用池、采集中每 10 秒扣 10 | `src/trial-session.js` | 全文 |
| 启动/停止采集时扣减计时；试用用尽事件 | `main.js` | `start-collect` / `stop-collect` / `ios-*` 与 **`trial-budget-get`** |
| 剩余试用、`trial-mode` 与点击放行 | `renderer/activation-ui.js` | **`trialBudgetGet`**、`refresh` |
| 主区在未激活试用时可点（样式） | `renderer/style.css` | **741** |
| 试用用尽：停采并弹激活窗 | `renderer/renderer.js` 等 | **`onTrialBudgetExhausted`** |

---

## 许可

见 `package.json` 中的 `license` 字段。
前提（collect_ios_gpu.pyc 跑 iOS 17+ 的必要条件）
collect_ios_gpu.pyc 是给 iOS 17+（走 go-ios tunnel/userspace） 用的。运行链路是：

启动 tunnel 服务：ios.exe tunnel start --userspace
读 tunnel 信息（本机 HTTP）：http://127.0.0.1:60105/tunnels
再用自带 Python 启动脚本：python.exe collect_ios_gpu.pyc user xdlj tunnel <address> <rsdPort> <userspaceTunPort>
脚本 stdout 按行输出 JSON（NDJSON）：每行一条指标对象（工具里就是按行 JSON.parse 的）
另外：你当前仓库里我没找到 collect_ios_gpu.pyc 文件本体（路径应是 ios-tools\python\python\Scripts\collect_ios_gpu.pyc）。下面给的是“用法脚本”，文件存在时可直接用。

用法脚本（PowerShell，可直接保存为 run-ios17-gpu.ps1）
# run-ios17-gpu.ps1
$ErrorActionPreference = "Stop"
$root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$iosExe = Join-Path $root "ios-tools\bin\ios.exe"
$pyExe  = Join-Path $root "ios-tools\python\python\python.exe"
$pyc    = Join-Path $root "ios-tools\python\python\Scripts\collect_ios_gpu.pyc"
if (!(Test-Path $iosExe)) { throw "找不到 ios.exe：$iosExe" }
if (!(Test-Path $pyExe))  { throw "找不到 python.exe：$pyExe" }
if (!(Test-Path $pyc))    { throw "找不到 collect_ios_gpu.pyc：$pyc" }
Write-Host "[1/3] 启动 tunnel（userspace）..."
# 后台启动，不阻塞当前窗口
Start-Process -FilePath $iosExe -ArgumentList @("tunnel","start","--userspace") -WindowStyle Hidden | Out-Null
Write-Host "[2/3] 等待 tunnel 就绪并读取端口..."
$tunnelsUrl = "http://127.0.0.1:60105/tunnels"
$t = $null
for ($i=0; $i -lt 30; $i++) {
  try {
    $list = Invoke-RestMethod -UseBasicParsing -TimeoutSec 3 -Uri $tunnelsUrl
    if ($list -and $list.Count -gt 0) { $t = $list[0]; break }
  } catch { }
  Start-Sleep -Milliseconds 800
}
if (-not $t) { throw "tunnel 未就绪（读取 $tunnelsUrl 失败或为空）" }
# go-ios 返回字段名在不同版本可能略有差异，这里做兼容读取
$address = $t.address
$rsdPort = $t.rsdPort
$userspacePort = $t.userspaceTunPort
if (-not $address -or -not $rsdPort -or -not $userspacePort) {
  throw "tunnel 字段不完整：address=$address rsdPort=$rsdPort userspaceTunPort=$userspacePort"
}
Write-Host "[3/3] 启动 GPU 采集（stdout 为逐行 JSON）..."
& $pyExe $pyc user xdlj tunnel $address $rsdPort $userspacePort
