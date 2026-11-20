/* 审核服务请求封装（浏览器）。
 *
 * 所有接口都是同源 /api/*（由 netlify.toml 重写到 Netlify Function）；
 * 未部署 Functions 的纯静态环境会被识别为 offline，此时编辑器仍可本地编辑与导出 JSON。
 */
(() => {
  "use strict";

  const BASE = "/api";
  const TOKEN_KEY = "transit-planner-web.admin-token";
  const INBOX_TOKEN_KEY = "transit-planner-web.inbox-token.v1";
  let memoryInboxToken = "";

  function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
  }

  function setToken(token) {
    try {
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch { /* 隐私模式下忽略 */ }
  }

  function getInboxToken() {
    try {
      const saved = localStorage.getItem(INBOX_TOKEN_KEY) || "";
      if (/^[a-f0-9]{64}$/i.test(saved)) return saved;
    } catch { /* 隐私模式下使用当前页面内的临时收件凭证 */ }
    try {
      const saved = sessionStorage.getItem(INBOX_TOKEN_KEY) || "";
      if (/^[a-f0-9]{64}$/i.test(saved)) return saved;
    } catch { /* 当前页面内的临时凭证仍可使用 */ }
    if (!memoryInboxToken) {
      const bytes = new Uint8Array(32);
      window.crypto.getRandomValues(bytes);
      memoryInboxToken = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    try {
      localStorage.setItem(INBOX_TOKEN_KEY, memoryInboxToken);
    } catch {
      try { sessionStorage.setItem(INBOX_TOKEN_KEY, memoryInboxToken); } catch { /* 当前页面仍可收取站信 */ }
    }
    return memoryInboxToken;
  }

  async function request(path, { method = "GET", body, inboxToken = false } = {}) {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (inboxToken) headers["x-inbox-token"] = getInboxToken();
    // 同源接口：有口令就带上，管理员能看到联系方式与隐藏记录；匿名请求会被服务端忽略
    const token = getToken();
    if (token) headers["x-admin-token"] = token;

    let res;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
    } catch {
      return { ok: false, offline: true, error: "无法连接审核服务" };
    }

    let data = null;
    try { data = await res.json(); } catch { /* 静态服务器的 404 页面不是 JSON */ }

    // 没有任何 JSON 响应 = 这台服务器没有审核接口（例如 python -m http.server）
    if (!data) {
      return { ok: false, offline: true, status: res.status, error: "审核服务未启用" };
    }
    if (!res.ok || !data.ok) {
      return {
        ok: false,
        status: res.status,
        code: data.code || "",
        error: data.error || `请求失败（HTTP ${res.status}）`,
      };
    }
    return data;
  }

  const q = (params) => {
    const usp = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") usp.set(k, String(v));
    });
    const s = usp.toString();
    return s ? `?${s}` : "";
  };

  window.DataApi = {
    getToken,
    setToken,
    hasToken: () => Boolean(getToken()),

    health: () => request("/health"),
    adminCheck: () => request("/admin/check"),
    cities: () => request("/cities"),

    submissions: (status = "all") => request(`/submissions${q({ status })}`),
    submission: (id) => request(`/submissions/${encodeURIComponent(id)}`),
    submit: (payload) =>
      request("/submissions", { method: "POST", body: payload, inboxToken: true }),

    approve: (id) => request(`/submissions/${encodeURIComponent(id)}/approve`, { method: "POST", body: {} }),
    reject: (id, reason) =>
      request(`/submissions/${encodeURIComponent(id)}/reject`, { method: "POST", body: { reason } }),
    hide: (id) => request(`/submissions/${encodeURIComponent(id)}/hide`, { method: "POST", body: {} }),

    published: () => request("/published"),
    publishedCity: (name) => request(`/published/${encodeURIComponent(name)}`),
    revert: (name, to, note = "") =>
      request(`/published/${encodeURIComponent(name)}/revert`, { method: "POST", body: { to, note } }),

    rollbacks: () => request("/rollbacks"),

    messages: (options = {}) =>
      request(`/messages${q({
        manage: options.manage ? "1" : "",
        includeScheduled: options.includeScheduled ? "1" : "",
      })}`, { inboxToken: !options.manage }),
    createMessage: (payload) => request("/messages", { method: "POST", body: payload }),
    deleteMessage: (id) =>
      request(`/messages/${encodeURIComponent(id)}`, { method: "DELETE" }),

    // 保留旧接口别名，兼容仍缓存旧版静态页面的访问者。
    announcements: (options = {}) =>
      request(`/announcements${options.includeScheduled ? "?includeScheduled=1" : ""}`),
    createAnnouncement: (payload) => request("/announcements", { method: "POST", body: payload }),
    deleteAnnouncement: (id) =>
      request(`/announcements/${encodeURIComponent(id)}`, { method: "DELETE" }),

    bans: () => request("/bans"),
    ban: (ipHash, payload) =>
      request(`/bans/${encodeURIComponent(ipHash)}`, { method: "POST", body: payload }),
    unban: (ipHash) => request(`/bans/${encodeURIComponent(ipHash)}`, { method: "DELETE" }),
  };
})();
