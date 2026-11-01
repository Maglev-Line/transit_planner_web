/* 草稿仓库（首页 / 规划器 / 记录器共用）
 *
 * 浏览器 localStorage 中保存多份草稿：规划与记录各一份列表。
 * 首页「最近」、plan.html 与 record.html 都通过这里读写，保证自动保存格式一致。
 */
(() => {
  "use strict";

  const KEY = "transit-planner-web.drafts.v1";
  const LEGACY_PLAN_KEY = "transit-planner-web.v1";
  const MAX_PER_KIND = 60;
  const KINDS = ["plan", "record"];

  const pad = (n) => String(n).padStart(2, "0");

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function uid() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return window.crypto.randomUUID();
      }
    } catch { /* 非安全上下文时退回时间戳 */ }
    return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function empty(kind) {
    if (kind === "plan") {
      return {
        name: "我的运转方案",
        date: todayISO(),
        city: "",
        note: "",
        transfer_walk_default: 5,
        paid_zone_mode: false,
        steps: [],
      };
    }
    return {
      title: "我的运转记录",
      date: todayISO(),
      note: "",
      fields: [],
      segments: [],
    };
  }

  function read() {
    let raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(KEY) || "null");
    } catch {
      raw = null;
    }
    const store = { plan: [], record: [] };
    for (const kind of KINDS) {
      const list = raw && Array.isArray(raw[kind]) ? raw[kind] : [];
      store[kind] = list.filter((d) => d && typeof d === "object" && d.id).slice(0, MAX_PER_KIND);
    }
    return store;
  }

  function write(store) {
    try {
      localStorage.setItem(KEY, JSON.stringify(store));
      return true;
    } catch {
      return false;
    }
  }

  /** 按更新时间倒序返回某一类草稿。 */
  function list(kind) {
    const items = read()[kind] || [];
    return items
      .slice()
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  }

  function get(kind, id) {
    if (!id) return null;
    return (read()[kind] || []).find((d) => d.id === id) || null;
  }

  function save(kind, draft) {
    if (!KINDS.includes(kind)) throw new Error(`未知草稿类型：${kind}`);
    if (!draft || !draft.id) throw new Error("草稿缺少 id");
    const store = read();
    const items = store[kind];
    const now = new Date().toISOString();
    const next = { ...draft, kind, updatedAt: now };
    const index = items.findIndex((d) => d.id === draft.id);
    if (index >= 0) {
      next.createdAt = items[index].createdAt || draft.createdAt || now;
      items[index] = next;
    } else {
      next.createdAt = draft.createdAt || now;
      items.push(next);
    }
    items.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    store[kind] = items.slice(0, MAX_PER_KIND);
    write(store);
    return next;
  }

  function create(kind, fields = {}) {
    const now = new Date().toISOString();
    return save(kind, {
      id: uid(),
      kind,
      title: fields.title || (kind === "plan" ? "我的运转方案" : "我的运转记录"),
      summary: fields.summary || "",
      city: fields.city || "",
      createdAt: now,
      updatedAt: now,
      data: fields.data || empty(kind),
    });
  }

  function remove(kind, id) {
    if (!KINDS.includes(kind)) return false;
    const store = read();
    const before = store[kind].length;
    store[kind] = store[kind].filter((d) => d.id !== id);
    if (store[kind].length === before) return false;
    write(store);
    return true;
  }

  /** 把旧版单草稿键迁移成一份规划草稿（只迁移一次）。 */
  function migrateLegacy() {
    let legacy = null;
    try {
      legacy = JSON.parse(localStorage.getItem(LEGACY_PLAN_KEY) || "null");
    } catch {
      legacy = null;
    }
    if (!legacy) return false;

    const removeLegacy = () => {
      try { localStorage.removeItem(LEGACY_PLAN_KEY); } catch { /* 隐私模式下忽略 */ }
    };

    if (!legacy.trip || typeof legacy.trip !== "object" || !Array.isArray(legacy.trip.steps)) {
      removeLegacy();
      return false;
    }

    create("plan", {
      title: legacy.trip.name || "我的运转方案",
      city: legacy.city || legacy.trip.city || "",
      summary: summarize("plan", legacy.trip),
      data: legacy.trip,
    });
    removeLegacy();
    return true;
  }

  function summarize(kind, data) {
    if (kind === "plan") {
      const n = Array.isArray(data?.steps) ? data.steps.length : 0;
      if (!n) return "空方案";
      return `${n} 段行程${data.city ? ` · ${data.city}` : ""}`;
    }
    const segments = Array.isArray(data?.segments) ? data.segments : [];
    if (!segments.length) return "空记录";
    const types = [...new Set(segments.map((s) => s && s.type).filter(Boolean))];
    return `${segments.length} 段记录${types.length ? ` · ${types.join(" / ")}` : ""}`;
  }

  function formatWhen(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const now = new Date();
    const diff = (now.getTime() - d.getTime()) / 1000;
    if (diff >= 0 && diff < 60) return "刚刚";
    if (diff >= 0 && diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
  }

  function safeFileName(name, fallback = "导出") {
    const cleaned = String(name || "")
      .replace(/[\\/:*?"<>|\r\n]/g, "_")
      .trim();
    return cleaned || fallback;
  }

  function downloadJSON(filename, data) {
    const name = safeFileName(filename, "导出");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name.endsWith(".json") ? name : `${name}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function readJSONFile(file) {
    const text = await file.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("文件不是有效的 JSON");
    }
  }

  window.TPDrafts = {
    KEY,
    todayISO,
    uid,
    empty,
    list,
    get,
    save,
    create,
    remove,
    migrateLegacy,
    summarize,
    formatWhen,
    safeFileName,
    downloadJSON,
    readJSONFile,
  };
})();
