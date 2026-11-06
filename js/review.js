/* 数据审核台（公开读取 + 管理员操作）
 *
 * 公开：提交记录、完整数据、差异、审核结果、已发布数据、回滚记录。
 * 管理员（ADMIN_TOKEN）：通过 / 驳回 / 隐藏 / 回滚 / 封禁匿名 IP 指纹。
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
    bans: [],
    announcements: [],
    details: new Map(),
    banTarget: null,
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
    const health = await refreshHealth();

    if (DataApi.hasToken() && state.backend) {
      const check = await DataApi.adminCheck();
      if (check.ok) state.admin = true;
      else DataApi.setToken("");
    }
    updateAdminUI();
    if (state.admin) await refreshBanState();

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

  async function refreshHealth() {
    const health = await DataApi.health();
    state.backend = Boolean(health.ok);
    state.adminConfigured = Boolean(health.adminConfigured);
    $("offline").hidden = state.backend;
    updateAdminUI();
    return health;
  }

  function updateAdminUI() {
    const label = $("admin-state");
    const blocked = state.backend && !state.adminConfigured;
    if (state.admin) label.textContent = "管理员已登录";
    else if (!state.backend) label.textContent = "审核服务未启用";
    else if (blocked) label.textContent = "未配置 ADMIN_TOKEN";
    else label.textContent = "未登录管理员";
    label.classList.toggle("admin", state.admin);
    label.classList.toggle("warn", !state.admin && (!state.backend || blocked));

    $("btn-logout").hidden = !state.admin;
    $("btn-login").hidden = state.admin;
    $("tab-bans").hidden = !state.admin;
    $("tab-announcements").hidden = !state.admin;
    // 始终允许点击：未配置时打开弹窗给出具体排查步骤，而不是变成无法点击的灰按钮
    $("btn-login").disabled = false;
    $("btn-login").title = blocked
      ? "服务端未读取到 ADMIN_TOKEN，点击查看配置步骤"
      : "输入 ADMIN_TOKEN 后可执行审核与回滚";
  }

  async function refreshBanState() {
    if (!state.admin) {
      state.bans = [];
      return;
    }
    const res = await DataApi.bans();
    if (res.ok) state.bans = res.bans || [];
  }

  // ---------------- 数据加载 ----------------

  async function loadTab(tab) {
    state.tab = tab;
    renderTabs();
    if (!state.backend) {
      $("list").innerHTML = `<div class="rv-empty">审核服务未启用，暂时无法查看在线审核记录。<br>连接审核服务后即可使用。</div>`;
      return;
    }
    $("list").innerHTML = `<p class="hint">正在加载…</p>`;

    if (tab === "bans") {
      if (!state.admin) {
        toast("请先登录管理员");
        return loadTab("pending");
      }
      const [bans, counts] = await Promise.all([DataApi.bans(), DataApi.submissions("all")]);
      if (!bans.ok) return showError(bans);
      state.bans = bans.bans || [];
      if (counts.ok) state.counts = { ...state.counts, ...counts.counts };
      renderSummary();
      renderTabs();
      renderList();
      return;
    }

    if (tab === "announcements") {
      if (!state.admin) {
        toast("请先登录管理员");
        return loadTab("pending");
      }
      const [anns, counts] = await Promise.all([DataApi.announcements(), DataApi.submissions("all")]);
      if (!anns.ok) return showError(anns);
      state.announcements = anns.announcements || [];
      if (counts.ok) state.counts = { ...state.counts, ...counts.counts };
      renderSummary();
      renderTabs();
      renderList();
      return;
    }

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
    const activeBans = state.bans.filter((ban) => ban.active).length;
    const cards = [
      ["待审核", counts.pending ?? 0, "条"],
      ["已通过", counts.approved ?? 0, "条"],
      ["已驳回", counts.rejected ?? 0, "条"],
      ["已回滚", counts.reverted ?? 0, "条"],
      ["已发布城市", state.publishedCount ?? 0, "座"],
      ...(state.admin ? [["生效封禁", activeBans, "个"]] : []),
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
    $("count-bans").textContent = state.bans.filter((ban) => ban.active).length || "";
  }

  function renderList() {
    if (state.tab === "published") return renderPublishedList();
    if (state.tab === "rollbacks") return renderRollbackList();
    if (state.tab === "bans") return renderBanList();
    if (state.tab === "announcements") return renderAnnouncementAdminList();
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
        <button type="button" class="ghost" data-act="toggle">展开差异 <span class="ico ico-mono" style="--icon:url(assets/icons/chevron-down.svg)" aria-hidden="true"></span></button>
      </div>
      <p class="rv-desc">${esc(item.summary)}</p>
      <div class="rv-facts">
        <span>${stats.lines ?? "?"} 条线路 · ${stats.stations ?? "?"} 站</span>
        <span>提交者：匿名用户</span>
        ${state.admin && item.ipHash ? `<span>IP 指纹：<code>${esc(item.ipHash)}</code></span>` : ""}
        ${state.admin && item.ipSubmissionCount > 1 ? `<span>该 IP 共有 ${item.ipSubmissionCount} 条提交</span>` : ""}
        ${item.banned ? `<span class="warn">该提交者已被封禁${item.banUntil ? `至 ${fmtTime(item.banUntil)}` : "（永久）"}${item.banReason ? `：${esc(item.banReason)}` : ""}</span>` : ""}
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
        ${state.admin ? `<button type="button" class="danger" data-act="ban" ${item.ipHash ? "" : "disabled"} title="${item.ipHash ? "按 IP 指纹封禁该提交者" : "这条记录没有可用的 IP 指纹"}">${item.banned ? "调整封禁" : "封禁提交者"}</button>` : ""}
        <button type="button" data-act="download"><span class="ico ico-mono" style="--icon:url(assets/icons/download.svg)" aria-hidden="true"></span> 下载数据</button>
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
          <button type="button" class="ghost" data-act="toggle">展开差异 <span class="ico ico-mono" style="--icon:url(assets/icons/chevron-down.svg)" aria-hidden="true"></span></button>
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

  function renderBanList() {
    const items = state.bans;
    if (!items.length) {
      $("list").innerHTML = empty("目前没有被封禁的匿名提交者。");
      return;
    }
    $("list").innerHTML = items.map(banCard).join("");
  }

  function banCard(ban) {
    const active = ban.active !== false;
    const until = ban.until ? fmtTime(ban.until) : "永久";
    return `<article class="rv-card" data-ban="${esc(ban.ipHash)}">
      <div class="rv-card-head">
        <span class="status ${active ? "status-rejected" : "status-reverted"}">${active ? "封禁中" : "已过期"}</span>
        <b class="rv-city">IP 指纹 ${esc(ban.ipHash)}</b>
        <span class="rv-time">${active ? `到期：${until}` : `已于 ${until} 到期`}</span>
        <div class="spacer"></div>
        <button type="button" class="${active ? "danger" : ""}" data-act="unban">${active ? "解除封禁" : "删除记录"}</button>
      </div>
      <p class="rv-desc">${esc(ban.reason || "（未填写原因）")}</p>
      <div class="rv-facts">
        ${ban.city ? `<span>来源城市：${esc(ban.city)}</span>` : ""}
        ${ban.submissionId ? `<span>来源提交：<a href="?submission=${encodeURIComponent(ban.submissionId)}">${esc(ban.submissionId)}</a></span>` : ""}
        <span>设置于 ${fmtTime(ban.createdAt)}</span>
        <span>更新于 ${fmtTime(ban.updatedAt)}</span>
      </div>
    </article>`;
  }

  function announcementLevel(level) {
    return {
      info: { text: "普通公告", cls: "" },
      important: { text: "重要", cls: "important" },
      warning: { text: "提醒", cls: "warning" },
    }[level] || { text: "普通公告", cls: "" };
  }

  function renderAnnouncementAdminList() {
    const items = state.announcements;
    const form = `
      <article class="rv-card rv-ann-card">
        <div class="rv-card-head">
          <span class="status status-pending">发布公告</span>
          <b class="rv-city">新公告</b>
          <span class="rv-time">发布后立即显示在首页右上角的公告图标中</span>
        </div>
        <div class="rv-ann-form">
          <label class="rv-ann-field">
            <span>标题</span>
            <input id="ann-title" type="text" maxlength="120" placeholder="公告标题">
          </label>
          <label class="rv-ann-field">
            <span>级别</span>
            <select id="ann-level">
              <option value="info">普通公告</option>
              <option value="important">重要</option>
              <option value="warning">提醒</option>
            </select>
          </label>
          <label class="rv-ann-field rv-ann-wide">
            <span>内容</span>
            <textarea id="ann-body" rows="4" maxlength="4000" placeholder="公告正文，支持换行"></textarea>
          </label>
          <div class="err" id="ann-error" hidden></div>
          <div class="rv-card-actions">
            <button type="button" class="primary" data-act="publish-announcement">发布公告</button>
          </div>
        </div>
      </article>`;
    const list = items.length
      ? items.map(announcementAdminCard).join("")
      : empty("还没有发布公告。");
    $("list").innerHTML = form + list;
  }

  function announcementAdminCard(item) {
    const level = announcementLevel(item.level);
    return `<article class="rv-card" data-ann="${esc(item.id)}">
      <div class="rv-card-head">
        <span class="status status-approved">已发布</span>
        <span class="badge">${esc(level.text)}</span>
        <b class="rv-city">${esc(item.title)}</b>
        <span class="rv-time">${fmtTime(item.publishedAt)}</span>
        <div class="spacer"></div>
        <button type="button" class="danger" data-act="delete-announcement">删除公告</button>
      </div>
      <p class="rv-desc rv-ann-body">${esc(item.body)}</p>
      <div class="rv-facts">
        <span>公告 ID：${esc(item.id)}</span>
        <span>级别：${esc(level.text)}</span>
      </div>
    </article>`;
  }

  async function publishAnnouncement() {
    const title = $("ann-title").value.trim();
    const body = $("ann-body").value.trim();
    const level = $("ann-level").value;
    const error = $("ann-error");
    if (title.length < 2) {
      error.textContent = "公告标题至少需要 2 个字。";
      error.hidden = false;
      $("ann-title").focus();
      return;
    }
    if (!body) {
      error.textContent = "公告内容不能为空。";
      error.hidden = false;
      $("ann-body").focus();
      return;
    }

    const button = document.querySelector('[data-act="publish-announcement"]');
    if (button) button.disabled = true;
    const res = await DataApi.createAnnouncement({ title, body, level });
    if (button) button.disabled = false;
    if (!res.ok) {
      error.textContent = res.error || "发布失败";
      error.hidden = false;
      return;
    }
    toast("公告已发布");
    await loadTab("announcements");
  }

  async function deleteAnnouncement(id) {
    const item = state.announcements.find((row) => row.id === id);
    if (!item) return;
    if (!confirm(`确定删除公告「${item.title}」？首页将不再显示。`)) return;
    const res = await DataApi.deleteAnnouncement(id);
    if (!res.ok) return toast(res.error || "删除失败");
    toast("公告已删除");
    await loadTab("announcements");
  }

  // ---------------- 详情 / 差异 ----------------

  async function toggleDetail(card) {
    const detail = card.querySelector(".rv-detail");
    const button = card.querySelector('[data-act="toggle"]');
    if (!detail.hidden) {
      detail.hidden = true;
      if (button) button.innerHTML = '展开差异 <span class="ico ico-mono" style="--icon:url(assets/icons/chevron-down.svg)" aria-hidden="true"></span>';
      return;
    }
    detail.hidden = false;
    if (button) button.innerHTML = '收起差异 <span class="ico ico-mono" style="--icon:url(assets/icons/chevron-up.svg)" aria-hidden="true"></span>';
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
      <div class="rv-json"><details><summary>查看提交的完整城市数据（约 ${size} KB）</summary><pre>${esc(JSON.stringify(res.doc, null, 2))}</pre></details></div>`;
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
      <div class="rv-json"><details><summary>查看当前生效的完整城市数据（约 ${size} KB）</summary><pre>${esc(JSON.stringify(res.doc, null, 2))}</pre></details></div>`;
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
    toast("已下载提交的数据");
  }

  async function downloadPublished(name) {
    const res = await DataApi.publishedCity(name);
    if (!res.ok) return toast(res.error || "加载失败");
    saveJson(name, res.doc);
    toast("已导出当前生效的城市数据");
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

  function openBanDialog(item) {
    if (!item?.ipHash) return toast("这条提交没有可用的 IP 指纹");
    state.banTarget = item;
    $("ban-target").textContent =
      `目标：IP 指纹 ${item.ipHash}${item.city ? ` · 城市「${item.city}」` : ""}${item.banned ? "（当前已封禁，可调整时长）" : ""}`;

    const existing = state.bans.find((ban) => ban.ipHash === item.ipHash);
    if (existing && !existing.until) {
      $("ban-permanent").checked = true;
      $("ban-days").value = "7";
      $("ban-days").disabled = true;
    } else if (existing?.until) {
      const days = Math.ceil((Date.parse(existing.until) - Date.now()) / 86400000);
      $("ban-days").value = String(Math.min(Math.max(days || 1, 1), 3650));
      $("ban-days").disabled = false;
      $("ban-permanent").checked = false;
    } else {
      $("ban-days").value = "7";
      $("ban-days").disabled = false;
      $("ban-permanent").checked = false;
    }
    $("ban-reason").value = "";
    $("ban-error").hidden = true;
    $("ban-dialog").showModal();
    requestAnimationFrame(() => $("ban-days").focus());
  }

  async function submitBan() {
    const item = state.banTarget;
    if (!item?.ipHash) return;
    const permanent = $("ban-permanent").checked;
    const days = Number($("ban-days").value);
    const error = $("ban-error");
    if (!permanent && (!Number.isInteger(days) || days < 1 || days > 3650)) {
      error.textContent = "封禁时长必须是 1 到 3650 天的整数，或勾选永久封禁。";
      error.hidden = false;
      return;
    }

    const button = $("btn-ban-ok");
    button.disabled = true;
    const res = await DataApi.ban(item.ipHash, {
      durationDays: permanent ? null : days,
      reason: $("ban-reason").value.trim(),
      submissionId: item.id || "",
      city: item.city || "",
    });
    button.disabled = false;
    if (!res.ok) {
      error.textContent = res.error || "封禁失败";
      error.hidden = false;
      return;
    }

    $("ban-dialog").close();
    state.banTarget = null;
    toast(permanent ? "已永久封禁该提交者" : `已封禁该提交者 ${days} 天`);
    await refreshBanState();
    await refresh();
  }

  async function unban(ban) {
    if (!ban?.ipHash) return;
    if (!confirm(`解除对 IP 指纹 ${ban.ipHash} 的封禁？`)) return;
    const res = await DataApi.unban(ban.ipHash);
    if (!res.ok) return toast(res.error || "解除封禁失败");
    toast("已解除封禁");
    await refreshBanState();
    await refresh();
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

      if (card.dataset.ban) {
        const ban = state.bans.find((row) => row.ipHash === card.dataset.ban);
        if (ban && act === "unban") await unban(ban);
        return;
      }

      if (act === "publish-announcement") return publishAnnouncement();
      const announcementCard = btn.closest("[data-ann]");
      if (announcementCard && act === "delete-announcement") {
        return deleteAnnouncement(announcementCard.dataset.ann);
      }

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
      if (act === "ban") return openBanDialog(item);
      if (act === "approve") return approve(item);
      if (act === "reject") return reject(item);
      if (act === "hide") return hide(item);
    });

    $("btn-login").addEventListener("click", openLoginDialog);
    $("btn-login-close").addEventListener("click", () => $("login-dialog").close());
    $("btn-login-cancel").addEventListener("click", () => $("login-dialog").close());
    $("btn-recheck").addEventListener("click", recheckConfig);
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
    $("btn-ban-close").addEventListener("click", () => $("ban-dialog").close());
    $("btn-ban-cancel").addEventListener("click", () => $("ban-dialog").close());
    $("btn-ban-ok").addEventListener("click", submitBan);
    $("ban-permanent").addEventListener("change", (ev) => {
      $("ban-days").disabled = ev.target.checked;
    });
    document.querySelector("#ban-dialog form")?.addEventListener("submit", (ev) => {
      ev.preventDefault();
      submitBan();
    });
    $("ban-dialog").addEventListener("close", () => { state.banTarget = null; });

    $("btn-logout").addEventListener("click", () => {
      DataApi.setToken("");
      state.admin = false;
      state.bans = [];
      state.announcements = [];
      updateAdminUI();
      toast("已退出管理员登录");
      loadTab(state.tab === "bans" || state.tab === "announcements" ? "pending" : state.tab);
    });
  }

  function openLoginDialog() {
    if (!state.backend) {
      toast("审核服务未启用：连接审核服务后再登录");
      return;
    }
    $("admin-token").value = "";
    $("login-error").hidden = true;
    $("login-config").hidden = Boolean(state.adminConfigured);
    $("login-dialog").showModal();
    if (state.adminConfigured) requestAnimationFrame(() => $("admin-token").focus());
  }

  async function recheckConfig() {
    const button = $("btn-recheck");
    button.disabled = true;
    button.textContent = "检测中…";
    const health = await refreshHealth();
    button.disabled = false;
    button.textContent = "重新检测配置";

    if (!health.ok) {
      toast("仍无法连接审核服务，请确认站点已部署");
      return;
    }
    if (health.adminConfigured) {
      $("login-config").hidden = true;
      toast("已检测到 ADMIN_TOKEN，可以输入口令登录");
      $("admin-token").focus();
    } else {
      $("login-config").hidden = false;
      toast("仍未检测到 ADMIN_TOKEN：请确认作用域包含 Functions 并已重新部署");
    }
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
      if (res.code === "ADMIN_DISABLED") {
        state.adminConfigured = false;
        $("login-config").hidden = false;
        updateAdminUI();
      }
      return;
    }
    state.admin = true;
    $("login-dialog").close();
    updateAdminUI();
    await refreshBanState();
    toast("管理员已登录");
    await refresh();
  }

  boot();
})();
