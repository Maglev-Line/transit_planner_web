/**
 * 服务端审核接口测试（不需要 Netlify 账号）。
 *
 * 用内存存储替换 Netlify Blobs，直接跑 netlify/lib/api-core.mjs 的完整路由：
 * 匿名提交 → 公开记录 → 管理员审核 → 全站生效 → 回滚 → 驳回 / 隐藏 / 限流。
 *
 * 用法：node tools/test_server.mjs
 */
import assert from "node:assert/strict";

import { createApi } from "../netlify/lib/api-core.mjs";

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

async function call(path, { method = "GET", body, token = "", ip = "10.0.0.1" } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["x-admin-token"] = token;
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
