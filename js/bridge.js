/* Pyodide 桥接层
 *
 * 职责：把桌面版内核（py/transit_planner/**，由 tools/sync_core.py 同步）与城市数据
 * 加载进浏览器版 Python 运行时，并把 web_api 的 JSON 接口转发给界面层。
 *
 * 注意：这里**不实现任何业务规则**。分段时长、经停站、换乘判定、付费区分组、票价合计
 * 全部由 Python 侧 `transit_planner.core.engine` 计算（与桌面版共用同一份实现）。
 */
(() => {
  "use strict";

  const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.27.2/full/";
  const PY_ROOT = "/py";          // 内核在虚拟文件系统中的位置
  const DATA_ROOT = "/data";      // 城市数据（CityLibrary 的数据目录）

  let pyodide = null;

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
    if (!pyodide) throw new Error("Python 运行时尚未就绪");
    const module = pyodide.globals.get("web_api");
    const fn = module[name];
    if (!fn) throw new Error(`内核接口不存在：${name}`);
    const raw = fn(...args);
    return JSON.parse(String(raw));
  }

  /**
   * 启动运行时。
   * @param {(msg: string, ratio: number) => void} onProgress 进度回调（0~1）
   */
  async function boot(onProgress = () => {}) {
    onProgress("正在下载并启动 Python 运行时（Pyodide）…", 0.05);
    pyodide = await loadPyodide({ indexURL: PYODIDE_URL });

    onProgress("正在读取内核清单…", 0.35);
    const manifest = JSON.parse(await fetchText("py/manifest.json"));
    TP.manifest = manifest;

    const coreUrls = manifest.coreFiles.map((rel) => `py/${rel}`);
    const dataUrls = manifest.dataFiles.map((f) => `py/data/${f}`);
    const urls = [...coreUrls, "py/web_api.py", ...dataUrls];

    let done = 0;
    const texts = await Promise.all(
      urls.map(async (url) => {
        const text = await fetchText(url);
        done += 1;
        onProgress(`正在加载内核与数据（${done}/${urls.length}）…`, 0.35 + 0.5 * (done / urls.length));
        return text;
      })
    );

    onProgress("正在装配内核…", 0.9);
    pyodide.FS.mkdirTree(`${PY_ROOT}/transit_planner/core`);
    pyodide.FS.mkdirTree(DATA_ROOT);
    pyodide.FS.writeFile(`${PY_ROOT}/manifest.json`, JSON.stringify(manifest));

    coreUrls.forEach((url, i) => {
      const rel = manifest.coreFiles[i];
      writeFile(`${PY_ROOT}/${rel}`, texts[i]);
    });
    const offset = coreUrls.length;
    writeFile(`${PY_ROOT}/web_api.py`, texts[offset]);
    manifest.dataFiles.forEach((f, i) => {
      writeFile(`${DATA_ROOT}/${f}`, texts[offset + 1 + i]);
    });

    pyodide.runPython(`import sys\nif "${PY_ROOT}" not in sys.path:\n    sys.path.insert(0, "${PY_ROOT}")`);

    // 社区审核通过的覆盖数据：写入 /data 后，内核加载城市时自然使用最新版本
    onProgress("正在同步审核通过的线路数据…", 0.94);
    await applyPublishedOverrides();

    pyodide.runPython("import web_api");

    onProgress("内核就绪", 1);
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

  window.TP = {
    boot,
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
    pickDirection: (lineId, from, to) => call("api_pick_direction", lineId, from, to),
    reachable: (lineId, direction, from) => call("api_reachable", lineId, direction, from),
    reachableAny: (lineId, from) => call("api_reachable_any", lineId, from),
    transferHints: (station, excludeLineId) => call("api_transfer_hints", station, excludeLineId || ""),
    evaluate: (trip) => call("api_evaluate", JSON.stringify(trip)),
    manualTypes: () => call("api_manual_types"),
    newTrip: (city) => call("api_new_trip", city || ""),
    walkSuggestion: (trip, index) => call("api_walk_suggestion", JSON.stringify(trip), index),

    // ---- 数据工坊（编辑器）----
    cityJson: (name) => call("api_city_json", name),
    validateCity: (doc) => call("api_validate_city", JSON.stringify(doc)),
  };
})();
