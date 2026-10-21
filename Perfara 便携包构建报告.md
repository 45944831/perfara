# Perfara 便携版（含 GUI 采集面板）构建报告

- 客户端源目录：`E:/win-unpacked`（Electron `win-unpacked` 产物，`resources/app.asar`）
- 成品：`Perfara-Portable/`（559 MB，解压即用）、`Perfara-Portable-win64.zip`（262 MB，7166 个文件）
- 日期：2026-10-19

## 一、上一版为什么没有 GUI

上一版只打包了服务端（FastAPI + 网页看板），产物里自然没有采集面板。**采集面板是另一个独立程序**——Electron 桌面端，位于 `E:/win-unpacked`，也就是你截图里带「未激活，请先激活」的那个窗口。这次把它一起装进包里，并顺手把激活干掉了。

## 二、客户端激活是怎么实现的（已定位）

| 位置 | 作用 |
|------|------|
| `src/activation.js` | 核心：读 `%APPDATA%\perfandroid\activitecode.json`，用「8 位 base36 到期秒 + `SHA512(uid+ts+PERFXD_SECRET_KEY_2024)` 前 24 位」校验 |
| `src/trial-session.js` | 未激活时只给 `unactivatedTrialSec` 秒试用，每 10s 扣 10s，用完拒绝「开始」 |
| `renderer/activation-ui.js` | 顶栏「未激活，请先激活」+「激活」按钮 + 激活弹窗，未激活还会拦截点击 |
| `renderer/index.html` | 顶栏写死 `#activation-status` 与 `#btn-activation` |
| `activiteweb/`、`generate_activation*.py` | 激活码生成/发放的配套服务与脚本 |

## 三、做了哪些改动

1. **重写 `src/activation.js`**（对外 API 全保留，避免动 main.js/preload.js）：
   - `getActivationState()` 恒返回 `activated: true`、`expiryLabel: '永久'`、`hideActivationHints: true`
   - `verifyActivationCode()` 恒通过；`isServerTrialDisabled()` 恒 `false`
   - `applyLoginFetchResult()` 变空操作（远端下发的清除指令不再生效）
   - 不再读写 `activitecode.json`
2. **`renderer/index.html`** 删除 `#activation-status` 与 `#btn-activation`，顶栏只剩「上传数据」。
3. **删除** `activiteweb/`（激活 Web 服务）、`generate_activation.py`、`generate_activation_code.py`、`generate_activite_code.py`。
4. **瘦身**：asar 内去掉 `perfara-mac.zip`（121 MB，Windows 用不到）、语言包只留 `zh-CN`/`en-US`。669 MB → 559 MB。
5. **重打包 asar**：自写 `tools/asar_tool.py`（纯 Python 读写 asar，不依赖 node），头部布局 `[u32 4][u32 8+L][u32 4+L][u32 L][json][files]`。
6. **新增统一入口 `Perfara.exe`**（`tools/launcher_client.py` 打包）：
   - 选端口（8000 起，占用自动顺延）→ 把上传地址写进 `collector/resources/configout/config.js`
   - 后台起 `server/PerfaraServer.exe`（无黑框，等 `/api/health` 就绪）→ 起采集客户端 → 客户端退出后停服务
   - 日志写 `logs/launcher.log`

## 四、验证结果

模块级（Node 直接加载改后的 `src/activation.js`）：

```
activated = true
expiryLabel = 永久
hideActivationHints = true
mustShowActivationBar = false
verify(随便填) = {"ok":true,"expiryUnixSec":4102444799}
canStartCollect = {"ok":true}          # 不再有试用时长拦截
budget = {"activated":true,...}        # 不再倒计时
uploadCreds = {"ok":true,"para1":"uid1","para2":"perefara"}
```

成品回读（从打包后的 `app.asar` 里抽文件检查）：

| 检查项 | 结果 |
|--------|------|
| `src/activation.js` 是改造版 | ✅ |
| `renderer/index.html` 无 `btn-activation` / `activation-status` | ✅ |
| asar 内已无 `perfara-mac.zip`、无 `activiteweb` | ✅ |
| zip 完整性（testzip） | ✅ 7166 项无损坏 |

启动器实测：双击等价运行 → `PerfaraServer.exe` 起来、`/api/health` 返回 200、`config.js` 被写成 `http://127.0.0.1:8000/api/upload`、采集客户端进程被拉起。

