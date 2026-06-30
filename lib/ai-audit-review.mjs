import { existsSync } from "node:fs";
import { readFile as readFileDefault } from "node:fs/promises";

import { detectInstalledAi as detectInstalledAiDefault } from "./ai-installations.mjs";
import { pathInsideRepo, runGit as runGitDefault, runProcess as runProcessDefault } from "./git-executor.mjs";

const MaxDiffChars = 20000;
const AiCommands = {
  codex: () => ["codex", ["--ask-for-approval", "never", "exec", "--sandbox", "read-only", "-"]],
  claude: () => ["claude", ["--print"]],
  gemini: () => ["gemini", ["--prompt", ""]]
};

export async function reviewAuditWithAi(options = {}) {
  const {
    config,
    paths = [],
    risks = [],
    detectInstalledAi = detectInstalledAiDefault,
    runGit = runGitDefault,
    runProcess = runProcessDefault,
    readFile = readFileDefault,
    fileExists = existsSync
  } = options;

  const selected = config?.ai?.selected || config?.ai?.activeProvider || "codex";
  const normalizedPaths = [...new Set((Array.isArray(paths) ? paths : []).map(String).filter(Boolean))];
  if (!normalizedPaths.length) {
    throw new Error("没有可供 AI 审查的文件。请先检查仓库状态。");
  }

  for (const filePath of normalizedPaths) pathInsideRepo(config.repoPath, filePath);

  const installations = detectInstalledAi();
  const selectedAi = installations.find((item) => item.id === selected);
  if (!selectedAi) {
    throw new Error(`未检测到已选择的 AI：${selected}。请先在系统设置中选择一个本机已安装的 AI。`);
  }

  const diffScope = options.diffScope === "combined" ? "combined" : "staged";
  const diff = await readReviewDiff({ repoPath: config.repoPath, paths: normalizedPaths, runGit, readFile, diffScope });
  if (!diff.trim()) {
    throw new Error(diffScope === "combined"
      ? "当前选择的文件没有可审查 diff。"
      : "当前选择的文件没有暂存 diff，无法审查已解决结果。");
  }

  const prompt = buildAuditPrompt({ diff, paths: normalizedPaths, risks, diffScope });
  const [file, args] = AiCommands[selected]?.() || [];
  if (!file) throw new Error(`不支持的 AI：${selected}`);

  const command = resolveCommand(selectedAi, file, args, { fileExists });
  const result = await runProcessSafe(runProcess, command.file, command.args, {
    cwd: config.repoPath,
    input: prompt,
    resolveOnStdoutIdleMs: selected === "codex" ? 1600 : 0,
    timeout: 180000,
    maxBuffer: 1024 * 1024 * 10
  });
  const review = cleanReview(result.stdout);
  if (!result.ok && !review) {
    const detail = formatFailure(result.stderr || result.stdout || result.error || `exit ${result.code}`);
    throw new Error(`AI 审查失败：${detail}`);
  }

  return { ok: true, review, paths: normalizedPaths };
}

async function readReviewDiff({ repoPath, paths, runGit, readFile, diffScope }) {
  const diff = await runGit(repoPath, ["diff", "--cached", "--", ...paths]);
  if (!diff.ok) {
    const detail = formatFailure(diff.stderr || diff.stdout || diff.error || "git diff failed");
    throw new Error(`读取暂存 diff 失败：${detail}`);
  }
  if (diffScope !== "combined") return diff.stdout || "";

  const unstaged = await runGit(repoPath, ["diff", "--", ...paths]);
  const untracked = await runGit(repoPath, ["ls-files", "--others", "--exclude-standard", "--", ...paths]);
  const failed = [unstaged, untracked].find((result) => result.ok === false);
  if (failed) {
    const detail = formatFailure(failed.stderr || failed.stdout || failed.error || "git diff failed");
    throw new Error(`读取所选文件 diff 失败：${detail}`);
  }
  const untrackedDiff = await readUntrackedDiffs({ repoPath, paths: splitLines(untracked.stdout), readFile });
  return [
    diff.stdout && `--- staged ---\n${diff.stdout}`,
    unstaged.stdout && `--- unstaged ---\n${unstaged.stdout}`,
    untrackedDiff && `--- untracked ---\n${untrackedDiff}`
  ].filter(Boolean).join("\n\n");
}

