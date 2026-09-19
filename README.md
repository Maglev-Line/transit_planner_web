# 运转计划助手 · Web

交通迷绕路运转行程规划工具的**浏览器版**：链条式手动规划（起点站 → 线路 → 方向 → 到达站），自动计算分段时长、经停站、换乘步行与付费区票价，并可导出 A4 运转图纸。

本项目网页版已公开，网址：https://metro-transit-planner.netlify.app/

与桌面版《运转计划助手》**共用同一份 Python 规划内核**——浏览器里通过 [Pyodide](https://pyodide.org/) 运行 `transit_planner.core`（`engine.py` / `models.py`），
因此换乘判定、经停站、付费区计费等规则与桌面版**逐字节一致**，不存在"两套逻辑各写一遍、慢慢跑偏"的问题。

## 与桌面版的关系

| 部分 | 处理方式 |
| --- | --- |
| `core/engine.py`、`core/models.py`、`core/railway.py` | **直接复用**（纯标准库，由 `tools/sync_core.py` 同步到 `py/`） |
| `data/*.json`（含同城组合） | **直接复用**，与桌面版同源 |
| `ui/`（PySide6 界面） | 重写为 HTML/CSS/JS（本项目 `index.html` + `js/`） |
| `pdf/exporter.py` | 改为「A4 打印 / 另存为 PDF」（浏览器排版，中文字体用系统字体，无乱码风险） |
| 设置（QSettings） | 改为 `localStorage` |
| 线路库数据编辑器 | 暂无（桌面版独有；这是工作量最大的一块，后续可做） |
| 在线地图 API、12306 查询 | 暂无（浏览器直连会被 CORS 拦，需要一层 serverless 代理） |

行程方案的 **JSON 格式与桌面版完全互通**：桌面版导出的方案可以直接「导入方案」，反之亦然。

## 目录结构

```
index.html          页面骨架
styles.css          样式（含 A4 打印样式）
js/bridge.js        Pyodide 桥接：把 py/ 下的内核与数据装进浏览器，暴露 TP.* 接口
js/app.js           界面层：状态、渲染、交互（不含任何业务规则）
py/web_api.py       内核包装层：把 engine 的纯函数暴露为 JSON 接口（本项目维护）
py/transit_planner/   ← 由 tools/sync_core.py 从桌面版同步（勿手改）
py/data/*.json        ← 同上
py/manifest.json     同步清单（浏览器按它加载文件）
tools/sync_core.py  同步内核与数据
tools/smoke_test.py 本地冒烟测试（不开浏览器就能验证内核接线）
netlify.toml        Netlify 部署配置（纯静态，无构建步骤）
```

## 本地运行

不能直接双击 `index.html`：浏览器禁止 `file://` 页面读取内核文件。
起一个静态服务器即可（**必须通过 http 访问**）：

```bash
python -m http.server 8010
# 浏览器打开 http://127.0.0.1:8010/
```

首次打开需从 CDN 下载约 10&nbsp;MB 的 Pyodide 运行时（之后走浏览器缓存）。

## 开发流程

```bash
# 1. 桌面版改了 core 或 data 之后，同步到本项目
python tools/sync_core.py
python tools/sync_core.py --src "Z:/3_张峻恺/运转计划生成器"   # 或显式指定桌面版目录

# 2. 不开浏览器，先验证内核接线
python tools/smoke_test.py

# 3. 刷新浏览器页面（改了 styles.css / js 建议强制刷新 Ctrl+Shift+R）
```

**分工原则**：所有算时长、算经停站、判换乘、划付费区的逻辑都留在 Python 内核里；
`js/app.js` 只负责把内核返回的 JSON 画出来。新增功能时不要在 JS 里重算这些数字。

## 已知限制与后续可做

- **首次加载较慢**：Pyodide 运行时约 10&nbsp;MB，之后由浏览器缓存；可加 Service Worker 做离线缓存。
- **PDF**：走浏览器打印（`导出图纸 (PDF)` → 目标选「另存为 PDF」），排版为 A4、可直接持图运转。
- **数据编辑器 / 在线地图接口 / 12306 查询**尚未实现。
- **手动段**的时长可手填，也可勾选「按时刻表乘坐列车」由发时/到时自动计算。