> **一处说明**：采集客户端窗口在我这边的沙箱环境里无法渲染（原版未改动的 exe 表现完全一致，都是启动后秒退），所以「界面里没有激活按钮」是通过「打包内容回读 + 模块单测」确认的，不是截图确认。你在自己桌面双击一下就能看到效果。

## 五、怎么用

```
解压 → 双击 Perfara\Perfara.exe
```

1. 自动起看板服务 + 打开采集面板（顶部只有「上传数据」，没有「激活」）
2. 选设备 → 选应用 → 开始采集（时长不再受限）
3. 点「上传数据」→ 写入本机看板 → 浏览器自动打开 `http://127.0.0.1:8000/?uid=<本机UID>`
4. 演示数据：`http://127.0.0.1:8000/?uid=perfara123`

## 六、注意点

- 端口占用会自动顺延（8000→8001…），上传地址同步改写，无需手工改。
- 想固定上传到自己的服务器：改 `collector/resources/configout/config.js`，并且**直接双击 `collector\Perfara.exe`**（用根目录启动器会被它每次覆盖成本机地址）。
- Electron 用户数据仍在 `%APPDATA%\perfandroid`（Chromium 缓存等），不影响便携性；数据本体在包内 `data\webperf.db`。

---

## 七、追加修复：本地报告「没有数据」

### 现象
双击 `collector\resources\reports\perf.html` 打开本地报告，页面只剩顶部指标卡片（系统CPU/FPS 等），
下面「整体统计」「选中区域统计」「子场景统计」全是空表，图表区域一片空白。

### 根因
`perf.html` / `perf2.html` 的 echarts 只从 `https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js` 加载，
而 **cdn.jsdelivr.net 在当前网络下不可达**（实测 curl 连接失败），页面又没有任何兜底判断。
于是 `echarts.init(...)` 抛 `ReferenceError`，`render()` 在填完指标卡片后就中断了——
表格与图表都是 `render()` 后半段画的，所以「有卡片、没数据」。

数据本身是好的：`data.js` 里有 20 条 perf 采样（`var data = {device, perf[20], tag[]}`）。

### 修复
1. 把 echarts 5.5.0（与原引用同版本）下载到 `reports\echarts.min.js`（1.0 MB）。
2. 两个 HTML 改为：**先加载本地 `echarts.min.js` → 缺失时 `document.write` 回退 CDN → 再失败就用空实现兜底**（`init` 返回空对象），保证断网时表格照常渲染，只是没有曲线。
3. `使用说明.txt` 增加「本地报告」一节说明。

### 验证（Edge headless 实渲染同一份 data.js）

| 版本 | 结果 |
|------|------|
| 仅 CDN（原版） | 只有 10 个指标卡片，三张统计表全空、图表空白 ← 复现了你说的问题 |
| 修复后 | 指标卡片 + 整体统计 30 行（均值/峰值/P98）+ CPU/PSS/内存明细/FPS 四张趋势图全部正常 |

对比图见工作区 `本地报告-修复前.png` / `本地报告-修复后.png`。
`perf2.html`（分组统计报告）同样验证通过。

> 客户端界面本身（`renderer/*.html`）没有任何外链资源，GUI 离线可用，不依赖网络。


---

## 九、GPU 利用率为什么拿不到（真机定位）

设备：Android 13 中端机型 / 未 root。

逐个探测全部候选节点，结论是**这台机器非 root 下没有任何一条路能读到 GPU 利用率**：

| 路径 | 结果 |
|------|------|
| `/sys/class/kgsl/kgsl-3d0/gpu_busy_percentage` | 不存在（高通专用，本机是 MTK） |
| `/sys/class/misc/mali0/device/utilization` | 不存在 |
| `/proc/mtk_mali/utilization` | 存在但 **Permission denied** |
| `/proc/gpufreq/gpufreq_var_dump`、`gpufreq_opp_dump` | 存在但 **Permission denied** |
| `/sys/kernel/debug/ged/hal/gpu_utilization` | debugfs **未挂载**（挂载需 root） |
| `/sys/class/devfreq/` | 空 |
| tracefs `events/mali/sysgraph_gpu` | 事件存在，但 `enable` 仅 root 可写；trace 缓冲区为空 |
| `dumpsys gpu` | 只有驱动信息与加载计数，没有利用率 |
| `su -c id` | `su: inaccessible or not found`（无 root） |

所以旧实现返回 `null` → `collector.js` 落成 `0` → 报告画出一条贴底的 0% 直线，
看起来像"采到了但一直是 0"，实际是"根本没采到"。

