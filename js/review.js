/* 数据审核台（公开读取 + 管理员操作）
 *
 * 公开：提交记录、完整数据、差异、审核结果、已发布数据、回滚记录。
 * 管理员（ADMIN_TOKEN）：通过 / 驳回 / 隐藏 / 回滚。
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtTime = (iso) => {
    if (!iso) return "—";
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString("zh-CN", { hour12: false });
  };

  const STATUS = {
    pending: { text: "待审核", cls: "status-pending" },
    approved: { text: "已通过", cls: "status-approved" },
    rejected: { text: "已驳回", cls: "status-rejected" },
    reverted: { text: "已回滚", cls: "status-reverted" },
    hidden: { text: "已隐藏（仅管理员可见）", cls: "status-hidden" },
  };

  const state = {
    tab: "pending",
    counts: { all: 0, pending: 0, approved: 0, rejected: 0, reverted: 0 },
    publishedCount: 0,
    submissions: [],
    published: [],
    rollbacks: [],
    details: new Map(),
    admin: false,
    backend: false,
    adminConfigured: false,
    focusId: "",
  };

  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 2800);
  }

  function saveJson(name, doc) {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${String(name || "city").replace(/[\\/:*?"<>|]/g, "_")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function fetchBuiltin(name) {
    try {
      const res = await fetch(`py/data/${encodeURIComponent(name)}.json`, { cache: "no-store" });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  // ---------------- 启动 ----------------

  async function boot() {
    bindEvents();
    const health = await DataApi.health();
    state.backend = Boolean(health.ok);
    state.adminConfigured = Boolean(health.adminConfigured);
    $("offline").hidden = state.backend;

    if (DataApi.hasToken() && state.backend) {
      const check = await DataApi.adminCheck();
      if (check.ok) state.admin = true;
      else DataApi.setToken("");
    }
    updateAdminUI();

    state.focusId = new URLSearchParams(location.search).get("submission") || "";
    await loadTab(state.focusId ? "all" : "pending");

    if (state.focusId) {
      const safe = state.focusId.replace(/[^A-Za-z0-9_-]/g, "");
      const card = safe ? document.querySelector(`.rv-card[data-id="${safe}"]`) : null;
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        await toggleDetail(card);
      } else {
        toast("没有找到这条提交记录（可能已被隐藏或删除）");
      }
    }
  }

  function updateAdminUI() {
    const label = $("admin-state");
    label.textContent = state.admin ? "管理员已登录" : "未登录管理员";
    label.classList.toggle("admin", state.admin);
    $("btn-logout").hidden = !state.admin;
    $("btn-login").hidden = state.admin;
    $("btn-login").disabled = state.backend && !state.adminConfigured;
    $("btn-login").title = state.adminConfigured
      ? "输入 ADMIN_TOKEN 后可执行审核与回滚"
      : "站点未配置 ADMIN_TOKEN 环境变量，审核接口已锁定";
  }

  // ---------------- 数据加载 ----------------

  async function loadTab(tab) {
    state.tab = tab;
    renderTabs();
    if (!state.backend) {
      $("list").innerHTML = `<div class="rv-empty">审核服务未启用，暂时无法查看在线审核记录。<br>部署到 Netlify 后即可使用。</div>`;
      return;
    }
    $("list").innerHTML = `<p class="hint">正在加载…</p>`;

    if (tab === "published") {
      const [pub, counts] = await Promise.all([DataApi.published(), DataApi.submissions("all")]);
      if (!pub.ok) return showError(pub);
      state.published = pub.cities || [];
      state.publishedCount = state.published.length;
      if (counts.ok) state.counts = { ...state.counts, ...counts.counts };
      renderSummary();
      renderTabs();
      renderList();
      return;
    }

    if (tab === "rollbacks") {
      const [list, pub, counts] = await Promise.all([
        DataApi.rollbacks(),
        DataApi.published(),
        DataApi.submissions("all"),
      ]);
      if (!list.ok) return showError(list);
      state.rollbacks = list.rollbacks || [];
      if (pub.ok) state.publishedCount = (pub.cities || []).length;
      if (counts.ok) state.counts = { ...state.counts, ...counts.counts };
      renderSummary();
      renderTabs();
      renderList();
      return;
    }

    const [list, pub] = await Promise.all([DataApi.submissions(tab), DataApi.published()]);
    if (!list.ok) return showError(list);
    state.submissions = list.submissions || [];
    if (list.counts) state.counts = { ...state.counts, ...list.counts };
    if (pub.ok) state.publishedCount = (pub.cities || []).length;
    renderSummary();
    renderTabs();
    renderList();
  }

  function showError(res) {
    if (res.offline) {
      $("offline").hidden = false;
      $("list").innerHTML = `<div class="rv-empty">审核服务未启用，暂时无法查看在线审核记录。</div>`;
      return;
    }
    $("list").innerHTML = `<div class="rv-empty">加载失败：${esc(res.error || "未知错误")}</div>`;
  }

  async function refresh() {
    await loadTab(state.tab);
  }

  // ---------------- 渲染：统计 / 选项卡 ----------------

  function renderSummary() {
    const counts = state.counts || {};
    const cards = [
      ["待审核", counts.pending ?? 0, "条"],
      ["已通过", counts.approved ?? 0, "条"],
      ["已驳回", counts.rejected ?? 0, "条"],
      ["已回滚", counts.reverted ?? 0, "条"],
      ["已发布城市", state.publishedCount ?? 0, "座"],
    ];
    $("summary").innerHTML = cards.map(([label, value, unit]) => `
      <div class="rv-stat"><div class="k">${label}</div><div class="v">${value}<small>${unit}</small></div></div>`).join("");
  }

  function renderTabs() {
    document.querySelectorAll(".rv-tabs button").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === state.tab);
    });
    $("count-pending").textContent = state.counts.pending || "";
    $("count-approved").textContent = state.counts.approved || "";
    $("count-rejected").textContent = state.counts.rejected || "";
    $("count-reverted").textContent = state.counts.reverted || "";
  }

  function renderList() {
    if (state.tab === "published") return renderPublishedList();
    if (state.tab === "rollbacks") return renderRollbackList();
    return renderSubmissionList();
  }

  function empty(text) {
    return `<div class="rv-empty">${esc(text)}</div>`;
  }

  function renderSubmissionList() {
    const items = state.submissions;
    if (!items.length) {
      $("list").innerHTML = empty(state.tab === "pending" ? "目前没有待审核的提交。" : "这里还没有记录。");
      return;
    }
    $("list").innerHTML = items.map(submissionCard).join("");
  }

  function submissionCard(item) {
    const status = STATUS[item.status] || { text: item.status, cls: "" };
    const kind = item.kind === "new" ? "新建城市" : "修改城市";
    const stats = item.stats || {};
    return `<article class="rv-card" data-id="${esc(item.id)}">
      <div class="rv-card-head">
        <span class="status ${status.cls}">${esc(status.text)}</span>
        <span class="badge">${kind}</span>
        <b class="rv-city">${esc(item.city)}</b>
        <span class="rv-time">提交于 ${fmtTime(item.createdAt)}</span>
        <div class="spacer"></div>
        <button type="button" class="ghost" data-act="toggle">展开差异 ▾</button>
      </div>
      <p class="rv-desc">${esc(item.summary)}</p>
      <div class="rv-facts">
        <span>${stats.lines ?? "?"} 条线路 · ${stats.stations ?? "?"} 站</span>
        <span>提交者：匿名用户</span>
        ${item.reviewedAt ? `<span>审核于 ${fmtTime(item.reviewedAt)}</span>` : ""}
        ${item.revertedAt ? `<span class="warn">回滚于 ${fmtTime(item.revertedAt)}</span>` : ""}
        ${item.reason ? `<span class="warn">原因：${esc(item.reason)}</span>` : ""}
        ${item.contact ? `<span>联系方式：${esc(item.contact)}</span>` : ""}
      </div>
      <div class="rv-card-actions">
        ${state.admin && item.status === "pending" ? `
          <button type="button" class="primary" data-act="approve">通过并生效</button>
          <button type="button" data-act="reject">驳回</button>
          <button type="button" class="danger" data-act="hide" title="仅隐藏，不公开">隐藏（垃圾信息）</button>` : ""}
        <button type="button" data-act="download">下载 JSON</button>
        <a class="btn" href="editor.html?city=${encodeURIComponent(item.city)}">在数据工坊中打开</a>
      </div>
      <div class="rv-detail" hidden></div>
    </article>`;
  }

  function renderPublishedList() {
    const items = state.published;
    if (!items.length) {
      $("list").innerHTML = empty("目前没有任何审核通过的覆盖数据，全站正在使用内置线路库。");
      return;
    }
    $("list").innerHTML = items.map((city) => {
      const stats = city.stats || {};
      return `<article class="rv-card" data-published="${esc(city.name)}">
        <div class="rv-card-head">
          <span class="status status-approved">已生效</span>
          <b class="rv-city">${esc(city.name)}</b>
          <span class="rv-time">更新于 ${fmtTime(city.updatedAt)}</span>
          <div class="spacer"></div>
          <button type="button" class="ghost" data-act="toggle">展开差异 ▾</button>
        </div>
        <p class="rv-desc">${esc(city.summary || "（无说明）")}</p>
        <div class="rv-facts">
          <span>${stats.lines ?? "?"} 条线路 · ${stats.stations ?? "?"} 站</span>
          <span>来源提交：${city.submissionId ? `<a href="?submission=${encodeURIComponent(city.submissionId)}">${esc(city.submissionId)}</a>` : "—"}</span>
          <span>可回滚历史版本：${city.versionCount ?? 0}</span>
        </div>
        <div class="rv-card-actions">
          ${state.admin ? `
            <button type="button" data-act="rollback-prev">回滚到上一版</button>
            <button type="button" class="danger" data-act="rollback-builtin">回滚到内置数据</button>` : ""}
          <button type="button" data-act="download">导出 JSON</button>
          <a class="btn" href="editor.html?city=${encodeURIComponent(city.name)}">在数据工坊中打开</a>
        </div>
        <div class="rv-detail" hidden></div>
      </article>`;
    }).join("");
  }

  function renderRollbackList() {
    const items = state.rollbacks;
    if (!items.length) {
      $("list").innerHTML = empty("还没有回滚记录。");
      return;
    }
    $("list").innerHTML = items.map((rb) => `
      <article class="rv-card">
        <div class="rv-card-head">
          <span class="status status-reverted">回滚</span>
          <b class="rv-city">${esc(rb.city)}</b>
          <span class="rv-time">${fmtTime(rb.at)}</span>
        </div>
        <p class="rv-desc">${rb.action === "builtin" ? "已回滚到内置数据" : "已恢复到历史版本"}${rb.note ? ` · ${esc(rb.note)}` : ""}</p>
        <div class="rv-facts">
          <span>原版本：${esc(rb.from || "—")}</span>
          <span>目标版本：${esc(rb.to || "内置数据")}</span>
        </div>
      </article>`).join("");
  }

  // ---------------- 详情 / 差异 ----------------

  async function toggleDetail(card) {
    const detail = card.querySelector(".rv-detail");
    const button = card.querySelector('[data-act="toggle"]');
    if (!detail.hidden) {
      detail.hidden = true;
      if (button) button.textContent = "展开差异 ▾";
      return;
    }
    detail.hidden = false;
    if (button) button.textContent = "收起差异 ▴";
    if (detail.dataset.loaded === "1") return;
    detail.innerHTML = `<p class="hint">正在加载差异…</p>`;

    if (card.dataset.published) {
      await renderPublishedDetail(detail, card.dataset.published);
    } else {
      await renderSubmissionDetail(detail, card.dataset.id);
    }
  }

  async function renderSubmissionDetail(detail, id) {
    const res = await DataApi.submission(id);
    if (!res.ok) {
      detail.innerHTML = `<p class="err">${esc(res.error || "加载失败")}</p>`;
      return;
    }
    state.details.set(id, res);
    const sub = res.submission || {};
    const diff = CityDiff.diff(res.base, res.doc);
    const contact = sub.contact ? `<div class="rv-contact">联系方式（仅管理员可见）：${esc(sub.contact)}</div>` : "";
    const ip = sub.ipHash ? `<div class="rv-contact">提交 IP 指纹（仅管理员可见）：${esc(sub.ipHash)}</div>` : "";
    const size = (JSON.stringify(res.doc || {}).length / 1024).toFixed(0);
    detail.innerHTML = `${CityDiff.renderHtml(diff)}${contact}${ip}
      <div class="rv-json"><details><summary>查看提交的完整城市 JSON（约 ${size} KB）</summary><pre>${esc(JSON.stringify(res.doc, null, 2))}</pre></details></div>`;
    detail.dataset.loaded = "1";
  }

  async function renderPublishedDetail(detail, name) {
    const res = await DataApi.publishedCity(name);
    if (!res.ok) {
      detail.innerHTML = `<p class="err">${esc(res.error || "加载失败")}</p>`;
      return;
    }
    const base = await fetchBuiltin(name);
    const diff = CityDiff.diff(base, res.doc);
    const versions = res.versions || [];
    const versionLine = versions.length
      ? `<div class="rv-facts">历史版本：${versions.map((v) => `<a href="?submission=${encodeURIComponent(v.submissionId)}">${fmtTime(v.updatedAt)}</a>`).join("、")}</div>`
      : `<div class="rv-facts">还没有历史版本。</div>`;
    const size = (JSON.stringify(res.doc || {}).length / 1024).toFixed(0);
    detail.innerHTML = `${CityDiff.renderHtml(diff)}${versionLine}
      <div class="rv-json"><details><summary>查看当前生效的完整城市 JSON（约 ${size} KB）</summary><pre>${esc(JSON.stringify(res.doc, null, 2))}</pre></details></div>`;
    detail.dataset.loaded = "1";
  }

  // ---------------- 管理员操作 ----------------

  async function approve(item) {
    if (!confirm(`通过「${item.city}」的这次修改？通过后立即对全站生效，可随时回滚。`)) return;
    const res = await DataApi.approve(item.id);
    if (!res.ok) return toast(res.error || "操作失败");
    toast("已通过，修改已全站生效");
    await refresh();
  }

  async function reject(item) {
    const reason = prompt(`驳回「${item.city}」的这次提交，请填写原因（公开可见）：`, "数据与官方资料不符");
    if (reason === null) return;
    const res = await DataApi.reject(item.id, reason.trim());
    if (!res.ok) return toast(res.error || "操作失败");
    toast("已驳回");
    await refresh();
  }

  async function hide(item) {
    if (!confirm(`隐藏「${item.city}」的这条提交？隐藏后公开页面不再显示（管理员仍可在“全部提交”中看到）。`)) return;
    const res = await DataApi.hide(item.id);
    if (!res.ok) return toast(res.error || "操作失败");
    toast("已隐藏");
    await refresh();
  }

  async function downloadSubmission(item) {
    let detail = state.details.get(item.id);
    if (!detail) {
      const res = await DataApi.submission(item.id);
      if (!res.ok) return toast(res.error || "加载失败");
      detail = res;
      state.details.set(item.id, res);
    }
    saveJson(`${item.city}-${item.id}`, detail.doc);
    toast("已下载提交的 JSON");
  }

  async function downloadPublished(name) {
    const res = await DataApi.publishedCity(name);
    if (!res.ok) return toast(res.error || "加载失败");
    saveJson(name, res.doc);
    toast("已导出当前生效的城市 JSON");
  }

  async function rollback(name, to) {
    const targetLabel = to === "builtin" ? "内置数据" : "上一版本";
    if (!confirm(`确定把「${name}」回滚到${targetLabel}？回滚立即对全站生效，并会记录在审核台。`)) return;
    const note = prompt("回滚说明（公开可见，选填）：", "");
    if (note === null) return;
    const res = await DataApi.revert(name, to, note.trim());
    if (!res.ok) return toast(res.error || "回滚失败");
    toast(to === "builtin" ? "已回滚到内置数据" : "已恢复到历史版本");
    await refresh();
  }

  async function rollbackPrevious(name) {
    const res = await DataApi.publishedCity(name);
    if (!res.ok) return toast(res.error || "加载失败");
    const previous = (res.versions || [])[0];
    if (!previous) return toast("没有更早的版本可以回滚");
    await rollback(name, previous.submissionId);
  }

  // ---------------- 事件 ----------------

  function bindEvents() {
    $("tabs").addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-tab]");
      if (!btn) return;
      loadTab(btn.dataset.tab);
    });

    $("list").addEventListener("click", async (ev) => {
      const btn = ev.target.closest("[data-act]");
      if (!btn) return;
      const card = btn.closest(".rv-card");
      if (!card) return;
      const act = btn.dataset.act;

      if (card.dataset.published) {
        const name = card.dataset.published;
        if (act === "toggle") return toggleDetail(card);
        if (act === "download") return downloadPublished(name);
        if (act === "rollback-prev") return rollbackPrevious(name);
        if (act === "rollback-builtin") return rollback(name, "builtin");
        return;
      }

      const item = state.submissions.find((row) => row.id === card.dataset.id);
      if (!item) return;
      if (act === "toggle") return toggleDetail(card);
      if (act === "download") return downloadSubmission(item);
      if (!state.admin) return;
      if (act === "approve") return approve(item);
      if (act === "reject") return reject(item);
      if (act === "hide") return hide(item);
    });

    $("btn-login").addEventListener("click", () => {
      $("admin-token").value = "";
      $("login-error").hidden = true;
      $("login-dialog").showModal();
      requestAnimationFrame(() => $("admin-token").focus());
    });
    $("btn-login-close").addEventListener("click", () => $("login-dialog").close());
    $("btn-login-cancel").addEventListener("click", () => $("login-dialog").close());
    $("admin-token").addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        $("btn-login-ok").click();
      }
    });
    $("btn-login-ok").addEventListener("click", login);
    document.querySelector("#login-dialog form")?.addEventListener("submit", (ev) => {
      ev.preventDefault();
      login();
    });
    $("btn-logout").addEventListener("click", () => {
      DataApi.setToken("");
      state.admin = false;
      updateAdminUI();
      toast("已退出管理员登录");
      refresh();
    });
  }

  async function login() {
    const error = $("login-error");
    const token = $("admin-token").value.trim();
    if (!token) {
      error.textContent = "请输入管理员口令。";
      error.hidden = false;
      return;
    }
    DataApi.setToken(token);
    const res = await DataApi.adminCheck();
    if (!res.ok) {
      DataApi.setToken("");
      error.textContent = res.error || "登录失败";
      error.hidden = false;
      return;
    }
    state.admin = true;
    $("login-dialog").close();
    updateAdminUI();
    toast("管理员已登录");
    await refresh();
  }

  boot();
})();
