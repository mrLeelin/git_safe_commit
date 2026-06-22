import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

test("Vue UI keeps Chinese Git-safe dashboard and desktop-like graph structure", async () => {
  const app = await readFile(path.join(root, "src", "App.vue"), "utf8");
  const css = await readFile(path.join(root, "src", "styles.css"), "utf8");

  assert.match(app, /const zh = \{/);
  assert.match(app, /title: "\\u0047\\u0069\\u0074 \\u5b89\\u5168\\u63d0\\u4ea4"/);
  assert.match(app, /graph: "\\u0047\\u0069\\u0074 \\u63d0\\u4ea4\\u6811"/);
  assert.match(app, /risk: "\\u98ce\\u9669\\u6458\\u8981"/);
  assert.match(app, /next: "\\u4e0b\\u4e00\\u6b65\\u5efa\\u8bae"/);
  assert.match(app, /forbidPull: "\\u7981\\u6b62 git pull"/);
  assert.match(app, /forbidReset: "\\u7981\\u6b62 reset --hard"/);

  assert.match(app, /class="layout"/);
  assert.match(app, /class="side"/);
  assert.match(app, /class="git-graph-list"/);
  assert.match(app, /class="graph-titlebar"/);
  assert.match(app, /class="graph-branchbar"/);
  assert.match(app, /class="graph-sidebar"/);
  assert.match(app, /class="commit-row"/);
  assert.match(app, /class="commit-lanes"/);
  assert.match(css, /\.git-graph-list/);
  assert.match(css, /\.graph-titlebar/);
  assert.match(css, /\.graph-branchbar/);
  assert.match(css, /\.graph-sidebar/);
  assert.match(css, /\.commit-row/);
  assert.match(css, /\.commit-lanes/);

  assert.doesNotMatch(app, /Sub2API|Admin|Token \u4f7f\u7528\u8d8b\u52bf|\u6a21\u578b\u5206\u5e03|\u7528\u6237\u7ba1\u7406|\u6e20\u9053\u7ba1\u7406|\u8ba2\u9605\u7ba1\u7406/);
  assert.doesNotMatch(`${app}\n${css}`, /浣|鏈|绯|鐢|妯|涓|鈫|鐘|鎭|撳|鏌|鐣|绂|锛|�/);
});
