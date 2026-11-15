# Frontend 产物来源与复现

## 现状（为什么是「或」分支）

本仓库 `perfara/frontend/` **不含 SPA 源码**，只有：

- `dist/`：Vue + Vite 的构建产物（`index.html`、favicon、`assets/` 下带内容哈希的 JS/CSS）。
  它被 `perfara/.gitignore` 的 `dist/` 规则排除，**不入库**；磁盘上的这份是运行/打包时直接使用的产物。
- `favicon/`：三个图标源文件（patch 会复制进 `dist/`）。
- 4 个 `patch-spa-*.js`：入库的**后处理脚本**，构建产物每次重建后都要重新应用。
- `build_frontend.py` / `build-info.json` / 本文件：构建流程、产物锁定与说明。

SPA 源码在上游 Vue/Vite 项目（开源署名见 `patch-spa-attribution.js`），由维护者在仓库外单独检出。
因此「源码入库」做不到，改为固化**构建脚本 + 产物来源说明 + 版本锁定**。

## 产物来源

| 项 | 来源 |
| --- | --- |
| dist 主体 | 外部 SPA 源码检出目录执行 `npm ci && npm run build`，产物默认在源码目录的 `dist/` |
| favicon | `perfara/frontend/favicon/`，由 `patch-spa-favicon.js` 复制进 `dist/` |
| index.html 的外链字体剥离 | `patch-spa-offline-fonts.js`（改由系统字体栈回退，保证离线可用） |
| 开源署名 | `patch-spa-attribution.js` 注入 |
| bundle 功能适配 | `patch-spa-metric-config.js`（metricConfig 关闭组、对比/趋势空图隐藏、采集参数顺序） |

源码检出目录通过环境变量 `PERFARA_SPA_SRC` 指定；若 Vite 输出目录不是默认的 `dist/`，
用 `PERFARA_SPA_DIST` 指定。工具链可用 `PERFARA_NODE` / `PERFARA_NPM` 覆盖。

## 复现步骤

```bash
# 1) 指向外部 SPA 源码检出目录（本仓库不含它）
export PERFARA_SPA_SRC=/path/to/spa-checkout

# 2) 构建 + 复制产物 + 应用 4 个 patch + 写 build-info.json
python perfara/frontend/build_frontend.py build

# 或：源码缺失时只想锁定现有产物（不构建、不改动 dist/）
python perfara/frontend/build_frontend.py record

# 3) 校验现有 dist/ 与 build-info.json 是否一致
python perfara/frontend/build_frontend.py verify
```

`build` 在 `PERFARA_SPA_SRC` 未设置或指向的目录没有 `package.json` 时**直接报错退出**，
不会联网、不会伪造构建、不会改动 `dist/`。这是刻意的：产物没法凭空生成，缺源码就必须说清楚。

`build` 内部依次执行：`npm ci` → `npm run build` → 覆盖式复制产物到 `dist/`（**不删除**
`dist/` 里的既有文件，避免误删本地产物；如需全新产物请自行先清理）→ 按下列顺序跑 4 个 patch。

### 4 个 patch 的应用顺序

1. `patch-spa-favicon.js` —— 复制图标并在 `index.html` 注入 `<link>`（幂等）。
2. `patch-spa-offline-fonts.js` —— 剥离 `fonts.googleapis.com / fonts.gstatic.com` 外链（幂等，支持 `--check`）。
3. `patch-spa-attribution.js` —— 注入顶部署名（幂等，支持 `--check`）。
4. `patch-spa-metric-config.js` —— 给 bundle 注入 4 处补丁并做 `node --check`（幂等）。

前 3 个只改 `index.html`，互不冲突；第 4 个改 `assets/*.js`，放最后。

## 已知陷阱（版本锁定的重点）

`patch-spa-metric-config.js` **硬编码了 Vite 内容哈希文件名**：
`index-CX8C-b2E.js`、`Compare-CqE700DJ.js`、`Trend-D1yYXFi4.js`。
一旦上游源码变更导致这些内容哈希改变，脚本会报 `ENOENT` 或 `anchor not found`。
此时必须同步更新脚本里的文件名与注入锚点，再重跑 `build`。**不要**只更新产物而跳过补丁。

## 版本锁定：build-info.json

`build_frontend.py` 生成，记录：

- `toolchain.node` / `toolchain.npm`：构建/记录时探测到的版本；
- `artifacts[]`：`dist/` 下每个产物的相对路径、字节数、sha256；
- `patches[]`：4 个 patch 脚本的字节数与 sha256（即「patch 版本」）；
- `generated_at`（UTC）、`mode`、`note`：生成时间与本次是 `build` 还是
  `record-existing-artifacts`（后者明确标注「仅记录现有产物快照，未从源码构建」）。

`verify` 子命令逐项重算哈希核对，用于确认 `dist/` 未被意外改动、或换了机器后产物是否一致。
`mode=record-existing-artifacts` 表示这份清单锁定的是磁盘上现有产物，不是一次可复现的源码构建；
要得到可复现构建记录，请用 `build`。