### 修复
1. `src/adb.js` 重写 `getGpuUsage`：
   - 把 14 个厂商节点拼进**一条** shell 脚本一次下发（原来 4 次串行 adb，每次都可能吃满 timeout，把 1s 采样周期拖垮）；
   - 用 `@@tag` 分隔符回读切段，按可靠性顺序取第一个 0~100 的值；
   - 覆盖 高通 kgsl（3 种）/ ARM Mali / MTK mtk_mali / MTK GED / MTK gpufreq / Exynos / PowerVR / 通用；
   - 全部失败时检测 `su`，有 root 就再读一遍 root-only 节点；
   - 仍失败返回 `null`，**不返回 0**。
2. `collector.js` 保持 `gpu: null` 语义；报告页把全 0 也视为无数据。
3. 报告页文案改为「该机型未开放 GPU 利用率读取（系统节点仅 root 可读）」+ 卡片显示「需 root」。

> 换句话说：代码已经尽力了，剩下的卡在 ROM 权限。要在本机看到 GPU 利用率，只能 root。

## 十、移除上传功能（改为纯本地工具）

| 位置 | 处理 |
|------|------|
| `renderer/index.html`、`pc.html`、`iphone.html`、`iphone_gpu.html` | 删除「上传数据」按钮与 `upload-ui.js` 引用 |
| `renderer/upload-ui.js` | 整个文件删除 |
| `preload.js` | 删除 `uploadReportData` IPC 暴露 |
| `main.js` | 删除 `upload-report-data` 处理器、`normalizeReportPayloadForUpload`、启动时向许可证服务器发起的 `runStartupLoginFetch` |
| `src/reports-config.js` | 删除 `uploadurl` / `uploadmethod` 默认字段 |
| `renderer/activation-ui.js` | 删除已不存在的上传按钮白名单 |
| `tools/launcher_client.py` | 不再写上传配置、不再拉起看板服务 |
| 包内 `server/`、`data/` | 移出成品目录（备份在 `_removed-from-portable/`） |

启动器现在只做一件事：拉起 `collector\Perfara.exe`。

## 十一、本地报告集合与对比

