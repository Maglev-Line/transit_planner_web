/**
 * 服务端审核接口测试（不需要 Netlify 账号）。
 *
 * 用内存存储替换 Netlify Blobs，直接跑 netlify/lib/api-core.mjs 的完整路由：
 * 匿名提交 → 公开记录 → 管理员审核 → 全站生效 → 回滚 → 驳回 / 隐藏 / 限流。
 *
 * 用法：node tools/test_server.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createApi } from "../netlify/lib/api-core.mjs";
import { validateCityDoc } from "../netlify/lib/city.mjs";

const ADMIN_TOKEN = "test-admin-token";

function memoryStoreFactory() {
  const stores = new Map();
  return function getStore({ name }) {
    if (!stores.has(name)) stores.set(name, new Map());
    const data = stores.get(name);
    return {
      async get(key, options = {}) {
        if (!data.has(key)) return null;
        const value = JSON.parse(JSON.stringify(data.get(key)));
        return options.type === "json" ? value : JSON.stringify(value);
      },
      async setJSON(key, value) {
        data.set(key, JSON.parse(JSON.stringify(value)));
        return { modified: true };
      },
      async delete(key) {
        data.delete(key);
      },
      async list({ prefix = "" } = {}) {
        return {
          blobs: [...data.keys()].filter((key) => key.startsWith(prefix)).sort().map((key) => ({ key })),
          directories: [],
        };
      },
    };
  };
}

const api = createApi({ getStore: memoryStoreFactory(), adminToken: () => ADMIN_TOKEN });
const beijingDoc = JSON.parse(await readFile(new URL("../py/data/北京.json", import.meta.url), "utf8"));
const throughValidation = validateCityDoc(beijingDoc);
assert.ok(throughValidation.ok, `北京贯通交路应通过服务端校验：${throughValidation.errors.join("；")}`);
const invalidThroughDoc = structuredClone(beijingDoc);
invalidThroughDoc.through_services[0].segments[1].from_station = "不存在的站";
assert.ok(!validateCityDoc(invalidThroughDoc).ok, "不存在衔接站的贯通交路应被服务端拒绝");
const chongqingDoc = JSON.parse(await readFile(new URL("../py/data/重庆.json", import.meta.url), "utf8"));
const chongqingThroughValidation = validateCityDoc(chongqingDoc);
assert.ok(
  chongqingThroughValidation.ok,
  `包含环线区段及跨线快车的重庆贯通车应通过服务端校验：${chongqingThroughValidation.errors.join("；")}`,
);
const invalidRingDirectionDoc = structuredClone(chongqingDoc);
invalidRingDirectionDoc.through_services[0].segments[1].reverse = "顺时针";
assert.ok(
  !validateCityDoc(invalidRingDirectionDoc).ok,
  "环线贯通区段的 reverse 必须为布尔值",
);
const invalidThroughExpressDoc = structuredClone(chongqingDoc);
invalidThroughExpressDoc.through_services[0].express[0].skip_minutes = -1;
assert.ok(
  !validateCityDoc(invalidThroughExpressDoc).ok,
  "贯通快车的 skip_minutes 必须为非负数",
);
const shanghaiDoc = JSON.parse(await readFile(new URL("../py/data/上海.json", import.meta.url), "utf8"));
assert.ok(
  validateCityDoc(shanghaiDoc).ok,
  "上海线路系统与系统限定的转乘站对应通过服务端校验",
);
const incompleteTransferEndpoint = structuredClone(shanghaiDoc);
incompleteTransferEndpoint.transfers[0][0].system = "";
assert.ok(
  !validateCityDoc(incompleteTransferEndpoint).ok,
  "转乘站对未声明端点系统时应被服务端拒绝",
);
const suzhouDoc = JSON.parse(await readFile(new URL("../py/data/苏州.json", import.meta.url), "utf8"));
assert.ok(
  validateCityDoc(suzhouDoc).ok,
  "苏州线路系统分类与转乘站对通过服务端校验",
);
assert.deepEqual(
  new Set(suzhouDoc.systems),
  new Set(["地铁系统", "有轨电车系统", "智轨系统"]),
  "苏州只保留地铁、有轨电车和智轨系统",
);
assert.ok(
  suzhouDoc.lines.every((line) => line.type !== "national_rail"),
  "苏州不应包含国铁线路数据",
);
const unlistedLineSystem = structuredClone(suzhouDoc);
unlistedLineSystem.lines[0].system = "未声明系统";
assert.ok(
  !validateCityDoc(unlistedLineSystem).ok,
  "所属系统未登记在线路系统清单时应被服务端拒绝",
);

async function call(path, { method = "GET", body, token = "", inboxToken = "", ip = "10.0.0.1" } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["x-admin-token"] = token;
  if (inboxToken) headers["x-inbox-token"] = inboxToken;
  const response = await api(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { ip },
  );
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
  return { status: response.status, body: payload };
}

function cityDoc(name, stationSuffix = "") {
  return {
    city: name,
    region: "测试",
    version: "1.0",
    lines: [
      {
        id: "t1",
        name: "测试线",
        short_name: "测试线",
        type: "metro",
        color: "#123456",
        color2: "",
        operator: "测试运营",
        stations: ["甲站", `乙站${stationSuffix}`, "丙站"],
        travel_minutes: [2, 3],
        headway_rush: 10,
        headway_normal: 15,
        first_train: "06:00",
        last_train: "23:00",
        ring: false,
        directions: [
          { label: "丙站方向", terminal: "丙站", reverse: false },
          { label: "甲站方向", terminal: "甲站", reverse: false },
        ],
      },
    ],
    external_walks: {},
    transfers: [],
    aliases: [],
  };
}

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`[√] ${message}`);
}

const health = await call("/api/health");
ok(health.status === 200 && health.body.ok && health.body.adminConfigured, "健康检查可用，且已配置管理员口令");

let res = await call("/api/admin/check");
ok(res.status === 401, "未携带口令时管理员自检被拒绝");
res = await call("/api/admin/check", { token: ADMIN_TOKEN });
ok(res.status === 200 && res.body.ok, "正确口令可通过管理员自检");

res = await call("/api/submissions", {
  method: "POST",
  body: { city: "测试城", summary: "短", kind: "new", doc: cityDoc("测试城") },
});
ok(res.status === 400, "修改说明过短会被拒绝");

res = await call("/api/submissions", {
  method: "POST",
  ip: "10.0.0.2",
  body: { city: "测试城", summary: "空线路", kind: "new", doc: { city: "测试城", lines: [] } },
});
ok(res.status === 400, "非法城市数据会被拒绝");

res = await call("/api/submissions", {
  method: "POST",
  ip: "10.0.0.2",
  body: { city: "../evil", summary: "路径穿越", kind: "new", doc: cityDoc("../evil") },
});
ok(res.status === 400, "包含路径穿越字符的城市名会被拒绝");

res = await call("/api/submissions", {
  method: "POST",
  ip: "10.0.0.3",
  body: {
    city: "测试城",
    summary: "新建测试城市",
    kind: "new",
    contact: "tester@example.com",
    doc: cityDoc("测试城"),
  },
});
ok(res.status === 201 && res.body.id, "匿名用户可提交新城市");
const sub1 = res.body.id;

res = await call("/api/submissions?status=pending");
ok(res.status === 200 && res.body.submissions.length === 1, "公开列表能看到待审核提交");
ok(!("contact" in res.body.submissions[0]) && !("doc" in res.body.submissions[0]), "公开列表不泄露联系方式与完整数据");

res = await call(`/api/submissions/${sub1}`);
ok(res.status === 200 && res.body.doc.city === "测试城", "公开详情可查看完整提交数据");
ok(res.body.submission.contact === undefined, "匿名访问看不到联系方式");

res = await call(`/api/submissions/${sub1}`, { token: ADMIN_TOKEN });
ok(res.body.submission.contact === "tester@example.com", "管理员能看到联系方式");

res = await call(`/api/submissions/${sub1}/approve`, { method: "POST", token: "wrong", body: {} });
ok(res.status === 401, "错误口令无法通过审核");

res = await call(`/api/submissions/${sub1}/approve`, { method: "POST", token: ADMIN_TOKEN, body: {} });
ok(res.status === 200 && res.body.ok, "管理员通过审核");

res = await call("/api/cities");
ok(res.body.cities["测试城"]?.doc?.lines?.length === 1, "通过后覆盖数据立即可公开读取");

res = await call("/api/published");
ok(res.body.cities.length === 1 && res.body.cities[0].name === "测试城", "已发布列表包含该城市");

const v1 = res.body.cities[0];
res = await call("/api/published/测试城");
ok(res.status === 200 && res.body.doc.lines[0].stations[1] === "乙站", "可以读取当前生效版本");

res = await call("/api/submissions", {
  method: "POST",
  ip: "10.0.0.4",
  body: {
    city: "测试城",
    kind: "edit",
    summary: "修改乙站名称",
    base: v1.doc || (await call("/api/cities")).body.cities["测试城"].doc,
    doc: cityDoc("测试城", "改"),
  },
});
ok(res.status === 201, "可基于线上数据提交修改");
const sub2 = res.body.id;

await call(`/api/submissions/${sub2}/approve`, { method: "POST", token: ADMIN_TOKEN, body: {} });
res = await call("/api/published/测试城");
ok(res.body.doc.lines[0].stations[1] === "乙站改", "第二次通过后覆盖为新版本");
ok(res.body.versions.length === 1, "旧版本进入历史版本列表");
const previousVersion = res.body.versions[0].submissionId;

res = await call("/api/published/测试城/revert", {
  method: "POST",
  token: ADMIN_TOKEN,
  body: { to: previousVersion, note: "恢复旧站名" },
});
ok(res.status === 200 && res.body.ok, "管理员可回滚到指定历史版本");

res = await call("/api/published/测试城");
ok(res.body.doc.lines[0].stations[1] === "乙站", "回滚后数据恢复为旧版本");

res = await call("/api/submissions?status=reverted");
ok(res.body.submissions.some((item) => item.id === sub2), "被回滚的提交标记为「已回滚」");

res = await call("/api/rollbacks");
ok(res.body.rollbacks.length === 1 && res.body.rollbacks[0].note === "恢复旧站名", "回滚记录公开可查");

res = await call("/api/published/测试城/revert", {
  method: "POST",
  token: ADMIN_TOKEN,
  body: { to: "builtin" },
});
ok(res.status === 200, "管理员可回滚到内置数据");

res = await call("/api/cities");
ok(!res.body.cities["测试城"], "回滚到内置后不再返回覆盖数据");
res = await call("/api/published");
ok(res.body.cities.length === 0, "已发布列表清空");

res = await call("/api/submissions", {
  method: "POST",
  ip: "10.0.0.5",
  body: { city: "测试城", kind: "new", summary: "再提交一次", doc: cityDoc("测试城") },
});
const sub3 = res.body.id;
res = await call(`/api/submissions/${sub3}/reject`, {
  method: "POST",
  token: ADMIN_TOKEN,
  body: { reason: "测试驳回原因" },
});
ok(res.status === 200 && res.body.status === "rejected", "管理员可驳回提交");
res = await call("/api/submissions?status=rejected");
ok(res.body.submissions.some((item) => item.id === sub3 && item.reason === "测试驳回原因"), "驳回原因公开可见");

res = await call("/api/submissions", {
  method: "POST",
  ip: "10.0.0.6",
  body: { city: "垃圾城", kind: "new", summary: "垃圾信息测试", doc: cityDoc("垃圾城") },
});
const sub4 = res.body.id;
res = await call(`/api/submissions/${sub4}/hide`, { method: "POST", token: ADMIN_TOKEN, body: {} });
ok(res.status === 200, "管理员可隐藏垃圾提交");
res = await call("/api/submissions?status=all");
ok(!res.body.submissions.some((item) => item.id === sub4), "隐藏的提交不出现在公开列表");
res = await call("/api/submissions?status=all", { token: ADMIN_TOKEN });
ok(res.body.submissions.some((item) => item.id === sub4), "管理员仍能看到隐藏的提交");
res = await call(`/api/submissions/${sub4}`);
ok(res.status === 404, "隐藏的提交对匿名访问返回 404");

// 匿名 IP 指纹封禁
res = await call("/api/submissions", {
  method: "POST",
  ip: "10.0.0.7",
  body: { city: "封禁城", kind: "new", summary: "封禁测试提交", doc: cityDoc("封禁城") },
});
ok(res.status === 201, "封禁测试提交创建成功");
const subBan = res.body.id;

res = await call(`/api/submissions/${subBan}`);
ok(res.body.submission.ipHash === undefined, "匿名访问看不到 IP 指纹");

res = await call(`/api/submissions/${subBan}`, { token: ADMIN_TOKEN });
const banIpHashes = res.body.submission.ipHash;
ok(/^[a-f0-9]{16}$/.test(banIpHashes), "管理员能看到 IP 指纹");

res = await call("/api/bans");
ok(res.status === 401, "匿名访问封禁名单被拒绝");

res = await call(`/api/bans/${banIpHashes}`, {
  method: "POST",
  token: ADMIN_TOKEN,
  body: { durationDays: 3, reason: "恶意修改测试", city: "封禁城", submissionId: subBan },
});
ok(res.status === 200 && res.body.ban?.until, "管理员可按天数封禁 IP 指纹");

res = await call("/api/submissions", {
  method: "POST",
  ip: "10.0.0.7",
  body: { city: "封禁城", kind: "new", summary: "封禁后仍尝试提交", doc: cityDoc("封禁城") },
});
ok(res.status === 403 && res.body.code === "BANNED", "被封禁的 IP 无法继续提交");

res = await call("/api/submissions", {
  method: "POST",
  ip: "10.0.0.8",
  body: { city: "正常城", kind: "new", summary: "其他 IP 正常提交", doc: cityDoc("正常城") },
});
ok(res.status === 201, "封禁不会影响其他 IP");
const subNormal = res.body.id;

res = await call("/api/bans", { token: ADMIN_TOKEN });
ok(res.status === 200 && res.body.bans.some((ban) => ban.ipHash === banIpHashes && ban.active), "管理员可查看生效中的封禁");

res = await call("/api/submissions?status=all", { token: ADMIN_TOKEN });
const bannedItem = res.body.submissions.find((item) => item.id === subBan);
ok(bannedItem?.banned === true && bannedItem.banReason === "恶意修改测试", "提交列表标记被封禁的匿名用户");

res = await call(`/api/bans/${banIpHashes}`, {
  method: "POST",
  token: ADMIN_TOKEN,
  body: { durationDays: -1 },
});
ok(res.status === 400, "非法封禁时长会被拒绝");

res = await call(`/api/bans/${banIpHashes}`, { method: "DELETE", token: ADMIN_TOKEN });
ok(res.status === 200 && res.body.removed, "管理员可解除封禁");

res = await call("/api/submissions", {
  method: "POST",
  ip: "10.0.0.7",
  body: { city: "封禁城", kind: "new", summary: "解除后恢复提交", doc: cityDoc("封禁城") },
});
ok(res.status === 201, "解除封禁后可恢复提交");

res = await call("/api/submissions?status=all", { token: ADMIN_TOKEN });
const repeatedIp = res.body.submissions.filter((item) => item.ipHash === banIpHashes);
ok(repeatedIp.length >= 2 && repeatedIp.every((item) => item.ipSubmissionCount === repeatedIp.length), "管理员可看到同一 IP 的累计提交次数");

res = await call(`/api/submissions/${subNormal}`, { token: ADMIN_TOKEN });
const normalIpHashes = res.body.submission.ipHash;
res = await call(`/api/bans/${normalIpHashes}`, {
  method: "POST",
  token: ADMIN_TOKEN,
  body: { durationDays: null, reason: "永久封禁测试", city: "正常城", submissionId: subNormal },
});
ok(res.status === 200 && res.body.ban?.until === "", "管理员可设置永久封禁");

res = await call("/api/submissions", {
  method: "POST",
  ip: "10.0.0.8",
  body: { city: "正常城", kind: "new", summary: "永久封禁后提交", doc: cityDoc("正常城") },
});
ok(res.status === 403 && res.body.code === "BANNED", "永久封禁同样阻止提交");

res = await call(`/api/bans/${normalIpHashes}`, { method: "DELETE", token: ADMIN_TOKEN });
ok(res.status === 200, "永久封禁也可解除");

// 快车（大站快车）数据：服务端校验必须放行合法数据、拦下非法数据
function expressDoc(stops) {
  const doc = cityDoc("快车城");
  doc.lines[0].express = [{ id: "rapid", name: "大站车", stops, skip_minutes: 0.4, headway_text: "高峰 20 分钟一班" }];
  return doc;
}

res = await call("/api/submissions", {
  method: "POST",
  ip: "10.0.0.11",
  body: { city: "快车城", kind: "new", summary: "新增快车服务", doc: expressDoc(["甲站", "丙站"]) },
});
ok(res.status === 201, "合法的快车服务数据可提交");

res = await call("/api/submissions", {
  method: "POST",
  ip: "10.0.0.12",
  body: { city: "快车城2", kind: "new", summary: "快车停靠站乱序", doc: expressDoc(["丙站", "甲站"]) },
});
ok(res.status === 400, "快车停靠站乱序会被服务端拒绝");

res = await call("/api/submissions", {
  method: "POST",
  ip: "10.0.0.13",
  body: {
    city: "快车城3",
    kind: "new",
    summary: "快车停靠站不存在",
    doc: (() => { const doc = cityDoc("快车城3"); doc.lines[0].express = [{ name: "快车", stops: ["甲站", "外星站"] }]; return doc; })(),
  },
});
ok(res.status === 400, "快车停靠站不在站表内会被拒绝");

// 管理员公告
res = await call("/api/announcements");
ok(res.status === 200 && res.body.announcements.length === 0, "公告列表初始为空且公开可读");

res = await call("/api/announcements", {
  method: "POST",
  body: { title: "匿名公告", body: "不应成功" },
});
ok(res.status === 401, "匿名用户不能发布公告");

res = await call("/api/announcements", {
  method: "POST",
  token: ADMIN_TOKEN,
  body: { title: "", body: "" },
});
ok(res.status === 400, "空公告会被拒绝");

res = await call("/api/announcements", {
  method: "POST",
  token: ADMIN_TOKEN,
  body: { title: "测试公告", body: "这是一条测试公告。\n第二行内容。", level: "important" },
});
ok(res.status === 201 && res.body.announcement?.id, "管理员可发布公告");
const announcementId = res.body.announcement.id;

res = await call("/api/announcements");
ok(
  res.status === 200
    && res.body.announcements.some((item) => item.id === announcementId && item.title === "测试公告" && item.level === "important"),
  "公告公开可读且保留级别",
);

res = await call(`/api/announcements/${announcementId}`, { method: "DELETE" });
ok(res.status === 401, "匿名用户不能删除公告");

res = await call(`/api/announcements/${announcementId}`, { method: "DELETE", token: ADMIN_TOKEN });
ok(res.status === 200 && res.body.removed, "管理员可删除公告");

res = await call("/api/announcements");
ok(res.body.announcements.length === 0, "删除后公告列表清空");

res = await call(`/api/announcements/${announcementId}`, { method: "DELETE", token: ADMIN_TOKEN });
ok(res.status === 404, "删除不存在的公告返回 404");

res = await call("/api/messages", {
  method: "POST",
  token: ADMIN_TOKEN,
  body: { title: "全站站信", body: "所有访客可见。" },
});
const broadcastMessageId = res.body.message?.id;
res = await call("/api/messages");
ok(
  res.body.messages.some((item) => item.id === broadcastMessageId && item.scope === "all"),
  "管理员发布的全站站信对所有访客可见",
);
await call(`/api/messages/${broadcastMessageId}`, { method: "DELETE", token: ADMIN_TOKEN });

const approvalInboxToken = "a".repeat(64);
res = await call("/api/submissions", {
  method: "POST",
  inboxToken: approvalInboxToken,
  ip: "10.0.0.31",
  body: {
    city: "站信通过城",
    kind: "new",
    summary: "增加站信收件测试城市",
    doc: cityDoc("站信通过城"),
  },
});
const approvedSubmissionId = res.body.id;
ok(res.status === 201 && approvedSubmissionId, "提交时可关联匿名浏览器收件凭证");

res = await call(`/api/submissions/${approvedSubmissionId}/approve`, { method: "POST", token: ADMIN_TOKEN });
ok(res.status === 200, "管理员通过提交");

res = await call("/api/messages", { inboxToken: approvalInboxToken });
ok(
  res.body.messages.some((item) => item.scope === "private" && item.title === "提交内容已通过"),
  "提交通过后向原浏览器发送私密站信",
);

res = await call("/api/messages", { inboxToken: "c".repeat(64) });
ok(
  !res.body.messages.some((item) => item.scope === "private"),
  "其他浏览器无法读取该用户的私密站信",
);

res = await call(`/api/submissions/${approvedSubmissionId}`);
ok(
  res.status === 200 && !("inboxRecipientHash" in res.body.submission),
  "匿名公开提交详情不泄露站信收件凭证",
);

const rejectionInboxToken = "b".repeat(64);
res = await call("/api/submissions", {
  method: "POST",
  inboxToken: rejectionInboxToken,
  ip: "10.0.0.32",
  body: {
    city: "站信驳回城",
    kind: "new",
    summary: "增加驳回通知测试城市",
    doc: cityDoc("站信驳回城"),
  },
});
const rejectedSubmissionId = res.body.id;
res = await call(`/api/submissions/${rejectedSubmissionId}/reject`, {
  method: "POST",
  token: ADMIN_TOKEN,
  body: { reason: "测试驳回原因" },
});
ok(res.status === 200, "管理员驳回提交");

res = await call("/api/messages", { inboxToken: rejectionInboxToken });
ok(
  res.body.messages.some((item) => item.scope === "private" && item.body.includes("测试驳回原因")),
  "驳回后向原浏览器发送包含原因的私密站信",
);

let scheduleNow = new Date("2026-03-01T10:00:00.000Z");
const scheduledApi = createApi({
  getStore: memoryStoreFactory(),
  adminToken: () => ADMIN_TOKEN,
  clock: () => new Date(scheduleNow),
});
async function callScheduled(path, { method = "GET", body, token = "" } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["x-admin-token"] = token;
  const response = await scheduledApi(new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}
const scheduledAt = "2026-03-01T10:05:00.000Z";
res = await callScheduled("/api/messages", {
  method: "POST",
  token: ADMIN_TOKEN,
  body: { title: "定时站信", body: "到时公开", scheduledAt },
});
const scheduledMessageId = res.body.message?.id;
ok(
  res.status === 201 && res.body.message?.status === "scheduled",
  "管理员可创建未来定时站信",
);

res = await callScheduled("/api/messages?includeScheduled=1");
ok(
  res.status === 200
    && res.body.messages.length === 0
    && res.body.nextPublicationAt === scheduledAt,
  "定时站信对匿名用户隐藏并返回下一发布时间",
);

res = await callScheduled("/api/messages?manage=1", { token: ADMIN_TOKEN });
ok(res.body.messages.length === 0, "管理员默认列表也隐藏定时站信");

res = await callScheduled("/api/messages?manage=1");
ok(res.status === 403, "匿名用户不能访问全站站信管理列表");

res = await callScheduled("/api/messages?manage=1&includeScheduled=1", { token: ADMIN_TOKEN });
ok(
  res.body.messages.some((item) => item.id === scheduledMessageId && item.status === "scheduled"),
  "管理员可查询未发布的定时站信",
);

res = await callScheduled("/api/messages", {
  method: "POST",
  token: ADMIN_TOKEN,
  body: { title: "过期站信", body: "无效", scheduledAt: "2026-03-01T09:59:00.000Z" },
});
ok(res.status === 400, "过去的发布时间会被拒绝");

res = await callScheduled("/api/messages", {
  method: "POST",
  token: ADMIN_TOKEN,
  body: { title: "无效站信", body: "无效", scheduledAt: "not-a-date" },
});
ok(res.status === 400, "无效的发布时间会被拒绝");

scheduleNow = new Date(scheduledAt);
res = await callScheduled("/api/messages");
ok(
  res.body.messages.some((item) => item.id === scheduledMessageId)
    && res.body.nextPublicationAt === "",
  "到达计划时间后定时站信自动公开",
);

let lastStatus = 0;
for (let i = 0; i < 9; i += 1) {
  const attempt = await call("/api/submissions", {
    method: "POST",
    ip: "10.0.0.99",
    body: { city: "限流城", kind: "new", summary: `限流测试第 ${i + 1} 次`, doc: cityDoc("限流城") },
  });
  lastStatus = attempt.status;
}
ok(lastStatus === 429, "同一 IP 短时间大量提交会被限流");

console.log(`\n全部 ${passed} 项服务端检查通过。`);
