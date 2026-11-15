# Perfara v1.6 更新内容汇总

- **版本**：`1.6`（`SCHEMA_VERSION` = 6）
- **打包日期**：2026-11-14（23:27 起按 r8 从零重打）
- **发布状态**：**打包但从未单独发布**。次日因 D-19 / D-20 修复重打为 v1.7，本版全部内容已并入
  [v1.7 Release](https://github.com/45944831/perfara/releases/tag/v1.7)，**不存在 `v1.6` 的 tag 或 Release**。
- **本文用途**：v1.6 的变更散落在更新日志的 r6 / r7 / r8 / 进程守卫 / 口径 5→6 五个段落里，
  本文把它们合并成一份完整清单，供追溯与对外说明使用。

---

## 一、总览：相对 v1.5 的五组变更

| # | 组 | 内容 | 是否影响报告数字 |
|---|---|---|---|
| 1 | **指标口径 5 → 6** | S-01 档位表 5 份副本统一（7 档 → 11 档）；S-02 TinyJank 双通道基准同源 | ✅ **会变** |
| 2 | **进程生命周期** | 服务端「祖先进程存活守卫」，不再留孤儿占 8000 / 8001 | ❌ |
| 3 | **发布包内容治理** | 报告目录改文件名白名单；`perf2.html` 不再随包 | ❌ |
| 4 | **工程债** | 空 catch 约定 + 预算、4 个测试归队、批处理环境统一、重复导出清理、脚手架夹具 | ❌ |
| 5 | **可复现性** | r8 从零重打验证（`--clean`，不复用中间产物） | ❌ |

v1.6 的定位是「**口径 5 → 6 收尾 + 工程债清账**」：v1.5 引入的 P-04 只改了部分档位表副本
（仅报告页 KPI 路径），漏掉的 `fps-loading.js` 恰好是优先级最高的一份；v1.6 把剩余副本一次性补齐，
并顺带修掉 TinyJank 双通道基准不一致。工程侧则把 r6 / r7 / r8 三轮复查的遗留项全部关掉。

---

## 二、指标口径 5 → 6（唯一会改变报告数字的部分）

两项同批做，共用**一次** `SCHEMA_VERSION` 递增（5 → 6），避免连续两次口径跳变把历史报告切成三段。

### 2.1 S-01：档位表 5 份副本统一

**问题**：目标帧率的吸附档位表在项目里有 **5 份副本**：

| 位置 | 用途 |
|---|---|
| `_client_src/app/src/fps-loading.js` | **优先级最高**：读不到设备刷新率时的推断来源 |
| `_client_src/app/src/adb.js`（`REFRESH_RATES`） | 采集侧吸附 |
| `perfara/collector/resources/reports/perf.html`（`REFRESH_RATES_SHARED`） | 报告页评分区 |
| 同目录 `library.html` | 对比页综合得分 |
| `perfara/backend/utils.py`（`FPS_TARGET_CANDIDATES`） | 后端汇总 |

v1.5 的 P-04 只改了其中 2 份，漏掉的正是**优先级最高**的 `fps-loading.js`。它的推断值会经
`data.loading.target` 被报告页当成「设备值」直接采用 —— 于是报告页的新表形同虚设。

**改法**：5 份统一为 11 档规范表，兜底公式由 `ceil(p95/30)*30` 改为 `Math.ceil(p95)`。

```
24 / 30 / 48 / 60 / 90 / 100 / 120 / 144 / 165 / 185 / 240
```

- 去掉 45（不存在这种面板）
- 补上 24 / 48（视频帧率）、100（非 30 倍数的真实机型）、185（ROG 9 / K100 Pro Max）

**实测变化**（无设备值、纯 P95 推断路径）：

| 输入 | v1.5 | v1.6 |
|---|---|---|
| 100Hz 面板 / P95 = 99 | 120 | **100** |
| 185Hz 面板 / P95 = 180 | 180 | **185** |
| 24 fps | 30 | **24** |
| 48 fps | 60 | **48** |
| 60Hz / P95 = 59 | 60 | 60（不变） |

### 2.2 S-02：TinyJank 双通道基准同源

**问题**：TinyJank 有两条统计通道，基准却不一样 —— 直方图通道用 `p50`，逐帧通道用 `avgMs`。
而同一函数下方注释正写着「`avgMs` 不能拿来当锚」。

后果是**自我遮蔽**：均值被长帧抬高 → 卡得越狠阈值越高 → 抖动帧成片漏计。

**改法**：`adb.js` 新增 `ftP50All`（下标与 `nearestRank` 一致：`ceil(0.5n)-1`），
`TINY_JANK_MS` 的基准由 `avgMs` 改为 `ftP50All`。`avgMs` 变量保留（日志仍在用）。

**实测**（同一批帧间隔，两通道计数）：

| 场景 | v1.5（p50 / avg） | v1.6（p50 / p50） |
|---|---|---|
| `200×16.67ms + 40×40ms 抖动 + 10×300ms 长卡` | 10 / 50 | **50 / 50** |
| 同上，长卡增到 `40×400ms` | 40 / 80 | **80 / 80** |

### 2.3 补上缺失的防回归守卫

`perf.html` 原注释声称「`perf_param_audit` 有同步断言」，实测**该断言并不存在** ——
5 份副本漂移一整轮没被发现，正是因为缺这道守卫。

本轮在 `perf_param_audit_test.js` 追加 ⑧~⑫ 五节（**49 → 96 项**）：

- 5 份表逐份比对 11 档规范表 + 均不含 45
- 三处兜底公式一致
- 旧 `ceil(p95/30)*30` 全项目绝迹
- `deviceTargetHz` 函数体级断言
- `snapFpsTarget` 14 组吸附 + 旧表三条反例
- TinyJank 两通道等价性 + 旧 `avg` 反例
- 版本号与兼容性判定

---

## 三、进程残留根治（v1.6 的核心交付）

### 3.1 现象

本机同时挂着 **4 个 `PerfaraServer.exe`**，占着 8000 和 8001，前端早已关闭。

```
10:48:36  Started server process [45100]  →  :8000     父进程 30148（bootloader，仍活）
10:48:55  Started server process [16712]  →  :8001     父进程 2936（bootloader，仍活）
两次启动的上一级（25536 / 23032）都已消失，日志里没有任何 shutdown 记录
```

4 个进程 = **2 次启动 × 2 层**（PyInstaller onefile 的 bootloader + 真正的 Python 服务）。

### 3.2 根因

`PerfaraServer.exe` 自身没有任何生命周期绑定：

- `launcher.py` 就是 `uvicorn.Server.run()` 阻塞
- 没有 `atexit`、没有信号处理器、没有父进程存活检测、没有 `/api/shutdown`
- `perfara_server.spec` 是 `console=False` —— 没有控制台窗口，也就没有「关闭窗口」这个动作可触发

所以**谁拉起它，谁就必须负责收尾**；拉起者异常退出，服务就成了永久孤儿。
`v2026.10.20.1` 修过启动器侧（Job Object + `taskkill /T`），但只覆盖「走便携启动器」这一条路，
直接跑 exe 仍然复现。

### 3.3 修复：祖先进程存活守卫

在 `perfara/launcher.py` 的子进程侧兜底：

- 启动时用 `CreateToolhelp32Snapshot` 取进程表，从自身往上走出**整条祖先链**，
  对每个祖先 `OpenProcess(SYNCHRONIZE)`，再用 `WaitForMultipleObjects` 一起等；任一祖先退出即收尾
- **为什么是整条链而不是直接父进程**：onefile 是两层，`启动器 → bootloader → python 子进程`。
  python 的直接父进程是 bootloader，而先死的往往是启动器 —— 只盯直接父进程在这种形态下完全失效，
  而这正是本次 4 个残留的实际结构（45100 的父进程 30148 仍在，30148 的父进程 25536 已消失）
- **上溯到桌面会话根就停**（`explorer.exe` / `services.exe` / `svchost.exe` 等 `ROOT_PROCESS_NAMES`）：
  双击启动时它们的父进程就是自己，监视它们只会让「资源管理器重启」误杀正在用的服务
- 句柄在 `main()` 一开始就开，避免晚一步父进程已死、PID 被复用导致守卫失效
- 退出走优雅路径：`_WATCHDOG_HOOK` 置 `server.should_exit = True`，给 uvicorn 3 秒收尾，超时才 `os._exit(0)`
- 新增 `--no-exit-with-parent` 显式关闭该行为（默认开启）；POSIX 下退化为 `os.getppid()` 轮询

**顺带修掉的同类隐患**：`tools/audit-probes/probe_r12_upload_guard.py` 用 `proc.kill()` 收尾 ——
那只会杀掉 onefile 的 bootloader，真正的服务子进程留成孤儿。改为 `taskkill /F /T /PID`。

### 3.4 验证

| 项 | 结果 |
|---|---|
| `launcher_parent_watch_test.py`（新增） | **12 PASS / 0 FAIL** —— 三层替身精确复现「启动器死、bootloader 活、叶子被留下」；反例证明修复非空转 |
| 端到端（真实 `launcher.py` + uvicorn，`--port 8199`） | 只杀祖父层、不杀树：`boot` 存活，`launcher` 10 秒内退出，8199 不再 LISTENING |
| 既有启动器测试 | `launcher_process_test` 32/0、`launcher_port_test` 14/0 |
| 打包后实测 | 强杀拉起者 **0.5 秒内**退出并释放端口；`--no-exit-with-parent` 反例存活 |

> ⚠️ 这项改动落地时**只改了源码**。v1.5 的产物里 `PerfaraServer.exe` 还是旧行为，
> 所以升级到 v1.5 并不能解决残留问题 —— 必须重打服务端才生效。v1.6 是第一个真正带上守卫的产物。

---

## 四、发布包内容治理

### 4.1 S-04：报告目录从「扩展名黑名单」反转成「文件名白名单」

`collector/resources/reports/` 同时是**交付资源目录**和**运行期输出目录**。原来靠三条排除规则
（`data.js` / `history/` / `*.xlsx`）挡住，方向是黑名单 —— 将来多出一种产物就会漏：
`.csv` 导出、`.png` 低谷截图、`.json` 诊断包都不会被拦住，会直接跟着发包出去。

**改法**（`tools/make_release_zip.py`）：

```python
REPORTS_ALLOW = {perf.html, library.html, echarts.min.js}
```

- 只放行这三个，其余一律剔除
- 每剔除一个就在打包日志打 `⚠ 报告目录剔除（不在白名单）: <文件>` —— 让多出来的文件**当场显形**
- 配套 `check_reports_assets()`：白名单里的文件少一个就**中止打包**，避免名字写错把交付资源一起挡掉、页面 404

实战验证：r8 重打时真机跑完又生成了一份新的 `.xlsx`，打包日志立刻告警，包内仍只有 3 个交付资源。

### 4.2 S-03：`perf2.html` 标注停用并从包里剔除

- 源码**保留**（`schema_version_test.js` 还在用它做「页面内置口径版本 == `SCHEMA_VERSION`」的守卫）
- 文件头加了醒目的停用说明
- 白名单里没有它，所以不再随包分发（**38 KB 死重消失**，条目 2882 → 2881）
- 没有删文件 —— 删它必须同步删那个用例，否则守卫会静默消失，这个决定留给后续

---

## 五、工程债

### 5.1 S-05：空 catch 先纠正数字，再用「约定 + 棘轮」收口

原报告写「150 处 / 5 处带注释」，是手工 `grep` 的漏计。新增 `tools/scan_empty_catch.py` 重扫
（先把注释置空再匹配，否则说明文字里写的 `` `catch (_) {}` `` 会被算成代码；同时修掉 `main.js`
因分隔符不同被重复计数的问题），实测 **203 处 / 20 处带说明 / 29 个文件**。

不给 183 处各写一句「忽略」—— 那只会制造噪音。改成两件事：

1. **约定**：`main.js`、`adb.js`、`phone-proxy.js`、`weaknet-host.js`、`renderer.js`、`weaknet-page.js`
   六个高频文件各写一段「本文件的空 catch 属于哪一类、由谁兜底」；写盘（`reports-data-js.js`）
   与网络（`sysproxy.js`、`update-check.js`）关键路径逐条补原因
2. **棘轮**：`perfara/tests/deep/empty_catch_budget_test.py` 按文件锁数量，**只许减不许增**。
   新增空 catch 必须显式改预算 —— 「这里吞了个错误」就会出现在 review 里

### 5.2 S-07：4 个「写了但永远不会被跑」的测试归队

| 测试 | 去处 |
|---|---|
| `e2e_metric_config/run_android_start_ux_test.js` | `run_offline_batch.sh`（playwright + Edge，不需真机） |
| `realdevice/pc_realdevice_test.js` | `run_offline_batch.sh`（本机 Windows 采集，12 秒） |
| `realdevice/round2_realdevice.js` | `run_realdevice_batch.sh`（FIX-11/13/14 真机验收） |
| `realdevice/weaknet_phone_realdevice.js` | `run_realdevice_batch.sh`，按 `PERFARA_TEST_SERIAL` **条件执行**（串号不入库） |

### 5.3 S-09：三套批处理混用两份 Node 安装 → 统一 `env.sh`

`run_offline` / `run_deep` 用 `~/.workbuddy`，`run_realdevice` 用 `~/.workbuddy-ai`，
换机或升级时改漏一处就有一套跑不起来，而真机那套最难排查。

现在四套脚本（含 `run_api_full.sh`）统一 `. env.sh`：

- 按 `.workbuddy` → `.workbuddy-ai` 顺序找，同目录多版本取最大（`sort -V`）
- 项目根由脚本位置反推（不再硬编码绝对路径）
- `NODE_PATH` / `PY` / `PY_VENV` 一次性导出并做存在性自检

### 5.4 S-08：重复导出清理

`adb.js` 的 `__algo` 里 `parseMemLite` 写了两遍（单列一行，又跟在 `parsePeakRefreshRate` 后面）。
对象字面量重复键不报错、后者覆盖前者，运行时看不出异常 —— 但这是「复制粘贴加一行」维护导出表时
最容易踩的坑，真有一天两处指到不同实现就会变成难查的静默错。

已删掉重复那行，`__algo` 现在 **50 项全部唯一**。

### 5.5 测试脚手架不再依赖本机报告库

报告库被清空时两个用例必现假失败：

| 用例 | 现象 | 根因 |
|---|---|---|
| `dedupe_metrics_test.js` | `Error: 没有可用的真实报告` | 直接 `throw`，没有夹具兜底 |
| `compare_report_test.js` | 对比表只剩「采样数 / 时长 / 设备」三行 | 兜底夹具只有 `perf`、没有 `kpi` |

对比表的指标行完全由 index 条目的 `kpi` 决定，而那份夹具是给「参数配置」用例造的，本来就不带 `kpi`。
**不是产品缺陷，是夹具不完整。**

修法：新增 `perfara/tests/realdevice/fixtures/compare_rep.js` —— 以原夹具的 8 条 `perf` 为底，
补上 `smallJank` / `tinyJank` / `metricConfig`，再用产品自己的 `summarizePerf()` 算出 `kpi`
（含四档派生计数）。只给这两个用例用，不动被其它用例共享的夹具。

验证：报告库为空 / 有真实报告两种状态各跑一遍，均全绿（`dedupe_metrics` 17/0、`compare_report` 40/0）。

### 5.6 两处「无 JS 报错」断言过严

`dedupe_metrics` 与 `shared_report` 在真机套件跑过之后会红：报告引用的低谷截图被后续测试清掉，
页面加载留下 3 条 `Failed to load resource: net::ERR_FILE_NOT_FOUND`。这是测试数据漂移，不是代码缺陷 ——
截图是可选产物，用户清掉 `shots/` 之后报告仍要能看。

改法：把「JS 异常」与「资源缺失」分开收集 —— `pageerror` + 非资源类 console 才算 JS 报错，
资源失败单独断言「除 `shots/` 之外不得缺失」。既不误报，也仍能抓住 echarts / data.js 缺失。

---

## 六、可复现性：r8 从零重打

把整条打包链**从零**跑一遍（PyInstaller 加 `--clean`，不复用任何中间产物），回答一个问题：
**同样的源码，能不能稳定产出同样的包**。

| 产物 | 结果 |
|---|---|
| `app.asar` | **逐字节一致**（`a1c3ee0c…`，2,207,842 B）—— 自研打包器是确定性的 |
| `Perfara.exe` | 9,251,936 → **9,252,736 B**，md5 变 |
| `PerfaraServer.exe` | 23,062,215 → **23,061,909 B**，md5 变 |
| 便携 zip | 222,441,208 → **222,441,684 B**，sha256 变 |

两个 exe 差几百字节、哈希不同，是 PyInstaller onefile 的固有行为（PKG 里带构建期时间戳与压缩顺序），
**不是源码漂移**。重打后重新验了祖先进程守卫：强杀拉起者 0.5 秒内退出、`--no-exit-with-parent` 反例存活，**2/2 通过**。

> ⚠️ 打包顺序有坑：**必须先 `build_app.py` 再 `make_release_zip.py`**。反过来的话 `--app-version=next`
> 写的是包内 `version.txt` 与源码常量，asar 里那份 `APP_VERSION` 会停在旧值（运行时以 `version.txt`
> 优先，但两边不一致，后续排查容易误判）。

---

## 七、产物与指纹

| 项 | 值 |
|---|---|
| 文件 | `Perfara_Portable_20261114_v1.6.zip` |
| 体积 | 222,441,684 B（212.1 MB）/ **2881 文件** |
| MD5 | `4ff6ee756429621cf67978fbfd2f4346` |
| SHA256 | `5d492447814aa685ce6c955bf8d0a4c392635d8f1f1e613e31102aed40cb2f7a` |
| 版本标识 | `collector/resources/version.txt` = `1.6`（源码 `APP_VERSION` 同步） |

| 组件 | 体积 | MD5 | 说明 |
|---|---|---|---|
| `Perfara.exe`（启动器） | 9,252,736 B | `e1fca866ef8bf702a7f0c702b3c556ea` | r8 用 `--clean` 强制重建 |
| `collector/resources/app.asar` | 2,207,842 B | `a1c3ee0c059a589762ea69e77ef807e5` | 84 文件；**两次构建哈希相同** |
| `server/PerfaraServer.exe` | 23,061,909 B | `5a30b7a214d394c340fbe5174fc60549` | r8 重建；**首次带祖先进程守卫** |
| `weaknet/WeakNet.exe` | 10,862,443 B | `2a5b412870035c5275f893f745ebc5bb` | 1.1.17，未改动 |

---

## 八、验收基线

| 套件 | 结果 |
|---|---|
| 离线（29 套，含 2 个新登记用例） | 全部 `exit=0`，**859 项断言 0 FAIL** |
| 深度（26 套，含空 catch 预算、白名单行为用例） | 全部 `exit=0`，**1125 项断言 0 FAIL** |
| 真机（16 套，Android 13 / Chrome） | **479 项断言 0 FAIL** |
| 整包冒烟（解压后跑真实入口） | **18 PASS / 0 FAIL** |
| 打包 exe 守卫端到端 | **2 / 2** |
| 白名单行为测试 | **17 PASS / 0 FAIL** |
| 空 catch 预算测试 | **5 PASS / 0 FAIL**（203 / 203） |
| 发布门禁 `scan_package.py` | **CLEAN，0 命中**（含 asar 全量） |
| 发布门禁 `scan_seed_db.py` | **0 命中**，52 个 JSON 全合法 |

整包冒烟覆盖的关键项：根入口是启动器而不是 all-in-one、JS MIME 可执行、
**启动器退出后无遗留进程**、**端口已释放**。

---

## 九、已知边界（v1.6 时点）

- simpleperf 回退通道仅对 root 设备有效；非 root 的 Android 12+ 只走 perfetto
- thermal headroom / GPU 频率节点在部分 ROM 被封死，读不到写 null，不编数值
- `dumpsys netstats` 为 1~2 小时分桶：同桶内为真实差值，桶边界丢 1 拍（写 null）
- **非标刷新率会被抬到上一档**：`snapFpsTarget(200) = 240`，对 200Hz 面板 `fpsReach` 会偏低约 17%。
  改它属于派生算法变更，需把 `SCHEMA_VERSION` 升到 7，本版未动
- `perf2.html` 源码仍在仓库（已停用、不再随包）

---

## 十、后续：v1.7 修了什么

v1.6 打包后第二天，用**解包后的发布包**跑真机参数准确性，发现两个互相掩盖的缺陷，于是重打为 v1.7：

| 缺陷 | 内容 |
|---|---|
| **D-19** | `parsePeakRefreshRate()` 的正则在 `i` 标志下命中 `mDefaultPeakRefreshRate: 90.0`（框架默认常量），120Hz 面板报成 90，达帧率算出 **131.3%** |
| **D-20** | `data.js` 从不写 `loading` 段，报告页 `deviceTargetHz()` 读不到就退回 P95 推断 —— v1.5 的「设备自报刷新率优先」在报告侧是死代码 |

v1.7 同时把本文第九节记的「非标刷新率 200 → 240」一并修掉（吸附加 `c ≤ p95 × 1.10` 上界），
`SCHEMA_VERSION` 由 6 升到 7。

**因此：口径 6 的报告不要与 v1.7 直接横比，跨版本对比前先看 `schemaVersion`。**
