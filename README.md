# 运转计划助手 · Web

面向交通迷的运转（行程规划与记录）Web 应用：把想坐的线路、想去的车站串成一条自定义行程，或按实际时间记录已经完成的运转；附带在线线路数据工坊、匿名提交审核与站信系统。

站点为**纯静态前端**：行程计算逻辑用 Python 编写，随 [Pyodide](https://pyodide.org/) 在浏览器内运行，线路数据也只在本地加载。仅线路数据审核、已发布数据下发与站信依赖 Netlify Functions + Netlify Blobs。

> 终端用户请看站点首页右上角「使用说明」，对应仓库根目录的 [`instructions.md`](./instructions.md)。本文档面向仓库维护者与贡献者。

## 功能概览

- **链条式行程规划**：按「起点站 → 线路 → 方向 → 到达站」逐段串联，可自由绕路；支持数据库线路、国铁车次查询与完全手动三种录入方式。
- **自动计算**：区间时长、经停站、方向判定、换乘 / 转乘、付费区分组、票价合计。
- **智能规划**：勾选想乘坐的线路与目标车站，生成覆盖目标的行程方案，并按换乘、转乘与时长排序。
- **运转记录**：按时间记录每段乘车（含车次、车型、自定义字段），自动统计用时并导出数据或 A4 PDF。
- **按城市懒加载**：新建行程先选城市，列表按地区分组、组内按拼音排序；进入编辑后可随时「切换城市」，只下载所选城市的线路数据。
- **线路数据工坊**：以线路图 / 属性表单 / 源码三种方式编辑城市数据，支持「快捷增加」按文本批量录入整条线路、为每个方向单独设置停靠站，实时校验，匿名提交审核。
- **数据审核台**：提交记录、差异对比、已发布数据、回滚、封禁与站信管理。
- **线路库**：按线路系统分组展示，识别支线，支持同城组合（上海-苏州、广州-佛山、珠江三角洲）与跨城市共用车站声明。
- **强互通系统与方向停靠站**：只登记站名的城际 / 国铁系统可作为转乘提示来源（国铁提示可双击查询车次）；线路可声明上下行停靠站不一致。

## 技术架构

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 页面 | `index.html`、`plan.html`、`record.html`、`editor.html`、`review.html` | 原生 HTML + CSS + JS，无前端框架 |
| 界面逻辑 | `js/*.js` | 状态、渲染与交互；不含业务计算 |
| 桥接层 | `js/bridge.js` | 启动 Pyodide、写入内核、按城市按需加载数据、转发 `web_api` 的 JSON 接口 |
| 计算内核 | `py/transit_planner/` | 与桌面版共享的权威实现（分段、换乘、付费区、智能规划等） |
| 内核接口 | `py/web_api.py` | 把内核包装为 `api_*` 函数，统一返回 `{"ok": ...}` 的 JSON |
| 城市数据 | `py/data/*.json` | 每个城市（或共用文件）一份线路库 |
| 加载清单 | `py/manifest.json` | 浏览器需要加载的内核文件与数据文件，避免硬编码 |
| 审核服务 | `netlify/functions/api.mjs`、`netlify/lib/*.mjs` | 提交、审核、发布、回滚、站信、封禁 |
| 构建 | `tools/build_site.mjs` | 把浏览器端需要的文件复制到 `dist/` |

## 目录结构

```text
.
├─ index.html / plan.html / record.html / editor.html / review.html
├─ styles.css / record.css / editor.css / review.css
├─ instructions.md          站点「使用说明」内容（运行时按需加载）
├─ js/                      界面层脚本
│  ├─ app.js                规划模式
│  ├─ record.js             记录模式
│  ├─ editor.js             线路数据工坊
│  ├─ review.js             数据审核台
│  ├─ home.js / contact.js / drafts.js
│  ├─ bridge.js             Pyodide 桥接与城市数据按需加载
│  ├─ city-picker.js        城市选择弹窗（按地区分组、拼音排序）
│  ├─ pdf-export.js         导出 PDF（html2canvas 截图 + 最小 PDF 写入）
│  ├─ vendor/html2canvas.min.js  导出 PDF 用的页面截图库
│  ├─ line-branches.js      支线识别与几何计算
│  ├─ line-library.js       线路库面板（规划 / 记录共用）
│  ├─ city-diff.js          提交差异对比
│  └─ markdown-preview.js   使用说明的 Markdown 子集渲染
├─ py/
│  ├─ transit_planner/      共享计算内核
│  ├─ web_api.py            浏览器端内核接口
│  ├─ route_planner.py      智能规划
│  ├─ manifest.json         加载清单
│  └─ data/                 城市线路数据
├─ netlify/
│  ├─ functions/api.mjs     审核接口入口
│  └─ lib/{api-core,city}.mjs  路由核心与服务端校验
└─ tools/
   ├─ build_site.mjs        构建 dist/
   ├─ smoke_test.py         内核 + 接口冒烟测试
   ├─ test_server.mjs       审核接口端到端测试
   └─ sync_core.py          从上游内核工程同步内核与数据
```

## 本地开发

需要 Node.js 20+；运行内核测试还需要 Python 3.10+。

只用静态服务器预览（没有审核接口，规划与记录完全可用）：

```bash
python -m http.server 8010
```

必须通过 HTTP 访问，`file://` 无法加载 Pyodide。

包含审核、发布与站信的完整环境：

```bash
npm install
npx netlify-cli dev
```

构建静态产物（输出到 `dist/`）：

```bash
npm run build
```

## 测试

```bash
npm test              # 审核接口 + 内核
npm run test:server   # node tools/test_server.mjs
npm run test:core     # python tools/smoke_test.py
```

- `tools/test_server.mjs`：用内存存储替代 Netlify Blobs，覆盖提交 → 审核 → 发布 → 回滚 → 驳回 / 隐藏 / 限流、站信与定时发布的完整流程。
- `tools/smoke_test.py`：直接调用 `py/web_api.py`，验证内核与 JSON 接口是否一致（时长、经停、换乘 / 转乘、付费区、智能规划、同城组合、贯通交路与快车等）。

## 城市数据格式

每个城市（或共用文件，如 `广州-佛山.json`）是一份 JSON：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `city` / `region` / `version` | string | 城市名、地区、数据版本 |
| `systems` | string[] | 线路系统清单（如「地铁系统」「APM」「公交系统」） |
| `combined_shared_stations` | string[] | 可选。同城组合中允许与其它城市共用的同名车站 |
| `station_systems` | object | 可选。强互通系统，见下文 |
| `lines` | object[] | 线路数组，见下 |
| `transfers` | array[] | 转乘站对，每个端点为 `{station, system}`；字符串端点仅用于兼容旧数据 |
| `aliases` | string[][] | 同站异名组（同一车站、同一系统、仅名称不同） |
| `external_walks` | object | `"站A|站B": 分钟`，站外换乘步行估算 |
| `through_services` | object[] | 跨线贯通交路，加载时展开为派生线路 |

线路对象的主要字段：

| 字段 | 说明 |
| --- | --- |
| `id` / `name` / `short_name` | 线路 ID、全名、简称 |
| `system` | 所属系统，必须出现在 `systems` 中 |
| `type` | 交通类型键（`metro`、`monorail`、`suburban`、`intercity`、`tram`、`bus`、`maglev`、`cloudrail`、`cableway`、`ferry`、`apm`、`national_rail`） |
| `color` / `color2` | 标志主色 / 副色 |
| `stations` | 有序站表 |
| `travel_minutes` | `stations[i] → stations[i+1]` 的分钟数 |
| `headway_rush` / `headway_normal` / `first_train` / `last_train` | 班次与首末班（估算） |
| `ring` | 是否环线 |
| `directions` | 方向表。`label` 统一写作「终点站名+方向」（如「莘庄方向」），`terminal` 为终点站；环线没有终点站，沿用「内圈/外圈」或「顺时针/逆时针」。可省略，加载时按站表自动生成 |
| `direction_stops` | 可选。`{"方向名": [按行车顺序的停靠站]}`，用于上下行停靠站不一致（跳站或上下行分离）；未列出的车站该方向不服务 |
| `express` | 快车 / 大站车 / 直达车服务（停靠站与区段时长） |

### 核心语义

- **同一系统内的同名车站**视为同一车站（换乘，步行 0 分钟）。
- **跨系统同名车站不会自动连通**，必须在 `transfers` 中声明为转乘站对，才会按「转乘」处理并另起付费区。
- **同站异名**写进 `aliases`，用于「同一车站、不同写法」的情况。
- **支线**判定：名称形如「主线名 + 支线」、标志色与主线相同、且与主线共线 3 站以上（见 `js/line-branches.js`）。
- **方向停靠站**（`direction_stops`）：每个方向给出该方向实际停靠的站表（按行车顺序）。未列出的车站该方向不服务，可同时表达「跳站」与「上下行分离」；路径规划允许穿越不服务站，但不将其作为可下车终点，也不在该方向就地换乘。旧数据中的 `direction_skips` 仍可读取。
- **强互通系统**（`station_systems`）：只登记车站名称、不收录线路的系统，例如广东城际系统、国家铁路系统。写法为 `{"系统名": {"type": "national_rail", "stations": [...]}}`，也可直接给出站名数组。这类系统不参与路径规划，仅在站点换乘提示中说明「此处可转乘某系统某站」；`type` 为 `national_rail` 时，界面支持双击提示直达国铁车次查询。转乘站对的一端可以写成强互通系统的车站（如 `广东城际系统|广州南`）。同城组合中此类系统名不加城市前缀，跨城共用一套站表。
- **同城组合**由 `CityLibrary.COMBINED_CITIES` 定义；组合时，各参与城市声明的 `combined_shared_stations` 保留同名并自动生成跨系统转乘站对，其余同名站按城市加后缀区分。

## 审核与发布流程

1. 访客在数据工坊提交数据 → `POST /api/submissions`，进入待审核队列（带修改说明与可选联系方式）。
2. 管理员在审核台登录（请求头 `x-admin-token`）后可通过、驳回或隐藏；通过后写入已发布覆盖数据，并自动给提交者发送私密站信。
3. 静态站点启动时（`js/bridge.js`）拉取 `/api/cities`，把已发布数据写入 Pyodide 虚拟文件系统的 `/data`，因此规划与记录立即使用最新版本。上海、深圳为权威内置数据，不接受覆盖。
4. 审核台可查看已发布数据与回滚记录，并可回滚到内置版本或历史版本。

## 部署

`netlify.toml` 已配置：

```toml
[build]
  command = "node tools/build_site.mjs"
  publish = "dist"
  functions = "netlify/functions"
```

需要在站点环境变量中配置管理员口令 `ADMIN_TOKEN`（仅管理员使用，不应公开）。`/py/*`、`/js/*` 使用短缓存，`/api/*` 禁止缓存。

## 数据同步

内核与城市数据来自上游「运转计划生成器」工程，由 `tools/sync_core.py` 只读同步到本仓库（同时重写 `py/manifest.json`）：

```bash
python tools/sync_core.py --src "Z:/…/运转计划生成器"
```

## 许可

[MIT](./LICENSE) © 2026 磁浮线
