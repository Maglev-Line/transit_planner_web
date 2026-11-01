# 运转计划助手 · Web

交通迷绕路运转行程规划工具的**浏览器版**：首页分为「规划」与「记录」两种模式——

- **规划**：链条式手动规划（起点站 → 线路 → 方向 → 到达站），自动计算分段时长、经停站、换乘步行与付费区票价，并可导出 A4 运转图纸。
- **记录**：按时间记录一次真实运转，交通类型、线路、起止站与时间、车型等字段均可自定义，自动统计用时，导出 JSON 或 PDF；同样支持数据库线路与快车。
- **公告**：管理员可在审核台发布公告，首页右上角的公告图标会显示未读数量。

两种模式的草稿都会自动保存在浏览器 `localStorage`，可在首页弹窗的「最近」中继续编辑；
两份 JSON 使用**同一套结构**，可以互相导入（详见「方案与记录 JSON 互通」）。

## 快车 / 大站快车（数据库 JSON 原生支持）

线路可在数据库 JSON 中声明「只停部分车站」的列车服务，规划器与运转记录都能直接选用：

```json
{
  "id": "sh_m16",
  "name": "上海地铁16号线",
  "stations": ["龙阳路", "华夏中路", "罗山路", "……", "滴水湖"],
  "travel_minutes": [5, 5, 6, "……", 4],
  "express": [
    {
      "id": "rapid",
      "name": "大站车",
      "stops": ["龙阳路", "罗山路", "新场", "惠南", "滴水湖"],
      "section_minutes": [],
      "skip_minutes": 0.4,
      "headway_text": "高峰 20 分钟一班"
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 车种标识，行程段用 `service` 引用；同一线路内唯一 |
| `name` | 显示名，如 大站车 / 直达车 |
| `stops` | 停靠站，须按线路站表顺序列出（至少 2 站） |
| `section_minutes` | 可选，停靠站之间的运行分钟（长度 = 停靠站数 - 1）；留空则按基础区间估算 |
| `skip_minutes` | 可选，估算时每跳过一个中间站节省的分钟（默认 0.4） |
| `headway_text` | 可选，本车种班次文字；留空沿用线路班次 |

- 运行时长：填了 `section_minutes` 就用它，否则按「基础区间累加 − 跳站数 × skip_minutes」估算（不低于基础值的 35%）。
- 识别范围：内核校验、数据工坊编辑、规划器车种选择与可达站、换乘提示、运转记录、服务端提交校验。
- 数据工坊：线路属性面板新增「快车 / 大站车」编辑区，可增删车种、勾选停靠站。

## 支线（Y 型 / 两头分叉）

数据里支线仍然是一条**普通线路**记录（不改 JSON 结构），由 `js/line-branches.js` 在展示层识别并合并：

满足以下全部条件即视为「主线 + 支线」：

1. 线路名形如 `X线路支线` 或 `X线路支线2`，去掉「支线N」后的名字正好等于另一条线路名；
2. 两条线路 `color` 相同（忽略大小写）；
3. 两条线路共有车站数 ≥ 3（`MIN_SHARED`）。

| 形态 | 判定 | 例子 |
| --- | --- | --- |
| 末端分叉（Y 型） | 共线段在主线头部，支线尾部另起 | 上海 5 号线 / 5 号线支线 |
| 头部另起（两头分叉） | 共线段在主线尾部，支线头部另起 | 上海 10、11 号线 |
| 中间分叉 | 共线段在中间 | 由 `longestCommonRun` 自动识别 |

- **合并展示**：线路数据工坊的线路列表把主线和支线合成一条（带「支线」角标），环线判定、删除、拖动排序都以整条线路为单位。
- **线路图**：主线画在主干线上，支线从**主线分离车站后的那一段区间**（区间中点）伸出，升到与主线平行的一条支线上；支线独有车站排在主干相邻车站的同一列上，与主线严格平行。头部另起型则在**汇入车站前的那一段区间**接入主干。分离/汇入的斜线与支线轨道之间用圆角过渡（`roundedPolyline` 的二次贝塞尔），转角与车站之间留出直线段，车站不会落在转角上；支线首站站名向右上展开，避免压住连接线。拖动排序按列号换算，支线向主干左侧延伸也不会错位。
- **开新支线**：非环线线路的任意车站都可以「从本站开一条新支线」，自动按上面的命名规则生成 `X线路支线`，共用该站及之前的全部车站，并带上相同的标志色与区间时长。
- **联动改名**：改正线同名车站时，支线、方向标签、快车停靠站会一起更新，避免出现两套站名。

本项目网页版已公开，网址：https://metro-transit-planner.netlify.app/

规划规则由同一份 Python 规划内核计算——浏览器里通过 [Pyodide](https://pyodide.org/) 运行 `transit_planner.core`（`engine.py` / `models.py`），
因此换乘判定、经停站、付费区计费等规则只有一处实现，不会出现“两套逻辑各写一遍、慢慢跑偏”的问题。

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

## 规划内核与数据

| 部分 | 处理方式 |
| --- | --- |
| `core/engine.py`、`core/models.py`、`core/railway.py` | **直接复用**（纯标准库，由 `tools/sync_core.py` 同步到 `py/`） |
| `data/*.json`（含同城组合） | **直接复用** |
| 界面 | HTML/CSS/JS（本项目首页 + `plan.html` / `record.html` + `js/`） |
| 导出 | 「A4 打印 / 另存为 PDF」（浏览器排版，中文字体用系统字体，无乱码风险） |
| 设置 | `localStorage` |
| 线路库数据编辑器 | **已实现**：`editor.html`（线路图风格，支持导出 / 上传 / 提交审核） |
| 在线地图 API、12306 查询 | 暂无（浏览器直连会被 CORS 拦，需要一层 serverless 代理） |

规划方案与运转记录都支持导出 **JSON**，并可在本站重新导入继续编辑。

## 方案与记录 JSON 互通

两者共用同一套 `Trip` 结构（`name` / `date` / `city` / `note` / `transfer_walk_default` /
`paid_zone_mode` / `steps`），区别只在记录额外使用以下字段：

- 顶层 `fields`：整次运转的自定义字段（如天气、同行人）
- 每段 `start_time` / `end_time`：实际起止时刻
- 每段 `train_no` / `train_model`：车次与车型
- 每段 `extras`：本段自定义字段

导出时只用 `kind`（`"plan"` / `"record"`）标明来源。因此：

- 规划导出的 JSON 可直接在「记录 → 导入」中打开，选好起止时间即成记录；
- 记录导出的 JSON 可直接在「规划 → 导入」中打开，规划器忽略记录专有字段；
- 旧版记录的 `segments` 写法在导入时会被自动识别并升级。

## 目录结构

```
index.html             首页：欢迎语、规划 / 记录入口、友情链接
plan.html              规划器页面（含 Pyodide 启动遮罩与草稿自动保存）
record.html            运转记录页面（自定义字段、导出 JSON / PDF）
editor.html            线路数据工坊（线路图风格编辑器）
review.html            公开审核台 / 管理员审核与回滚
styles.css             全站公共样式 + 首页 + 规划器样式（含 A4 打印）
record.css             运转记录样式与 A4 记录表打印样式
editor.css             数据工坊样式
review.css             审核台样式
js/drafts.js           草稿仓库：localStorage 多草稿读写、旧版单草稿迁移
js/home.js             首页交互：新建 / 最近 / 导入
js/record.js           运转记录界面层：字段编辑、用时统计、JSON / PDF 导出
js/bridge.js           Pyodide 桥接：加载内核与数据、叠加审核通过的覆盖数据、暴露 TP.* 接口
js/app.js              规划器界面层（不含业务规则）
js/data-api.js         审核接口请求封装（/api/*）
js/city-diff.js        城市数据差异对比（审核台与提交预览共用）
js/editor.js           数据工坊界面层
js/line-branches.js    支线识别、分组与线路图几何（工坊与规划器共用）
js/review.js           审核台界面层
py/web_api.py          内核包装层：把 engine 的纯函数暴露为 JSON 接口（本项目维护）
py/transit_planner/    ← 由 tools/sync_core.py 从内核源工程同步（勿手改）
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

> 不能直接双击 `plan.html`：浏览器禁止 `file://` 页面读取内核文件，必须通过 http 访问。
> 首页 `index.html` 与记录页 `record.html` 不依赖 Pyodide，但也建议通过本地 HTTP 服务访问，避免浏览器对 `localStorage` / 文件的限制。

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

### 管理员登录按钮显示「未配置 ADMIN_TOKEN」

审核台右上角的「管理员登录」若显示为不可用（或状态为「未配置 ADMIN_TOKEN」），说明 Netlify Function
在**运行时**没有读到该环境变量。依次检查：

1. 环境变量作用域只勾了 **Builds**：必须勾选 **Functions**（Runtime 也建议勾选）。
2. 刚添加/修改了变量但**没有重新部署**：Netlify → Deploys → Trigger deploy → Deploy site。
3. 站点仍停留在旧部署：确认最新提交已构建完成。

浏览器直接打开 `https://<你的站点>/api/health`，正常应看到：

```json
{ "ok": true, "backend": "netlify-blobs", "adminConfigured": true, ... }
```

修复后回到审核台点「重新检测配置」即可，无需刷新页面。

## 管理员操作

登录后，在 `review.html` 可以看到：

- **待审核**：通过并生效 / 驳回（原因公开）/ 隐藏（仅管理员可见，用于垃圾提交）
- **已通过 / 已驳回 / 已回滚 / 全部提交**：每条都能展开查看**字段级差异**与完整 JSON，可下载 JSON
- **封禁提交者**：管理员可看到每条提交的 IP 指纹，并按 1～3650 天或永久封禁；被封禁的 IP 无法继续匿名提交
- **封禁名单**：查看生效中 / 已过期的封禁记录，可随时解除封禁或删除记录
- **公告管理**：发布 / 删除公告，支持普通、重要、提醒三级；发布后首页右上角公告图标即时显示
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
| GET | `/api/bans` | 管理员 | 封禁名单（含生效 / 过期状态） |
| POST | `/api/bans/:ipHash` | 管理员 | 封禁 IP 指纹（`durationDays` 为天数，`null` 表示永久） |
| DELETE | `/api/bans/:ipHash` | 管理员 | 解除封禁 / 删除封禁记录 |
| GET | `/api/announcements` | 公开 | 公告列表（首页公告图标使用） |
| POST | `/api/announcements` | 管理员 | 发布公告（标题、正文、级别） |
| DELETE | `/api/announcements/:id` | 管理员 | 删除公告 |
| GET | `/api/admin/check` | 管理员 | 校验口令 |

管理员请求头：`x-admin-token: <ADMIN_TOKEN>`。

匿名提交只保存来源 IP 的哈希指纹（不保存原始 IP），用于限流与恶意提交封禁；管理员可在审核台查看指纹并设置封禁时长。

## 开发流程

```bash
# 1. 内核源工程改了 core 或 data 之后，同步到本项目
python tools/sync_core.py
python tools/sync_core.py --src "Z:/3_张峻恺/运转计划生成器"   # 或显式指定内核源工程目录

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
