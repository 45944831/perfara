# 采集客户端（Electron）激活移除补丁

本目录只保存**采集客户端**侧的改动与复现步骤。服务端（`backend/`）本身没有激活逻辑，
激活完全在客户端的 `resources/app.asar` 里。

## 客户端里的激活链路

| 文件 | 作用 |
|------|------|
| `src/activation.js` | 校验 `%APPDATA%\<app>\activitecode.json` 中的激活码：前 8 位 base36 = 到期 Unix 秒，后 24 位 = `SHA512(uid + ts + SECRET)` hex 前 24 位 |
| `src/trial-session.js` | 未激活时按 `unactivatedTrialSec` 给有限试用秒数，采集时每 10 秒扣 10 秒 |
| `renderer/activation-ui.js` | 顶栏「未激活，请先激活」+「激活」按钮 + 激活弹窗，未激活时拦截界面点击 |
| `renderer/index.html` | 写死 `#activation-status`、`#btn-activation` 两个节点 |
| `activiteweb/`、`generate_activation*.py` | 激活码发放服务与生成脚本（运行时未被引用） |

## 本目录的 `activation.js`

替换 `app.asar` 内的 `src/activation.js` 即可：对外 API 与原模块完全一致，
但恒返回「已激活、永久有效」，不再读写 `activitecode.json`：

- `getActivationState()` → `{activated: true, expiryLabel: '永久', hideActivationHints: true}`
- `verifyActivationCode()` → 恒 `ok`
- `isServerTrialDisabled()` → 恒 `false`（试用倒计时不再生效）
- `applyLoginFetchResult()` → 空操作（远端下发 code=2 清除指令也无效）

配合把 `renderer/index.html` 里的 `#activation-status` 与 `#btn-activation` 删掉，
顶栏就只剩「上传数据」。

## 复现步骤

```bash
# 1) 解包 asar（Windows 上的 Electron 应用：resources/app.asar）
python tools/asar_tool.py extract-all resources/app.asar ./app

# 2) 覆盖补丁文件
cp client-patch/activation.js ./app/src/activation.js
#    并删除 ./app/renderer/index.html 中的 #activation-status 与 #btn-activation

# 3) 可选：删掉运行时用不到的激活配套
rm -rf ./app/activiteweb ./app/generate_activation.py ./app/generate_activation_code.py

# 4) 重新打包
python tools/asar_tool.py pack ./app ./app-patched.asar
#    覆盖回 resources/app.asar，并删除同目录 app.asar.unpacked（若存在）
```

asar 头部布局为 `[u32 4][u32 8+L][u32 4+L][u32 L][json(L)][files...]`，
`tools/asar_tool.py` 已按此实现读写，无需安装 node 依赖。
