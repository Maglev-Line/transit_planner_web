/**
 * 构建纯静态站点到 dist/（Netlify 的 publish 目录）。
 *
 * 只把浏览器真正需要的文件放进 dist，避免把 node_modules、tools、netlify
 * 函数源码等一起当作静态资源发布。
 *
 * 用法：node tools/build_site.mjs
 */
import { cp, mkdir, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");

const FILES = ["index.html", "editor.html", "review.html", "styles.css", "editor.css", "review.css"];
const DIRS = ["js", "py", "assets"];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

for (const file of FILES) {
  await cp(join(ROOT, file), join(DIST, file));
}

for (const dir of DIRS) {
  const source = join(ROOT, dir);
  if (!(await exists(source))) continue;
  await cp(source, join(DIST, dir), {
    recursive: true,
    filter: (path) => !path.includes("__pycache__") && !path.endsWith(".pyc"),
  });
}

console.log(`静态站点已构建到 ${DIST}`);