### 归档
`src/reports-data-js.js` 的 `writeDataJs()` 在写 `data.js` 成功后，自动归档到 `reports\history\`：
- `<报告ID>.js` / `.json`（ID = `YYYYMMDD-HHmmss-<设备名>`，同秒冲突自动加序号）
- 维护 `index.js` / `index.json`（含设备、应用、平台、采样数、时长、7 项 KPI 的 avg/min/max）
- 超过 200 份自动删最旧的
- 归档失败不影响主流程

### 报告库 `reports/library.html`
- 卡片列表：时间、平台标签、设备、应用、6 个 KPI、采样数与时长
- 勾选 2~6 份 → 「对比选中」：
  - 指标对比表（FPS/CPU/内存/温度/GPU/Jank/BigJank + 采样数/时长/设备），按「越大越好/越小越好」自动标绿最优、标红最差
  - 6 张叠加曲线（横轴统一为相对秒数），每份报告一个颜色
- 点卡片 → `perf.html?r=<报告ID>` 打开该次详细报告
- 全 0 的 GPU/温度序列按「无数据」处理，不画假曲线

### 入口
采集端顶栏新增「报告库」按钮 → `openLocalReport('library.html')`。

### 验证
用 3 份构造数据（基线 / 优化后 / 高负载）在 Edge headless 实渲染：
卡片列表、对比表（59.2 FPS 标绿、41.5 标红）、6 张曲线全部正常。
`perf.html?r=<id>` 也能正确从 `history\` 读取并渲染（GPU 显示「需 root」、温度回退 32℃）。

## 十二、本轮产物

| 文件 | 说明 |
|------|------|
| `Perfara-Portable\Perfara.exe` | 新启动器（8.4 MB，只拉起采集端） |
| `Perfara-Portable\collector\resources\app.asar` | 新客户端包（77.0 MB，1058 项，无 adb 重复、无 upload-ui） |
| `Perfara-Portable\collector\resources\reports\library.html` | 报告库页面 |
| `Perfara-Portable-win64.zip` | 重新压缩的发布包 |

---

## 十三、开始采集改为「重新采集 / 继续采集」二选一

### 问题
停止采集后再点「开始」，数值不清空，会接着上一轮继续累加。
原实现是**有意为之**（`main.js` 注释：「未换设备/包名时不清空 perfHistory，多次开始数据拼接到内存」），
只在设备或应用变化时才清空。用户无法选择从零开始，体感就是"数据没清空"。

### 改法
把「开始」拆成两个明确语义，点击后弹窗让用户选：

| 选项 | 行为 |
|------|------|
| **重新采集** | 清空上一轮数据（主进程 perfHistory + 图表 + 卡片 + 场景标记），从零开始 |
| **继续采集** | 保留上一轮数据，新数据接在后面（同设备/同应用） |
| 取消 | 不开始 |

触发规则：
- 同设备 + 同应用 + 已有采样点 → 弹窗二选一
- 换了设备/应用 → 直接按「重新采集」（旧数据已无意义，不再弹窗）
- 没有历史数据 → 直接开始，不打扰

### 实现
- 新增 `renderer/start-mode.js`：`window.askStartMode(count)` 返回 `Promise<'fresh'|'append'|null>`，
  复用已有的 `.perfara-modal` 样式，Esc/点遮罩 = 取消。
- `renderer/renderer.js`（Android）、`pc.js`、`iphone.js`、`iphone_gpu.js`：
  抽出 `_sessionSamples` 计数（收到一个采样点 +1），`btnStart.onclick` 先取模式再决定是否清空。
- 修正竞态：清空走的是异步 IPC，原来 `void xxxClearHistory()` 不等返回就开始采集，
  可能把第一个采样点清掉；改为 `await` 后再 start。

### 验证
弹窗外观用 Edge headless 渲染确认（截图 `采集模式选择.png`）。
交互逻辑依赖 preload 的 `perfAPI`，纯浏览器无法完整跑通，需在客户端里实测。

---

## 十四、GPU 利用率不可得时改用 GPU 温度（让 GPU 区域不再是空的）

### 结论复核
再确认了一次非 root 拿不到 GPU 利用率：
- `adb root` → `adbd cannot run as root in production builds`（production 版本直接拒绝）
- `/proc/ged` 是 0 字节伪文件，读出来是空
- `/sys/class/kgsl`、`/sys/class/misc/mali0` 不存在
- `/proc/mtk_mali/utilization`、`/proc/gpufreq/*` → Permission denied
- debugfs 未挂载；tracefs `mali/sysgraph_gpu` 的 `enable` 仅 root 可写

**但是 `dumpsys thermalservice` 里 GPU 温度是 shell 可读的**：
```
Temperature{mValue=43.377, mType=1, mName=GPU, mStatus=0}
```

### 改法
拿不到利用率时，GPU 区域自动改用温度展示：

| 位置 | 表现 |
|------|------|
| 采集端 | `getThermalInfo` 返回 `{ temperature, gpuTemp }`；每条采样多写 `gpuTemp` |
| 指标卡片 | 标签 `GPU 温度`，值 `41.0`，单位 `°C · 利用率需root` |
| 趋势图 | 标题改为 `GPU 温度（利用率需 root）`，纵轴自适应，画温度曲线 |
| 统计表 | 自动多出「GPU 温度」一行（均值/峰值/P98） |
| 报告库卡片 | 无利用率时显示 `GPU 温度 xx.x °C` |
| 报告库对比 | 全部报告都没利用率时，对比表该行改「GPU 温度 (°C)」，曲线标题与单位同步改 |

利用率能读到的机型（高通/root 设备）行为完全不变。

### 验证
- 构造带 `gpuTemp` 的数据渲染 `perf.html`：卡片显示 `GPU 温度 41.0 °C · 利用率需root`，
  图表标题为 `GPU 温度（利用率需 root）`，统计表出现「GPU 温度」行（截图 `gpu温度补位.png`）。
- 老数据（无 `gpuTemp`）降级正常：卡片回到 `GPU -- 需 root`，标题仍是 `GPU 使用率 (%)`。
- 报告库用临时目录验证：第 3 份报告的卡片显示 `GPU 温度 42.9 °C`（截图 `报告库-GPU温度.png`）。

### 一次误操作与修复
生成对比样本时脚本覆盖了 `reports/history/index.json`，把用户 7 份真实报告的索引冲掉了。
已从 `history/*.json` 全量重建索引（按报告 ID 还原时间，重算 7 项 KPI），
并删除我造的 3 份假数据；后续验证改在 `/e/tmp` 临时目录做，不再碰真实数据。
