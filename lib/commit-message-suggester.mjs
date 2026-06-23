import { detectInstalledAi as detectInstalledAiDefault } from "./ai-installations.mjs";
import { pathInsideRepo, runGit as runGitDefault, runProcess as runProcessDefault } from "./git-executor.mjs";
import { existsSync } from "node:fs";

const MaxDiffChars = 12000;
const AiCommands = {
  codex: () => ["codex", ["--ask-for-approval", "never", "exec", "--sandbox", "read-only", "-"]],
  claude: () => ["claude", ["--print"]],
  gemini: () => ["gemini", ["--prompt", ""]]
};

export async function suggestCommitMessage(options = {}) {
  const {
    config,
    paths = [],
    detectInstalledAi = detectInstalledAiDefault,
    runGit = runGitDefault,
    runProcess = runProcessDefault,
    fileExists = existsSync
  } = options;

  const selected = config?.ai?.selected || config?.ai?.activeProvider || "codex";
  const normalizedPaths = Array.isArray(paths) ? paths.map(String).filter(Boolean) : [];
  if (!normalizedPaths.length) return { ok: true, message: "" };

  for (const filePath of normalizedPaths) {
    pathInsideRepo(config.repoPath, filePath);
  }

  const installations = detectInstalledAi();
  const selectedAi = installations.find((item) => item.id === selected);
  if (!selectedAi) {
    throw new Error(`未检测到已选择的 AI：${selected}。请先在系统设置中选择一个本机已安装的 AI。`);
  }

  const combinedDiff = await readCombinedDiff({ repoPath: config.repoPath, paths: normalizedPaths, runGit });
  if (!combinedDiff.trim()) return { ok: true, message: "" };

  const prompt = buildPrompt(combinedDiff);
  const [file, args] = AiCommands[selected]?.() || [];
  if (!file) {
    throw new Error(`不支持的 AI：${selected}`);
  }

  const command = resolveCommand(selectedAi, file, args, { fileExists });
  const result = await runProcessSafe(runProcess, command.file, command.args, {
    cwd: config.repoPath,
    input: prompt,
    resolveOnStdoutIdleMs: selected === "codex" ? 1200 : 0,
    timeout: 180000,
    maxBuffer: 1024 * 1024 * 10
  });
  if (!result.ok) {
    const partialMessage = cleanMessage(result.stdout);
    if (partialMessage) return { ok: true, message: partialMessage };
    const detail = formatFailure(result.stderr || result.stdout || result.error || `exit ${result.code}`);
    throw new Error(`AI 生成提交说明失败：${detail}`);
  }

  return { ok: true, message: cleanMessage(result.stdout) };
}

async function readCombinedDiff({ repoPath, paths, runGit }) {
  const stagedResult = await runGit(repoPath, ["diff", "--cached", "--", ...paths]);
  const unstagedResult = await runGit(repoPath, ["diff", "--", ...paths]);
  return [
    stagedResult.stdout && `--- staged ---\n${stagedResult.stdout}`,
    unstagedResult.stdout && `--- unstaged ---\n${unstagedResult.stdout}`
  ].filter(Boolean).join("\n\n");
}

function buildPrompt(diff) {
  const truncatedDiff = diff.length > MaxDiffChars ? `${diff.slice(0, MaxDiffChars)}\n\n[diff truncated]` : diff;
  return [
    "你是 Git 提交说明生成器。",
    "根据下面的 git diff，用中文写一句简洁的提交说明。",
    "只输出提交说明文本，不要输出解释、Markdown、引号或列表。",
    "长度不超过 72 个中文字符。",
    "",
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
  if (/\.ps1$/i.test(source)) {
    return powershellShim(source, args);
  }
  return { file: source || selectedAi.command || file, args };
}

function powershellShim(source, args) {
  return {
    file: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", source, ...args]
  };
}

function cleanMessage(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
    ?.replace(/^["'`]+|["'`]+$/g, "")
    .trim() || "";
}

function formatFailure(value) {
  const line = String(value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean) || "未知错误";
  return line.length > 180 ? `${line.slice(0, 180)}...` : line;
}
