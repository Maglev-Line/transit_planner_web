/* Pyodide 桥接层
 *
 * 职责：把共享规划内核（py/transit_planner/**，由 tools/sync_core.py 同步）与城市数据
 * 加载进浏览器版 Python 运行时，并把 web_api 的 JSON 接口转发给界面层。
 *
 * 注意：这里**不实现任何业务规则**。分段时长、经停站、换乘判定、付费区分组、票价合计
 * 全部由 Python 侧 `transit_planner.core.engine` 计算。
 */
(() => {
  "use strict";

  const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.27.2/full/";
  const PY_ROOT = "/py";          // 内核在虚拟文件系统中的位置
  const DATA_ROOT = "/data";      // 城市数据（CityLibrary 的数据目录）
  const AUTHORITATIVE_CITY_DATA = new Set(["上海", "深圳"]);

  let pyodide = null;
  let pyodideScriptPromise = null;

  function loadPyodideScript() {
    if (typeof window.loadPyodide === "function") return Promise.resolve();
    if (!pyodideScriptPromise) {
      pyodideScriptPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = `${PYODIDE_URL}pyodide.js`;
        script.onload = () => {
          if (typeof window.loadPyodide !== "function") {
            reject(new Error("Pyodide 脚本已加载，但运行时入口不可用"));
            return;
          }
          resolve();
        };
        script.onerror = () => {
          pyodideScriptPromise = null;
          reject(new Error("加载 Pyodide 失败，请检查网络连接后重试"));
        };
        document.head.appendChild(script);
      });
    }
    return pyodideScriptPromise;
  }

  async function fetchText(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`加载 ${url} 失败（HTTP ${res.status}）`);
    return res.text();
  }

  function writeFile(path, text) {
    pyodide.FS.writeFile(path, text, { encoding: "utf8" });
  }

  /** 调用 Python 接口并解析返回的 JSON。 */
  function call(name, ...args) {
    if (!pyodide) throw new Error("正在加载，请稍候");
    const module = pyodide.globals.get("web_api");
    const fn = module[name];
    if (!fn) throw new Error(`功能尚未就绪：${name}`);
    const raw = fn(...args);
    return JSON.parse(String(raw));
  }

  /**
   * 启动运行时。
   * @param {(msg: string, ratio: number) => void} onProgress 进度回调（0~1）
   */
  async function boot(onProgress = () => {}) {
    onProgress("正在加载…", 0.05);
    await loadPyodideScript();
    pyodide = await loadPyodide({ indexURL: PYODIDE_URL });

    onProgress("正在读取数据清单…", 0.35);
    const manifest = JSON.parse(await fetchText("py/manifest.json"));
    TP.manifest = manifest;

    const coreUrls = manifest.coreFiles.map((rel) => `py/${rel}`);
    const dataUrls = manifest.dataFiles.map((f) => `py/data/${f}`);
    const urls = [...coreUrls, "py/web_api.py", "py/route_planner.py", ...dataUrls];

    let done = 0;
    const texts = await Promise.all(
      urls.map(async (url) => {
        const text = await fetchText(url);
        done += 1;
        onProgress(`正在加载数据（${done}/${urls.length}）…`, 0.35 + 0.5 * (done / urls.length));
        return text;
      })
    );

    onProgress("正在准备…", 0.9);
    pyodide.FS.mkdirTree(`${PY_ROOT}/transit_planner/core`);
    pyodide.FS.mkdirTree(DATA_ROOT);
    pyodide.FS.writeFile(`${PY_ROOT}/manifest.json`, JSON.stringify(manifest));

    coreUrls.forEach((url, i) => {
      const rel = manifest.coreFiles[i];
      writeFile(`${PY_ROOT}/${rel}`, texts[i]);
    });
    const offset = coreUrls.length;
    writeFile(`${PY_ROOT}/web_api.py`, texts[offset]);
    writeFile(`${PY_ROOT}/route_planner.py`, texts[offset + 1]);
    manifest.dataFiles.forEach((f, i) => {
      writeFile(`${DATA_ROOT}/${f}`, texts[offset + 2 + i]);
    });

    pyodide.runPython(`import sys\nif "${PY_ROOT}" not in sys.path:\n    sys.path.insert(0, "${PY_ROOT}")`);

    // 社区审核通过的覆盖数据：写入 /data 后，内核加载城市时自然使用最新版本
    onProgress("正在同步审核通过的线路数据…", 0.94);
    await applyPublishedOverrides();

    pyodide.runPython("import web_api");

    onProgress("加载完成", 1);
    return call("api_init");
  }

  /**
   * 拉取审核通过的覆盖数据。未部署 Netlify Functions（纯静态服务器）时静默跳过，
   * 规划器照常使用内置数据。
   */
  async function applyPublishedOverrides() {
    TP.published = {};
    TP.backendAvailable = false;
    try {
      const res = await fetch("/api/cities", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (!data?.ok || !data.cities) return;
      TP.backendAvailable = true;
      for (const [name, entry] of Object.entries(data.cities)) {
        // 城市名即数据文件名：拒绝任何路径分隔符，避免写到 /data 之外
        if (!name || /[\\/]/.test(name) || name.includes("..")) continue;
        const doc = entry?.doc;
        if (!doc || typeof doc !== "object") continue;
        if (AUTHORITATIVE_CITY_DATA.has(name)) continue;
        writeFile(`${DATA_ROOT}/${name}.json`, JSON.stringify(doc, null, 2));
        TP.published[name] = {
          updatedAt: entry.updatedAt || "",
          submissionId: entry.submissionId || "",
          summary: entry.summary || "",
          kind: entry.kind || "edit",
        };
      }
    } catch {
      /* 离线 / 本地静态服务器：忽略 */
    }
  }

  /** 启动结果缓存：规划器与运转记录共用同一个内核实例（失败后可重试）。 */
  let bootPromise = null;

  /** 启动内核；重复调用复用同一次启动（运转记录等页面按需调用）。 */
  function ensure(onProgress = () => {}) {
    if (!bootPromise) {
      bootPromise = boot(onProgress).catch((err) => {
        bootPromise = null;
        throw err;
      });
    }
    return bootPromise;
  }

  window.TP = {
    boot: ensure,
    ensure,
    get ready() { return Boolean(pyodide); },
    published: {},
    backendAvailable: false,
    manifest: null,
    get pyodide() { return pyodide; },

    // ---- 内核接口（全部返回已解析的 JSON）----
    init: () => call("api_init"),
    loadCity: (name) => call("api_load_city", name),
    line: (lineId) => call("api_line", lineId),
    stations: () => call("api_stations"),
    searchLines: (keyword) => call("api_search_lines", keyword, 30),
    pickDirection: (lineId, from, to, service = "") => call("api_pick_direction", lineId, from, to, service || ""),
    reachable: (lineId, direction, from, service = "") => call("api_reachable", lineId, direction, from, service || ""),
    reachableAny: (lineId, from, service = "") => call("api_reachable_any", lineId, from, service || ""),
    transferHints: (station, excludeLineId) => call("api_transfer_hints", station, excludeLineId || ""),
    planRoutes: (params) => call("api_plan_routes", JSON.stringify(params || {})),
    evaluate: (trip) => call("api_evaluate", JSON.stringify(trip)),
    manualTypes: () => call("api_manual_types"),
    newTrip: (city) => call("api_new_trip", city || ""),
    walkSuggestion: (trip, index) => call("api_walk_suggestion", JSON.stringify(trip), index),

    // ---- 数据工坊（编辑器）----
    cityJson: (name) => call("api_city_json", name),
    validateCity: (doc) => call("api_validate_city", JSON.stringify(doc)),
  };
})();
