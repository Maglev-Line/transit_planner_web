/* 数据审核接口核心（与具体运行环境解耦，便于 Node 单元测试）。
 *
 * 设计：
 *   - 匿名用户 POST /submissions 提交整份城市 JSON；
 *   - 审核记录、差异所依据的 doc/base、已发布数据、回滚记录全部**公开可读**（联系方式除外）；
 *   - 只有 approve / reject / hide / revert 需要 ADMIN_TOKEN。
 *
 * 存储（Netlify Blobs，键均带前缀，城市名已做安全校验，不会出现路径穿越）：
 *   sub/<id>            提交记录
 *   city/<name>         当前已生效的覆盖数据
 *   versions/<name>     历史版本（用于回滚到任意旧版本）
 *   rb/<id>             回滚记录
 *   ip/<hash>           匿名提交限流
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { MAX_BODY_BYTES, sanitizeCityName, validateCityDoc } from "./city.mjs";

const STORE_PUBLISHED = "transit-planner-published";
const STORE_SUBMISSIONS = "transit-planner-submissions";
const STORE_VERSIONS = "transit-planner-versions";
const STORE_ROLLBACKS = "transit-planner-rollbacks";
const STORE_THROTTLE = "transit-planner-throttle";

const MAX_SUBMISSIONS = 1200;
const MAX_LIST = 200;
const MAX_ROLLBACKS = 200;
const MAX_VERSIONS = 15;
const SUBMIT_LIMIT = 8;
const SUBMIT_WINDOW_MS = 10 * 60 * 1000;
const MAX_SUMMARY = 500;
const MAX_CONTACT = 120;

class HttpError extends Error {
  constructor(status, message, code = "") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function fail(status, error, code = "") {
  return jsonResponse(status, { ok: false, error, ...(code ? { code } : {}) });
}

function ok(body = {}) {
  return jsonResponse(200, { ok: true, ...body });
}

/** @param {unknown} provided @param {string} expected */
function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(String(provided)).digest();
  const b = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

/** 去掉 /api 与 /.netlify/functions/api 前缀，得到内部路由。 */
function normalizePath(pathname) {
  for (const prefix of ["/.netlify/functions/api", "/api"]) {
    if (pathname === prefix) return "/";
    if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length) || "/";
  }
  return pathname || "/";
}

/**
 * @param {{
 *   getStore: (options: { name: string, consistency?: string }) => any,
 *   adminToken?: () => string,
 *   clock?: () => Date,
 * }} options
 */
