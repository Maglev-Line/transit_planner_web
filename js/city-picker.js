/* 城市选择弹窗（首页「新建」、规划 / 记录界面「切换城市」共用）
 *
 * 城市目录来自 py/manifest.json 的 cities 字段（含地区与同城组合的组成城市），
 * 因此在首页不必启动 Pyodide 也能列出全部城市。
 * 列表按地区分组，组内按拼音首字母排序。
 */
(() => {
  "use strict";

  const MANIFEST_URL = "py/manifest.json";
  const REGION_ORDER = ["华北", "东北", "华东", "华中", "华南", "西南", "西北", "其他"];
  const MANUAL = { name: "", label: "不使用线路库 · 纯手动" };

  // 常用城市名的拼音（用于按拼音首字母排序）；未登记的城市交给中文排序规则（按拼音比较）
  const PINYIN = {
    上海: "shanghai",
    "上海-苏州": "shanghai suzhou",
    东莞: "dongguan",
    佛山: "foshan",
    北京: "beijing",
    天津: "tianjin",
    呼和浩特: "huhehaote",
    太原: "taiyuan",
    乌鲁木齐: "wulumuqi",
    兰州: "lanzhou",
    广州: "guangzhou",
    "广州-佛山": "guangzhou foshan",
    武汉: "wuhan",
    深圳: "shenzhen",
    珠江三角洲: "zhujiang sanjiaozhou",
    南京: "nanjing",
    马鞍山: "maanshan",
    苏州: "suzhou",
    滁州: "chuzhou",
    重庆: "chongqing",
  };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  const collator = new Intl.Collator("zh-Hans-CN", { sensitivity: "base" });

  function compareCities(a, b) {
    const ka = PINYIN[a];
    const kb = PINYIN[b];
    if (ka && kb) return ka.localeCompare(kb);
    // 任一方没有登记拼音时用中文排序（zh-CN 默认按拼音比较），避免两种规则混用导致顺序不一致
    return collator.compare(a, b);
  }

  let catalogPromise = null;

  /** 读取城市目录：[{ name, region, file, parts }]（不含「纯手动」）。 */
  function loadCatalog() {
    if (catalogPromise) return catalogPromise;
    if (window.TP?.manifest?.cities) {
      catalogPromise = Promise.resolve(normalize(window.TP.manifest.cities));
      return catalogPromise;
    }
    catalogPromise = fetch(MANIFEST_URL, { cache: "no-cache" })
      .then((res) => {
        if (!res.ok) throw new Error(`读取城市目录失败（HTTP ${res.status}）`);
        return res.json();
      })
      .then((manifest) => {
        const cities = normalize(manifest?.cities);
        if (cities.length) return cities;
        // 旧清单没有目录字段时，退回按数据文件列出城市
        return normalize((manifest?.dataFiles || []).map((file) => ({
          name: String(file).replace(/\.json$/i, ""),
          file: String(file),
        })));
      })
      .catch((err) => {
        catalogPromise = null;
        throw err;
      });
    return catalogPromise;
  }

  function normalize(list) {
    return (Array.isArray(list) ? list : [])
      .map((item) => ({
        name: String(item?.name || "").trim(),
        region: String(item?.region || "").trim(),
        file: String(item?.file || "").trim(),
        parts: Array.isArray(item?.parts) ? item.parts.map(String) : [],
      }))
      .filter((item) => item.name);
  }

  /** 按地区分组：已知地区按固定顺序，未知地区排在后面。 */
  function groupByRegion(cities) {
    const buckets = new Map();
    cities.forEach((city) => {
      const key = city.region || "其他";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(city);
    });
    const regions = [...buckets.keys()].sort((a, b) => {
      const ia = REGION_ORDER.indexOf(a);
      const ib = REGION_ORDER.indexOf(b);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return collator.compare(a, b);
    });
    return regions.map((region) => ({
      region,
      cities: buckets.get(region).slice().sort((a, b) => compareCities(a.name, b.name)),
    }));
  }

  let dialog = null;
  let onPickHandler = null;
  let allowManualEntry = true;

  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.id = "city-picker-dialog";
    dialog.className = "city-picker-dialog";
    dialog.innerHTML = `
      <div class="modal-head">
        <h3 id="city-picker-title">选择城市</h3>
        <span class="hint" id="city-picker-sub"></span>
        <div class="spacer"></div>
        <button type="button" class="ghost" data-city-close title="关闭">✕</button>
      </div>
      <div class="modal-body">
        <input class="search" id="city-picker-search" type="search" placeholder="搜索城市">
        <div id="city-picker-list" class="city-picker-list"></div>
      </div>
      <div class="modal-foot">
        <div class="spacer"></div>
        <button type="button" data-city-close>取消</button>
      </div>`;
    document.body.appendChild(dialog);

    dialog.querySelectorAll("[data-city-close]").forEach((btn) => {
      btn.addEventListener("click", () => dialog.close());
    });
    dialog.addEventListener("click", (ev) => {
      if (ev.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => {
      onPickHandler = null;
    });
    dialog.querySelector("#city-picker-list").addEventListener("click", (ev) => {
      const item = ev.target.closest("[data-city]");
      if (!item) return;
      const name = item.dataset.city;
      const handler = onPickHandler;
      dialog.close();
      if (handler) handler(name);
    });
    dialog.querySelector("#city-picker-search").addEventListener("input", (ev) => {
      currentQuery = ev.target.value || "";
      renderList();
    });
    return dialog;
  }

  let currentCity = "";
  let currentQuery = "";

  async function renderList() {
    const box = dialog.querySelector("#city-picker-list");
    box.innerHTML = '<p class="hint">正在读取城市目录…</p>';
    let cities;
    try {
      cities = await loadCatalog();
    } catch (err) {
      box.innerHTML = `<p class="hint">${esc(err.message || err)}</p>`;
      return;
    }
    const kw = currentQuery.trim().toLowerCase();
    const filtered = kw ? cities.filter((c) => c.name.toLowerCase().includes(kw)) : cities;
    const groups = groupByRegion(filtered);
    const manualHit = !kw || MANUAL.label.includes(kw) || "手动".includes(kw) || "manual".includes(kw);
    const manualRow = allowManualEntry && manualHit
      ? `<button type="button" class="city-option manual${currentCity ? "" : " active"}" data-city="">
          <span class="city-name">${esc(MANUAL.label)}</span>
        </button>`
      : "";
    const body = groups.map((group) => `
      <section class="city-region">
        <h4>${esc(group.region)}</h4>
        <div class="city-grid">
          ${group.cities.map((city) => `
            <button type="button" class="city-option${city.name === currentCity ? " active" : ""}" data-city="${esc(city.name)}">
              <span class="city-name">${esc(city.name)}</span>
              ${city.parts.length ? `<span class="city-tag">同城组合</span>` : ""}
            </button>`).join("")}
        </div>
      </section>`).join("");
    box.innerHTML = manualRow + (body || (kw ? '<p class="hint">没有匹配的城市</p>' : ""));
  }

  async function open({ title = "选择城市", current = "", onPick = null, allowManual = true } = {}) {
    ensureDialog();
    currentCity = current || "";
    currentQuery = "";
    allowManualEntry = allowManual !== false;
    dialog.querySelector("#city-picker-title").textContent = title;
    const search = dialog.querySelector("#city-picker-search");
    search.value = "";
    onPickHandler = onPick;
    if (!dialog.open) dialog.showModal();
    renderList();
    search.focus();
  }

  /** 以 Promise 形式打开：返回城市名（纯手动为空串），取消则为 null。 */
  function pick(options = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const dlg = ensureDialog();
      const onClose = () => {
        dlg.removeEventListener("close", onClose);
        finish(null);
      };
      dlg.addEventListener("close", onClose);
      open({ ...options, onPick: (name) => finish(name) });
    });
  }

  window.CityPicker = {
    loadCatalog,
    groupByRegion,
    open,
    pick,
  };
})();
