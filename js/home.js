/* 首页：选择「新建 / 最近 / 导入」，进入规划或记录编辑器。 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const D = window.TPDrafts;

  const KIND_TITLE = { plan: "规划运转", record: "记录运转" };
  const KIND_LABEL = { plan: "规划", record: "记录" };

  let kind = "plan";

  const MESSAGE_READ_KEY = "transit-planner-web.announcements-read.v1";
  const messageState = { items: [], offline: false, read: loadReadIds() };
  const closingDialogs = new WeakMap();
  let messageRefreshTimer = 0;

  D.migrateLegacy();

  // ---------------- 站信 ----------------

  function loadReadIds() {
    try {
      const raw = JSON.parse(localStorage.getItem(MESSAGE_READ_KEY) || "[]");
      return new Set(Array.isArray(raw) ? raw.filter((id) => typeof id === "string") : []);
    } catch {
      return new Set();
    }
  }

  function saveReadIds() {
    try {
      localStorage.setItem(MESSAGE_READ_KEY, JSON.stringify([...messageState.read].slice(-200)));
    } catch { /* 隐私模式下忽略 */ }
  }

  async function loadMessages() {
    if (!window.DataApi) return;
    const res = await DataApi.messages();
    if (!res.ok) {
      scheduleMessageRefresh("");
      messageState.items = [];
      messageState.offline = Boolean(res.offline);
      renderMessageBadge();
      return;
    }
    scheduleMessageRefresh(res.nextPublicationAt);
    messageState.items = Array.isArray(res.messages) ? res.messages : [];
    messageState.offline = false;
    renderMessageBadge();
  }

  function scheduleMessageRefresh(nextPublicationAt) {
    if (messageRefreshTimer) window.clearTimeout(messageRefreshTimer);
    messageRefreshTimer = 0;
    const publishTime = Date.parse(nextPublicationAt || "");
    if (!Number.isFinite(publishTime)) return;
    const delay = Math.max(0, publishTime - Date.now() + 100);
    messageRefreshTimer = window.setTimeout(() => {
      messageRefreshTimer = 0;
      loadMessages();
      window.addEventListener("focus", loadMessages);
    }, Math.min(delay, 2147483647));
  }

  function renderMessageBadge() {
    const unread = messageState.items.filter((item) => !messageState.read.has(item.id)).length;
    const badge = $("message-badge");
    badge.textContent = String(unread);
    badge.hidden = unread === 0;
    $("btn-messages").title = unread
      ? `${unread} 条未读站信`
      : (messageState.items.length ? "查看站信" : "暂无站信");
  }

  function formatMessageTime(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? String(iso || "") : date.toLocaleString("zh-CN", { hour12: false });
  }

  function renderMessageList() {
    const list = $("messages-list");
    if (!messageState.items.length) {
      $("messages-sub").textContent = "";
      list.innerHTML = messageState.offline
        ? '<p class="empty-hint">站信服务未启用。</p>'
        : '<p class="empty-hint">暂无站信。</p>';
      return;
    }
    $("messages-sub").textContent = `共 ${messageState.items.length} 条`;
    list.innerHTML = messageState.items.map((item) => {
      const level = ["info", "important", "warning"].includes(item.level) ? item.level : "info";
      const label = item.scope === "private"
        ? "审核通知"
        : { info: "全站站信", important: "重要站信", warning: "提醒站信" }[level];
      return `<article class="ann-item ${level}">
        <div class="ann-item-head">
          <span class="ann-level">${label}</span>
          <b>${esc(item.title)}</b>
          <span class="ann-time">${esc(formatMessageTime(item.publishedAt))}</span>
        </div>
        <div class="ann-body">${esc(item.body)}</div>
      </article>`;
    }).join("");
  }

  function markMessagesRead() {
    if (!messageState.items.length) return;
    for (const item of messageState.items) messageState.read.add(item.id);
    saveReadIds();
    renderMessageBadge();
  }

  function showAnimatedDialog(dialog) {
    const pending = closingDialogs.get(dialog);
    if (pending) {
      clearTimeout(pending.timer);
      dialog.removeEventListener("animationend", pending.onEnd);
      closingDialogs.delete(dialog);
    }
    dialog.classList.remove("is-closing");
    if (!dialog.open) dialog.showModal();
  }

  function closeAnimatedDialog(dialog) {
    if (!dialog.open || dialog.classList.contains("is-closing")) return;
    dialog.classList.add("is-closing");

    const finish = () => {
      const pending = closingDialogs.get(dialog);
      if (pending) clearTimeout(pending.timer);
      dialog.removeEventListener("animationend", onEnd);
      closingDialogs.delete(dialog);
      if (dialog.open) dialog.close();
      dialog.classList.remove("is-closing");
    };
    const onEnd = (event) => {
      if (event.target === dialog && event.animationName === "home-dialog-exit") finish();
    };
    dialog.addEventListener("animationend", onEnd);

    const duration = getComputedStyle(dialog).animationDuration.split(",").pop().trim();
    const durationMs = Number.parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000);
    const timer = setTimeout(finish, Number.isFinite(durationMs) ? durationMs + 80 : 260);
    closingDialogs.set(dialog, { timer, onEnd });
  }

  async function openMessages() {
    renderMessageList();
    showAnimatedDialog($("messages-dialog"));
    await loadMessages();
    if (!$("messages-dialog").open || $("messages-dialog").classList.contains("is-closing")) return;
    renderMessageList();
    markMessagesRead();
  }

  $("btn-messages").addEventListener("click", openMessages);
  $("btn-messages-close").addEventListener("click", () => closeAnimatedDialog($("messages-dialog")));
  $("btn-messages-ok").addEventListener("click", () => closeAnimatedDialog($("messages-dialog")));
  $("messages-dialog").addEventListener("click", (ev) => {
    if (ev.target === $("messages-dialog")) closeAnimatedDialog($("messages-dialog"));
  });
  $("messages-dialog").addEventListener("cancel", (ev) => {
    ev.preventDefault();
    closeAnimatedDialog($("messages-dialog"));
  });

  let guideLoaded = false;
  let guideLoading = false;

  async function loadGuide() {
    if (guideLoaded || guideLoading) return;
    guideLoading = true;
    const preview = $("readme-preview");
    preview.innerHTML = '<p class="hint">正在加载说明…</p>';
    try {
      if (!window.MarkdownPreview) throw new Error("Markdown 渲染器未加载");
      const response = await fetch(new URL("README.md", document.baseURI), { cache: "no-cache" });
      if (!response.ok) throw new Error(`读取 README 失败（HTTP ${response.status}）`);
      preview.innerHTML = window.MarkdownPreview.render(await response.text());
      guideLoaded = true;
    } catch (error) {
      preview.innerHTML = `<p>说明暂时无法加载：${esc(error.message || error)}</p>
        <button type="button" class="ghost" data-guide-retry>重新加载</button>`;
    } finally {
      guideLoading = false;
    }
  }

  $("btn-guide").addEventListener("click", () => {
    showAnimatedDialog($("readme-dialog"));
    loadGuide();
  });
  $("btn-guide-close").addEventListener("click", () => closeAnimatedDialog($("readme-dialog")));
  $("readme-dialog").addEventListener("click", (ev) => {
    if (ev.target === $("readme-dialog")) closeAnimatedDialog($("readme-dialog"));
  });
  $("readme-dialog").addEventListener("cancel", (ev) => {
    ev.preventDefault();
    closeAnimatedDialog($("readme-dialog"));
  });
  $("readme-preview").addEventListener("click", (ev) => {
    if (ev.target.closest("[data-guide-retry]")) loadGuide();
  });

  loadMessages();

  // ---------------- 弹窗 ----------------

  document.querySelectorAll(".mode-card").forEach((btn) => {
    btn.addEventListener("click", () => openStartDialog(btn.dataset.kind));
  });

  function openStartDialog(nextKind) {
    kind = nextKind === "record" ? "record" : "plan";
    $("start-title").textContent = KIND_TITLE[kind];
    $("start-sub").textContent = kind === "plan" ? "链条式手动规划" : "按时间记录真实运转";
    $("start-new-desc").textContent = `从零开始编辑一份新的${KIND_LABEL[kind]}`;
    $("start-foot-hint").textContent = kind === "plan"
      ? "规划草稿只保存在本地，不会上传"
      : "记录草稿只保存在本地，不会上传";
    $("recent-panel").hidden = true;
    if (!$("start-dialog").open) $("start-dialog").showModal();
  }

  function closeStartDialog() {
    $("start-dialog").close();
  }

  $("btn-start-close").addEventListener("click", closeStartDialog);
  $("btn-start-cancel").addEventListener("click", closeStartDialog);
  $("start-dialog").addEventListener("click", (ev) => {
    if (ev.target === $("start-dialog")) closeStartDialog();
  });

  // ---------------- 新建 ----------------

  $("start-new").addEventListener("click", () => {
    const draft = D.create(kind);
    goToDraft(draft);
  });

  // ---------------- 最近 ----------------

  $("start-recent").addEventListener("click", () => {
    $("recent-panel").hidden = false;
    renderRecent();
  });

  $("btn-recent-back").addEventListener("click", () => {
    $("recent-panel").hidden = true;
  });

  function renderRecent() {
    const items = D.list(kind);
    const box = $("recent-list");
    if (!items.length) {
      box.innerHTML = `<p class="empty-hint">还没有${KIND_LABEL[kind]}草稿。新建或导入一份后，会自动出现在这里。</p>`;
      return;
    }
    box.innerHTML = items.map((d) => {
      const summary = d.summary || D.summarize(kind, d.data);
      return `
        <div class="recent-item" data-id="${esc(d.id)}" role="button" tabindex="0"
             title="打开草稿「${esc(d.title || "未命名")}」">
          <span class="r-main">
            <span class="r-title">${esc(d.title || "未命名")}</span>
            <span class="r-sub">${esc(summary)}${summary ? " · " : ""}${esc(D.formatWhen(d.updatedAt))}</span>
          </span>
          <button type="button" class="ghost r-del" data-del="${esc(d.id)}" title="删除这份草稿">删除</button>
        </div>`;
    }).join("");
  }

  $("recent-list").addEventListener("click", (ev) => {
    const del = ev.target.closest("[data-del]");
    if (del) {
      ev.stopPropagation();
      deleteDraft(del.dataset.del);
      return;
    }
    const item = ev.target.closest("[data-id]");
    if (!item) return;
    const draft = D.get(kind, item.dataset.id);
    if (draft) goToDraft(draft);
  });

  $("recent-list").addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" || ev.target.closest("[data-del]")) return;
    const item = ev.target.closest("[data-id]");
    if (!item) return;
    ev.preventDefault();
    const draft = D.get(kind, item.dataset.id);
    if (draft) goToDraft(draft);
  });

  function deleteDraft(id) {
    const draft = D.get(kind, id);
    if (!draft) return;
    if (!confirm(`确定删除草稿「${draft.title || "未命名"}」吗？\n此操作不可撤销。`)) return;
    D.remove(kind, id);
    renderRecent();
    toast("已删除草稿");
  }

  // ---------------- 导入 ----------------

  $("start-import").addEventListener("click", () => $("home-file").click());

  $("home-file").addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      const raw = await D.readJSONFile(file);
      const detected = detectKind(raw);
      if (!detected) {
        throw new Error("无法识别文件类型：方案与记录都需要包含 steps（或旧版 segments）数组");
      }
      const payload = extractPayload(detected, raw);
      if (!payload) throw new Error("文件中没有找到有效的方案或记录数据");
      // 规划与记录结构互通：用户点了哪个入口就用哪个编辑器打开，除非文件类型不兼容
      const target = (kind === "plan" || kind === "record") ? kind : detected;
      const title = importTitle(target, payload, file.name);
      const draft = D.create(target, {
        title,
        city: payload.city || "",
        summary: D.summarize(target, payload),
        data: payload,
      });
      goToDraft(draft);
    } catch (err) {
      toast(`导入失败：${err.message}`);
    } finally {
      ev.target.value = "";
    }
  });

  /**
   * 识别 JSON 类型。规划与记录共用 steps 结构：
   * 有 kind 时以 kind 为准；否则任一段带起止时间（start_time / start）即视为记录。
   * 仍然兼容旧版记录的 segments 写法与 { trip: {...} } 包装。
   */
  function detectKind(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.kind === "record" || raw.kind === "plan") return raw.kind;
    const steps = Array.isArray(raw.steps) ? raw.steps : (Array.isArray(raw.segments) ? raw.segments : null);
    if (steps) {
      const looksLikeRecord = steps.some((s) => s && (s.start_time || s.end_time || s.start || s.end));
      return looksLikeRecord ? "record" : "plan";
    }
    if (raw.trip && Array.isArray(raw.trip.steps)) return "plan";
    if (raw.data && typeof raw.data === "object") return detectKind(raw.data);
    return null;
  }

  function extractPayload(kindName, raw) {
    if (Array.isArray(raw.steps) || Array.isArray(raw.segments)) return raw;
    if (kindName === "plan" && raw.trip && Array.isArray(raw.trip.steps)) return raw.trip;
    if (raw.data && typeof raw.data === "object" && detectKind(raw.data) === kindName) return raw.data;
    return null;
  }

  function importTitle(kindName, payload, fileName) {
    const fromFile = String(fileName || "").replace(/\.json$/i, "").trim();
    const own = payload.name || payload.title;
    if (kindName === "plan") return own || fromFile || "我的运转方案";
    return own || fromFile || "我的运转记录";
  }

  function goToDraft(draft) {
    const page = draft.kind === "plan" ? "plan.html" : "record.html";
    location.href = `${page}?id=${encodeURIComponent(draft.id)}`;
  }

  // ---------------- 轻提示 ----------------

  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { el.hidden = true; }, 2600);
  }

})();