export function createApi({ getStore, adminToken = () => process.env.ADMIN_TOKEN || "", clock = () => new Date() }) {
  if (typeof getStore !== "function") throw new Error("createApi 需要 getStore 注入");

  const store = (name) => getStore({ name, consistency: "strong" });
  const nowIso = () => clock().toISOString();
  const newId = (prefix) => `${prefix}_${clock().getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  function requireAdmin(req) {
    const expected = String(adminToken() || "");
    if (!expected) {
      return fail(
        503,
        "审核接口未启用：请在 Netlify 站点设置的环境变量中添加 ADMIN_TOKEN，然后重新部署。",
        "ADMIN_DISABLED",
      );
    }
    const provided = req.headers.get("x-admin-token") || "";
    if (!tokenMatches(provided, expected)) return fail(401, "管理员口令不正确。", "UNAUTHORIZED");
    return null;
  }

  function isAdmin(req) {
    const expected = String(adminToken() || "");
    return Boolean(expected) && tokenMatches(req.headers.get("x-admin-token") || "", expected);
  }

  async function readJson(req) {
    const declared = Number(req.headers.get("content-length") || 0);
    if (declared && declared > MAX_BODY_BYTES) throw new HttpError(413, "提交内容过大（上限约 1.5 MB）");
    const text = await req.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new HttpError(413, "提交内容过大（上限约 1.5 MB）");
    if (!text.trim()) throw new HttpError(400, "请求体为空");
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, "请求体不是合法 JSON");
    }
  }

  // ---------------- 读取工具 ----------------

  async function listPublishedRecords() {
    const s = store(STORE_PUBLISHED);
    const { blobs } = await s.list({ prefix: "city/" });
    const records = [];
    for (const { key } of blobs) {
      const record = await s.get(key, { type: "json" });
      if (record?.doc) records.push(record);
    }
    records.sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-Hans-CN"));
    return records;
  }

  async function listSubmissionRecords() {
    const s = store(STORE_SUBMISSIONS);
    const { blobs } = await s.list({ prefix: "sub/" });
    const records = [];
    for (const { key } of blobs) {
      const record = await s.get(key, { type: "json" });
      if (record) records.push(record);
    }
    records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return records;
  }

  function serializeSubmission(record, admin) {
    const base = {
      id: record.id,
      kind: record.kind,
      city: record.city,
      summary: record.summary,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      reviewedAt: record.reviewedAt || "",
      revertedAt: record.revertedAt || "",
      reason: record.reason || "",
      stats: record.stats || { lines: 0, stations: 0, segments: 0 },
      cityVersion: record.cityVersion || "",
      hasBase: Boolean(record.hasBase),
    };
    if (!admin) return base;
    return {
      ...base,
      contact: record.contact || "",
      ipHash: record.ipHash || "",
      docBytes: record.docBytes || 0,
    };
  }

  async function getSubmission(id) {
    return store(STORE_SUBMISSIONS).get(`sub/${id}`, { type: "json" });
  }

  async function getSubmissionPayload(id) {
    return store(STORE_SUBMISSIONS).get(`payload/${id}`, { type: "json" });
  }

  async function loadVersions(name) {
    const list = await store(STORE_VERSIONS).get(`versions/${name}`, { type: "json" });
    return Array.isArray(list) ? list : [];
  }

  async function saveVersions(name, list) {
    // 每个版本保存完整城市数据，按体积裁剪，避免逼近 Blobs 单值上限
    const kept = [];
    let bytes = 0;
    for (const version of list) {
      const size = JSON.stringify(version).length;
      if (kept.length >= MAX_VERSIONS || bytes + size > 3_500_000) break;
      kept.push(version);
      bytes += size;
    }
    await store(STORE_VERSIONS).setJSON(`versions/${name}`, kept);
  }

  function versionOfPublished(record) {
    return {
      submissionId: record.submissionId || "",
      updatedAt: record.updatedAt || "",
      summary: record.summary || "",
      kind: record.kind || "edit",
      stats: record.stats || null,
      doc: record.doc,
    };
  }

  async function markSubmission(id, patch) {
    if (!id) return;
    const s = store(STORE_SUBMISSIONS);
    const record = await s.get(`sub/${id}`, { type: "json" });
    if (!record) return;
    await s.setJSON(`sub/${id}`, { ...record, ...patch, updatedAt: nowIso() });
  }

  async function checkThrottle(ip) {
    if (!ip || ip === "unknown") return { ok: true }; // 拿不到来源 IP 时不做全局限流
    try {
      const s = store(STORE_THROTTLE);
      const key = `ip/${createHash("sha256").update(`transit-planner:${ip}`).digest("hex").slice(0, 32)}`;
      const now = clock().getTime();
      const record = await s.get(key, { type: "json" });
      if (!record || typeof record.resetAt !== "number" || now >= record.resetAt) {
        await s.setJSON(key, { count: 1, resetAt: now + SUBMIT_WINDOW_MS });
        return { ok: true };
      }
      if (record.count >= SUBMIT_LIMIT) {
        const minutes = Math.max(1, Math.ceil((record.resetAt - now) / 60000));
        return { ok: false, error: `提交过于频繁，请 ${minutes} 分钟后再试。` };
      }
      await s.setJSON(key, { count: record.count + 1, resetAt: record.resetAt });
      return { ok: true };
    } catch {
      return { ok: true }; // 限流存储异常时不阻断正常提交
    }
  }

  // ---------------- 路由 ----------------

  async function route({ req, path, method, context }) {
    if (path === "/health" && method === "GET") {
      return ok({ backend: "netlify-blobs", adminConfigured: Boolean(adminToken()), time: nowIso() });
    }

    // 管理员口令自检：只校验口令，不返回任何数据
    if (path === "/admin/check" && method === "GET") {
      const denied = requireAdmin(req);
      if (denied) return denied;
      return ok({ admin: true, time: nowIso() });
    }

    if (path === "/cities" && method === "GET") {
      const records = await listPublishedRecords();
      const cities = {};
      let updatedAt = "";
      for (const record of records) {
        cities[record.name] = {
          doc: record.doc,
          updatedAt: record.updatedAt || "",
          submissionId: record.submissionId || "",
          summary: record.summary || "",
          kind: record.kind || "edit",
        };
        if (String(record.updatedAt || "") > updatedAt) updatedAt = String(record.updatedAt);
      }
      return ok({ cities, updatedAt, count: records.length });
    }

    if (path === "/submissions") {
      if (method === "GET") {
        const url = new URL(req.url);
        const status = (url.searchParams.get("status") || "all").toLowerCase();
        const admin = isAdmin(req);
        const records = await listSubmissionRecords();
        const items = records
          .filter((record) => admin || record.status !== "hidden")
          .filter((record) => (status === "all" ? true : record.status === status))
          .slice(0, MAX_LIST)
          .map((record) => serializeSubmission(record, admin));
        const counts = { all: 0, pending: 0, approved: 0, rejected: 0, reverted: 0 };
        for (const record of records) {
          if (record.status === "hidden") continue;
          counts.all += 1;
          if (record.status in counts && record.status !== "all") counts[record.status] += 1;
        }
        return ok({ submissions: items, counts });
      }
      if (method === "POST") {
        const ip =
          context?.ip ||
          req.headers.get("x-nf-client-connection-ip") ||
          req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
          "unknown";
        const throttle = await checkThrottle(ip);
        if (!throttle.ok) throw new HttpError(429, throttle.error);

        const body = await readJson(req);
        const summary = String(body.summary ?? "").trim();
        if (summary.length < 4) throw new HttpError(400, "请填写至少 4 个字的修改说明，方便其他人理解这次改动。");
        if (summary.length > MAX_SUMMARY) throw new HttpError(400, `修改说明过长（上限 ${MAX_SUMMARY} 字）。`);
        const contact = String(body.contact ?? "").trim().slice(0, MAX_CONTACT);
        const kind = body.kind === "new" ? "new" : "edit";

        const nameResult = sanitizeCityName(body.city);
        if (!nameResult.ok) throw new HttpError(400, nameResult.error);
        const cityName = nameResult.name;

        const docCheck = validateCityDoc(body.doc);
        if (!docCheck.ok) {
          throw new HttpError(400, `城市数据校验未通过：${docCheck.errors.slice(0, 5).join("；")}`);
        }
        if (String(body.doc.city ?? "").trim() !== cityName) {
          throw new HttpError(400, `数据里的城市名「${body.doc.city ?? ""}」与提交目标「${cityName}」不一致。`);
        }

        let base = null;
        if (body.base != null) {
          const baseCheck = validateCityDoc(body.base);
          if (!baseCheck.ok) throw new HttpError(400, "对比基线数据不合法，请刷新页面后重试。");
          base = body.base;
        }
        if (Buffer.byteLength(JSON.stringify(base ?? {}), "utf8") + Buffer.byteLength(JSON.stringify(body.doc), "utf8") > MAX_BODY_BYTES) {
          throw new HttpError(413, "提交内容过大（上限约 1.5 MB）");
        }

        const records = await listSubmissionRecords();
        if (records.length >= MAX_SUBMISSIONS) {
          throw new HttpError(429, "审核队列已满，请稍后再试。");
        }

        const createdAt = nowIso();
        const record = {
          id: newId("sub"),
          kind,
          city: cityName,
          summary,
          contact,
          status: "pending",
          createdAt,
          updatedAt: createdAt,
          reviewedAt: "",
          revertedAt: "",
          reason: "",
          ipHash: createHash("sha256").update(`transit-planner:${ip}`).digest("hex").slice(0, 16),
          cityVersion: String(body.doc.version || ""),
          hasBase: Boolean(base),
          docBytes: JSON.stringify(body.doc).length,
          stats: docCheck.stats,
          schema: 1,
        };
        const submissions = store(STORE_SUBMISSIONS);
        await submissions.setJSON(`sub/${record.id}`, record);
        await submissions.setJSON(`payload/${record.id}`, { doc: body.doc, base });
        return jsonResponse(201, {
          ok: true,
          id: record.id,
          reviewUrl: `/review.html?submission=${encodeURIComponent(record.id)}`,
        });
      }
      return fail(405, "不支持的方法");
    }

    const submissionMatch = path.match(/^\/submissions\/([A-Za-z0-9_-]{1,80})$/);
    if (submissionMatch) {
      const id = submissionMatch[1];
      if (method === "GET") {
        const record = await getSubmission(id);
        const admin = isAdmin(req);
        if (!record || (record.status === "hidden" && !admin)) return fail(404, "没有找到这条提交记录。");
        const payload = await getSubmissionPayload(id);
        if (!payload?.doc) return fail(409, "这条提交的数据已不存在。");
        return ok({
          submission: serializeSubmission(record, admin),
          doc: payload.doc,
          base: payload.base ?? null,
          admin,
        });
      }
      return fail(405, "不支持的方法");
    }

    const actionMatch = path.match(/^\/submissions\/([A-Za-z0-9_-]{1,80})\/(approve|reject|hide)$/);
    if (actionMatch && method === "POST") {
      const denied = requireAdmin(req);
      if (denied) return denied;
      const [, id, action] = actionMatch;
      const record = await getSubmission(id);
      if (!record) return fail(404, "没有找到这条提交记录。");
      if (record.status === "hidden" && action !== "hide") return fail(409, "该提交已被隐藏，无法审核。");

      if (action === "approve") {
        if (record.status !== "pending") return fail(409, "只能通过「待审核」状态的提交。");
        const payload = await getSubmissionPayload(record.id);
        if (!payload?.doc) return fail(409, "这条提交的数据已不存在，无法生效。");
        const check = validateCityDoc(payload.doc);
        if (!check.ok) return fail(409, `提交数据校验未通过：${check.errors.slice(0, 3).join("；")}`);
        const publishedAt = nowIso();
        const previous = await store(STORE_PUBLISHED).get(`city/${record.city}`, { type: "json" });
        const versions = await loadVersions(record.city);
        if (previous?.doc) versions.unshift(versionOfPublished(previous));
        await saveVersions(record.city, versions);

        const published = {
          name: record.city,
          doc: payload.doc,
          updatedAt: publishedAt,
          submissionId: record.id,
          summary: record.summary,
          kind: record.kind,
          stats: check.stats,
          versionCount: Math.min(versions.length, MAX_VERSIONS),
          schema: 1,
        };
        await store(STORE_PUBLISHED).setJSON(`city/${record.city}`, published);
        await markSubmission(record.id, { status: "approved", reviewedAt: publishedAt, revertedAt: "", reason: "" });
        return ok({ published: { ...published, doc: undefined }, versions: versions.length });
      }

      if (action === "reject") {
        if (record.status !== "pending") return fail(409, "只能驳回「待审核」状态的提交。");
        const body = method === "POST" ? await readJson(req).catch(() => ({})) : {};
        const reason = String(body.reason ?? "").trim().slice(0, 300);
        const reviewedAt = nowIso();
        await markSubmission(record.id, { status: "rejected", reviewedAt, reason });
        return ok({ id: record.id, status: "rejected", reason });
      }

      // hide：仅管理员可见，用于处理垃圾提交
      await markSubmission(record.id, { status: "hidden", reviewedAt: nowIso() });
      return ok({ id: record.id, status: "hidden" });
    }

    if (path === "/published" && method === "GET") {
      const records = await listPublishedRecords();
      return ok({
        cities: records.map(({ doc, ...rest }) => rest),
        count: records.length,
      });
    }

    const publishedMatch = path.match(/^\/published\/([^/]{1,60})$/);
    if (publishedMatch && method === "GET") {
      const nameResult = sanitizeCityName(decodeURIComponent(publishedMatch[1]));
      if (!nameResult.ok) return fail(400, nameResult.error);
      const record = await store(STORE_PUBLISHED).get(`city/${nameResult.name}`, { type: "json" });
      if (!record?.doc) return fail(404, "该城市当前没有审核通过的覆盖数据（正在使用内置数据）。");
      const versions = await loadVersions(nameResult.name);
      return ok({
        city: {
          name: record.name,
          updatedAt: record.updatedAt,
          submissionId: record.submissionId,
          summary: record.summary,
          kind: record.kind,
          stats: record.stats,
          versionCount: versions.length,
        },
        doc: record.doc,
        versions: versions.map(({ doc, ...rest }) => rest),
      });
    }

    const revertMatch = path.match(/^\/published\/([^/]{1,60})\/revert$/);
    if (revertMatch && method === "POST") {
      const denied = requireAdmin(req);
      if (denied) return denied;
      const nameResult = sanitizeCityName(decodeURIComponent(revertMatch[1]));
      if (!nameResult.ok) return fail(400, nameResult.error);
      const name = nameResult.name;

      const body = await readJson(req);
      const to = String(body.to ?? "builtin");
      const note = String(body.note ?? "").trim().slice(0, 300);

      const publishedStore = store(STORE_PUBLISHED);
      const current = await publishedStore.get(`city/${name}`, { type: "json" });
      if (!current?.doc) return fail(404, "该城市当前没有可回滚的审核数据。");

      const versions = await loadVersions(name);
      versions.unshift(versionOfPublished(current));
      const at = nowIso();

      if (to === "builtin") {
        await saveVersions(name, versions);
        await publishedStore.delete(`city/${name}`);
        await markSubmission(current.submissionId, { status: "reverted", revertedAt: at });
        const rollback = {
          id: newId("rb"),
          city: name,
          at,
          action: "builtin",
          from: current.submissionId || "",
          to: "",
          note,
        };
        await store(STORE_ROLLBACKS).setJSON(`rb/${rollback.id}`, rollback);
        return ok({ rolledBack: true, city: name, to: "builtin", rollback });
      }

      const targetIndex = versions.findIndex((version) => version.submissionId === to);
      if (targetIndex < 0) return fail(404, "没有找到要恢复的历史版本。");
      const [target] = versions.splice(targetIndex, 1);
      const check = validateCityDoc(target.doc);
      if (!check.ok) return fail(409, "历史版本数据已损坏，无法恢复。");

      const record = {
        name,
        doc: target.doc,
        updatedAt: at,
        submissionId: target.submissionId,
        summary: target.summary || current.summary,
        kind: target.kind || "edit",
        stats: check.stats,
        versionCount: Math.min(versions.length, MAX_VERSIONS),
        restoredFrom: current.submissionId || "",
        schema: 1,
      };
      await publishedStore.setJSON(`city/${name}`, record);
      await saveVersions(name, versions);
      await markSubmission(current.submissionId, { status: "reverted", revertedAt: at });
      await markSubmission(target.submissionId, { status: "approved", revertedAt: "" });
      const rollback = {
        id: newId("rb"),
        city: name,
        at,
        action: "restore",
        from: current.submissionId || "",
        to: target.submissionId || "",
        note,
      };
      await store(STORE_ROLLBACKS).setJSON(`rb/${rollback.id}`, rollback);
      return ok({ rolledBack: true, city: name, to: target.submissionId, published: { ...record, doc: undefined }, rollback });
    }

    if (path === "/rollbacks" && method === "GET") {
      const s = store(STORE_ROLLBACKS);
      const { blobs } = await s.list({ prefix: "rb/" });
      const records = [];
      for (const { key } of blobs) {
        const record = await s.get(key, { type: "json" });
        if (record) records.push(record);
      }
      records.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      return ok({ rollbacks: records.slice(0, MAX_ROLLBACKS) });
    }

    return fail(404, `未知接口：${path}`);
  }

  return async function handle(req, context = {}) {
    try {
      const url = new URL(req.url, "http://localhost");
      const path = normalizePath(url.pathname);
      const method = String(req.method || "GET").toUpperCase();
      return await route({ req, path, method, context });
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status, err.message, err.code);
      const message = String(err?.message || err);
      console.error("[transit-planner-api]", message);
      if (/Netlify Blobs|has not been configured|MissingBlobsEnvironmentError|MissingBlobsEnvironment/i.test(message)) {
        return fail(
          503,
          "审核存储不可用：请通过 Netlify 部署（或在本地运行 netlify dev）后再使用在线审核功能。",
          "STORAGE_UNAVAILABLE",
        );
      }
      return fail(500, `服务器内部错误：${message}`, "SERVER_ERROR");
    }
  };
}
