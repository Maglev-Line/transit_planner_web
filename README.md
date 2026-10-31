# 运转计划助手 · Web

交通迷绕路运转行程规划工具的**浏览器版**：链条式手动规划（起点站 → 线路 → 方向 → 到达站），自动计算分段时长、经停站、换乘步行与付费区票价，并可导出 A4 运转图纸。

本项目网页版已公开，网址：https://metro-transit-planner.netlify.app/

与桌面版《运转计划助手》**共用同一份 Python 规划内核**——浏览器里通过 [Pyodide](https://pyodide.org/) 运行 `transit_planner.core`（`engine.py` / `models.py`），
因此换乘判定、经停站、付费区计费等规则与桌面版**逐字节一致**，不存在“两套逻辑各写一遍、慢慢跑偏”的问题。

## 新增：线路数据工坊 + 公开审核台

城市线路库不再只能由开发者改：

| 页面 | 作用 |
| --- | --- |
| `editor.html` · **线路数据工坊** | 以**线路图**方式编辑城市数据：拖拽站点排序、点区间改时长、插入/删除车站、改换乘关系；也支持直接编辑 JSON、上传城市 JSON、导出城市 JSON。 |
| `review.html` · **数据审核台** | **所有访客**都能查看每一次匿名提交、完整数据、字段级差异、审核结果、已生效数据和回滚记录；管理员登录后可执行通过 / 驳回 / 隐藏 / 回滚。 |

### 数据流

```
匿名用户               管理员                    所有访客
   │                      │                         │
   ├─ 编辑线路图/JSON      │                         │
   ├─ POST /api/submissions ──► 待审核记录（公开可读） │
   │                      ├─ 通过 ──► 覆盖数据写入 Netlify Blobs
   │                      │                         │
   │                      │                页面启动 → GET /api/cities
   │                      │                → 写入 Pyodide 虚拟文件系统 /data
   │                      │                → 规划器直接使用最新数据
   │                      │                         │
   │                      └─ 回滚（内置 / 任意历史版本）◄─ 随时可回滚，记录公开
```

- **匿名提交**：任何人无需注册即可提交修改或新建城市，提交时填写修改说明（公开）与联系方式（仅管理员可见）。
- **双重校验**：编辑器用 Python 内核校验；服务端再用纯 JS 做结构与数值防呆，拒绝会破坏内核解析的数据。
- **立即生效**：管理员通过后，所有访客刷新页面即用上覆盖数据，无需重新部署。
- **可回滚**：每次通过都会保留上一版本（最多 15 个），可回滚到任意历史版本或直接回到内置数据。
- **公开透明**：提交说明、完整 JSON、差异对比、审核结果、回滚记录全部公开；联系方式与 IP 指纹不公开。

## 与桌面版的关系

| 部分 | 处理方式 |
| --- | --- |
| `core/engine.py`、`core/models.py`、`core/railway.py` | **直接复用**（纯标准库，由 `tools/sync_core.py` 同步到 `py/`） |
| `data/*.json`（含同城组合） | **直接复用**，与桌面版同源 |
| `ui/`（PySide6 界面） | 重写为 HTML/CSS/JS（本项目 `index.html` + `js/`） |
| `pdf/exporter.py` | 改为「A4 打印 / 另存为 PDF」（浏览器排版，中文字体用系统字体，无乱码风险） |
| 设置（QSettings） | 改为 `localStorage` |
| 线路库数据编辑器 | **已实现**：`editor.html`（线路图风格，支持导出 / 上传 / 提交审核） |
| 在线地图 API、12306 查询 | 暂无（浏览器直连会被 CORS 拦，需要一层 serverless 代理） |

行程方案的 **JSON 格式与桌面版完全互通**：桌面版导出的方案可以直接「导入方案」，反之亦然。

## 目录结构

```
index.html             规划器页面
editor.html            线路数据工坊（线路图风格编辑器）
review.html            公开审核台 / 管理员审核与回滚
styles.css             规划器样式（含 A4 打印、差异对比公用样式）
editor.css             数据工坊样式
review.css             审核台样式
js/bridge.js           Pyodide 桥接：加载内核与数据、叠加审核通过的覆盖数据、暴露 TP.* 接口
js/app.js              规划器界面层（不含业务规则）
js/data-api.js         审核服务客户端（/api/*）
js/city-diff.js        城市数据差异对比（审核台与提交预览共用）
js/editor.js           数据工坊界面层
js/review.js           审核台界面层
py/web_api.py          内核包装层：把 engine 的纯函数暴露为 JSON 接口（本项目维护）
py/transit_planner/    ← 由 tools/sync_core.py 从桌面版同步（勿手改）
py/data/*.json         ← 同上
py/manifest.json       同步清单（浏览器按它加载文件）
netlify/functions/api.mjs   Netlify Function 入口（/api/*）
netlify/lib/api-core.mjs    审核接口路由与业务逻辑（可用内存存储单测）
netlify/lib/city.mjs        城市 JSON 服务端校验
tools/sync_core.py     同步内核与数据
tools/smoke_test.py    内核接线冒烟测试
tools/test_server.mjs  审核接口测试（内存存储，无需 Netlify 账号）
tools/build_site.mjs   构建 dist/（Netlify 的 publish 目录）
netlify.toml           Netlify 部署配置（构建、函数、重写、缓存头）
```

## 本地运行

### 只跑前端（不需要审核后端）

```bash
python -m http.server 8010
# 打开 http://127.0.0.1:8010/
```

编辑器仍可正常使用，可编辑与**导出 JSON**；「提交审核」会提示审核服务未启用。

> 不能直接双击 `index.html`：浏览器禁止 `file://` 页面读取内核文件，必须通过 http 访问。

### 完整本地环境（含 Netlify Functions + Blobs）

```bash
npm install
# 在项目根目录新建 .env（已加入 .gitignore）：
#   ADMIN_TOKEN=dev-token
npx netlify-cli dev
```

`netlify dev` 会执行 `npm run build`（生成 `dist/`）、启动 Functions，并用本地 Blobs 模拟存储；
打开终端提示的地址即可测试「匿名提交 → 管理员登录 → 通过 → 全站生效 → 回滚」的完整流程。

首次打开需从 CDN 下载约 10&nbsp;MB 的 Pyodide 运行时（之后走浏览器缓存）。审核台不需要 Pyodide，打开很快。

## 部署到 Netlify

仓库已按「Git 连接 Netlify 自动构建」配置好，无需在 UI 里填构建命令：

1. Netlify 导入本仓库（Base directory 留空）。
2. `netlify.toml` 已配置：
   - Build command：`node tools/build_site.mjs`
   - Publish directory：`dist`
   - Functions directory：`netlify/functions`
3. **设置管理员口令**：Netlify → Project configuration → Environment variables → 新增
   `ADMIN_TOKEN`，值为一串足够长的随机字符串（建议 32 位以上），作用域勾选 **Functions**（以及 Runtime）。
4. 重新部署（Deploy site）。首次调用审核接口时 Netlify 会自动创建 Blobs 存储，无需额外配置。
5. 打开 `https://<你的站点>/review.html`，点「管理员登录」，粘贴 `ADMIN_TOKEN` 的值。

管理员口令只保存在当前标签页的 `sessionStorage`，关闭标签页即失效；修改 Netlify 环境变量后旧口令立即作废。

## 管理员操作

登录后，在 `review.html` 可以看到：

- **待审核**：通过并生效 / 驳回（原因公开）/ 隐藏（仅管理员可见，用于垃圾提交）
- **已通过 / 已驳回 / 已回滚 / 全部提交**：每条都能展开查看**字段级差异**与完整 JSON，可下载 JSON
- **已发布数据**：当前生效的覆盖数据、来源提交、可回滚版本数；可导出 JSON、回滚到上一版或内置数据
- **回滚记录**：每次回滚的时间、原版本、目标版本与公开说明

回滚说明会公开显示。回滚到内置数据后，`/api/cities` 不再返回该城市，规划器自动回到内置线路库。

## 审核接口一览

所有接口同源，位于 `/api/*`（由 `netlify.toml` 重写到 `netlify/functions/api.mjs`）。

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/health` | 公开 | 服务状态、是否已配置管理员口令 |
| GET | `/api/cities` | 公开 | 全部已生效的覆盖数据（规划器启动时加载） |
| GET | `/api/submissions?status=` | 公开 | 审核记录（`pending/approved/rejected/reverted/all`；隐藏记录仅管理员可见） |
| POST | `/api/submissions` | 匿名 | 提交修改 / 新城市 |
| GET | `/api/submissions/:id` | 公开 | 提交详情（含 `doc` 与用于对比的 `base`；联系方式仅管理员可见） |
| POST | `/api/submissions/:id/approve` | 管理员 | 通过并立即生效 |
| POST | `/api/submissions/:id/reject` | 管理员 | 驳回并记录原因 |
| POST | `/api/submissions/:id/hide` | 管理员 | 隐藏垃圾提交 |
| GET | `/api/published` | 公开 | 当前生效的覆盖数据列表 |
| GET | `/api/published/:name` | 公开 | 当前生效数据 + 历史版本元信息 |
| POST | `/api/published/:name/revert` | 管理员 | 回滚（`to: "builtin"` 或历史版本 `submissionId`） |
| GET | `/api/rollbacks` | 公开 | 回滚记录 |
| GET | `/api/admin/check` | 管理员 | 校验口令 |

管理员请求头：`x-admin-token: <ADMIN_TOKEN>`。

## 开发流程

```bash
# 1. 桌面版改了 core 或 data 之后，同步到本项目
python tools/sync_core.py
python tools/sync_core.py --src "Z:/3_张峻恺/运转计划生成器"   # 或显式指定桌面版目录

# 2. 不开浏览器，先验证内核接线与数据工坊接口
python tools/smoke_test.py

# 3. 验证审核接口（内存存储，无需 Netlify）
node tools/test_server.mjs

# 4. 构建 Netlify 发布目录
node tools/build_site.mjs

# 5. 刷新浏览器页面（改了 styles.css / js 建议强制刷新 Ctrl+Shift+R）
```

**分工原则**：所有算时长、算经停站、判换乘、划付费区的逻辑都留在 Python 内核里；
`js/app.js` 只负责把内核返回的 JSON 画出来。新增功能时不要在 JS 里重算这些数字。
数据工坊同理：结构校验以 `py/transit_planner/core/models.py` 为准，服务端只做防呆校验。

## 数据与安全

- **城市名即文件名**：仅允许中文、字母、数字与常见符号，拒绝斜杠、`..` 与保留名，避免写入 `/data` 之外。
- **体积限制**：单次提交上限约 1.5 MB；线路 ≤ 400 条、单线车站 ≤ 800。
- **防滥用**：同一 IP 10 分钟内最多 8 次提交；审核队列上限 1200 条；垃圾提交可由管理员隐藏。
- **隐私**：联系方式只存储、只对管理员返回；公开页面只显示 IP 指纹（截断哈希）给管理员。
- **管理员口令**：服务端用 SHA-256 + 定时安全比较校验；前端不持久化到 `localStorage`。

## 已知限制与后续可做

- **首次加载较慢**：Pyodide 运行时约 10&nbsp;MB，之后由浏览器缓存；可加 Service Worker 做离线缓存（审核台不受影响）。
- **PDF**：走浏览器打印（`导出图纸 (PDF)` → 目标选「另存为 PDF」），排版为 A4、可直接持图运转。
- **同城组合**（如「上海-苏州」）是运行时合并的虚拟城市，不能直接编辑；请分别编辑组成城市的数据。
- **广州 / 佛山** 共用 `广州-佛山.json`，数据工坊中显示为「广州-佛山」。
- **在线地图接口 / 12306 查询**尚未实现。
- **手动段**的时长可手填，也可勾选「按时刻表乘坐列车」由发时/到时自动计算。
