import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

test("Vue UI 使用中文 dashboard 布局并保留 Git 安全功能", async () => {
  const app = await readFile(path.join(root, "src", "App.vue"), "utf8");
  const css = await readFile(path.join(root, "src", "styles.css"), "utf8");

  assert.match(app, /class="layout"/);
  assert.match(app, /class="side"/);
  assert.match(app, /Git 安全提交/);
  assert.match(app, /本地 Git 安全工作台/);
  assert.match(app, /风险摘要/);
  assert.match(app, /下一步建议/);
  assert.match(app, /恢复点/);
  assert.match(app, /阻断项/);
  assert.match(app, /Git 状态/);
  assert.match(app, /Git 提交树/);
  assert.match(app, /禁止 git pull/);
  assert.match(app, /禁止 reset --hard/);
  assert.match(css, /\.layout/);
  assert.match(css, /\.side-action/);
  assert.match(css, /\.metric/);
  assert.match(css, /\.panel/);
  assert.match(css, /\.git-graph-list/);
  assert.match(css, /\.commit-row/);
  assert.match(css, /\.commit-lanes/);

  assert.doesNotMatch(app, /余额|Token 使用趋势|模型分布|用户管理|渠道管理|订阅管理|Admin|Sub2API/);
  assert.doesNotMatch(app, /浣|鏈|绯|鐢|妯|涓|鈫|鐘|鎭|撳|鏌|€|�/);
});