async function readUntrackedDiffs({ repoPath, paths, readFile }) {
  const previews = [];
  for (const filePath of paths) {
    const target = pathInsideRepo(repoPath, filePath);
    const content = await readFile(target.fullPath, "utf8");
    previews.push(untrackedDiffPreview(target.relative, content));
  }
  return previews.join("\n\n");
}

function untrackedDiffPreview(relativePath, content) {
  const body = String(content || "")
    .split(/\r?\n/)
    .map((line) => `+${line}`)
    .join("\n");
  return `diff --git a/${relativePath} b/${relativePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relativePath}\n${body}`;
}

function splitLines(text) {
  return text ? text.split(/\r?\n/).filter(Boolean) : [];
}

function buildAuditPrompt({ diff, paths, risks, diffScope }) {
  const truncatedDiff = diff.length > MaxDiffChars ? `${diff.slice(0, MaxDiffChars)}\n\n[diff truncated]` : diff;
  const riskSummary = (Array.isArray(risks) ? risks : [])
    .map((risk) => `${risk.path}: ${(risk.labels || []).join(", ") || "risk"}`)
    .join("\n");

  return [
    "你是严格的 Git 冲突解决审查助手。",
    diffScope === "combined"
      ? "只审查下面这些所选文件 diff，不要假设未出现在 diff 里的代码。"
      : "只审查下面这些暂存 diff，不要假设未出现在 diff 里的代码。",
    diffScope === "combined"
      ? "目标是帮用户判断当前所选文件是否存在明显错误、不合理改动或提交风险。"
      : "目标是帮用户判断当前已解决冲突的暂存结果是否明显可继续 rebase。",
    "重点看：是否误删逻辑、是否把 ours/theirs 选反、表格/CSV 行列是否明显错位、是否残留冲突标记、是否有可疑配置或二进制内容变化。",
    "不要替用户做最终确认；只能给建议。",
    "输出中文，格式固定：",
    "结论：通过 / 需要人工复查 / 不建议继续",
    "关注点：",
    "- ...",
    "建议：",
    "- ...",
    "如果没有明显问题，也要说明“AI 未发现明显问题，但仍需人工确认业务含义”。",
    "总长度控制在 12 行以内。",
    "",
    "文件：",
    paths.join("\n"),
    "",
    "风险标签：",
    riskSummary || "无",
    "",
    diffScope === "combined" ? "所选文件 diff：" : "暂存 diff：",
    truncatedDiff
  ].join("\n");
}

async function runProcessSafe(runProcess, file, args, options) {
  try {
    return await runProcess(file, args, options);
  } catch (error) {
    return {
      ok: false,
      code: 1,
      stdout: "",
      stderr: "",
      error: error.message || String(error)
    };
  }
}

function resolveCommand(selectedAi, file, args, { fileExists = existsSync } = {}) {
  const source = selectedAi.source || "";
  if (process.platform === "win32" && source && !/\.(cmd|bat|ps1|exe)$/i.test(source)) {
    const cmdShim = `${source}.cmd`;
    if (fileExists(cmdShim)) return { file: "cmd.exe", args: ["/d", "/s", "/c", cmdShim, ...args] };
    const psShim = `${source}.ps1`;
    if (fileExists(psShim)) return powershellShim(psShim, args);
  }
  if (/\.ps1$/i.test(source)) return powershellShim(source, args);
  return { file: source || selectedAi.command || file, args };
}

function powershellShim(source, args) {
  return {
    file: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", source, ...args]
  };
}

function cleanReview(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n")
    .trim();
}

function formatFailure(value) {
  const line = String(value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean) || "未知错误";
  return line.length > 180 ? `${line.slice(0, 180)}...` : line;
}
