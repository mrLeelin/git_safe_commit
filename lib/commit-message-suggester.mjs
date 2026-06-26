import { detectInstalledAi as detectInstalledAiDefault } from "./ai-installations.mjs";
import { pathInsideRepo, runGit as runGitDefault, runProcess as runProcessDefault } from "./git-executor.mjs";
import { existsSync } from "node:fs";
import { readFile as readFileDefault } from "node:fs/promises";

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
    readFile = readFileDefault,
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

  const combinedDiff = await readCombinedDiff({ repoPath: config.repoPath, paths: normalizedPaths, runGit, readFile });
  if (!combinedDiff.trim()) {
    throw new Error("选中的文件没有可用于生成提交说明的变更。请先确认仓库路径正确，并选择有变更的文件。");
  }

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

async function readCombinedDiff({ repoPath, paths, runGit, readFile }) {
  const stagedResult = await runGit(repoPath, ["diff", "--cached", "--", ...paths]);
  const unstagedResult = await runGit(repoPath, ["diff", "--", ...paths]);
  const untrackedResult = await runGit(repoPath, ["ls-files", "--others", "--exclude-standard", "--", ...paths]);
  const failed = [stagedResult, unstagedResult, untrackedResult].find((result) => result.ok === false);
  if (failed) {
    const detail = formatFailure(failed.stderr || failed.stdout || failed.error || "git diff failed");
    throw new Error(`读取选中文件 diff 失败：${detail}`);
  }
  const untrackedDiff = await readUntrackedDiffs({ repoPath, paths: splitLines(untrackedResult.stdout), readFile });
  return [
    stagedResult.stdout && `--- staged ---\n${stagedResult.stdout}`,
    unstagedResult.stdout && `--- unstaged ---\n${unstagedResult.stdout}`,
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

function buildPrompt(diff) {
  const truncatedDiff = diff.length > MaxDiffChars ? `${diff.slice(0, MaxDiffChars)}\n\n[diff truncated]` : diff;
  return [
    "你是严格的 Git 提交说明生成器。",
    "只分析这些已选择文件的 diff，不要推断未出现在 diff 里的仓库改动。",
    "先在内部完成分析：识别用户意图、行为变化、测试/配置/样式/资源影响，以及是否只是重构或维护。",
    "最终只输出提交说明文本，不要输出分析过程、解释、Markdown、引号或列表。",
    "提交说明格式必须是一个或多个分类前缀，后面接空格、两个短横线、空格和中文描述。",
    "允许的分类前缀只有：[FixBug]、[Feature]、[Assets]、[Refactor]、[Docs]、[Test]、[Config]、[Style]、[Chore]。",
    "如果一个分类有多个事项，第一行写分类前缀，后续行只写缩进后的 -- 描述。",
    "如果一个事项同时属于多个分类，可以在同一行连续写多个前缀。",
    "示例：",
    "[FixBug] -- 修复提交按钮无法提交",
    "         -- 补充直接提交回归测试",
    "[Feature] -- 增加日志视图",
    "[FixBug] [Assets] -- 修复资源加载异常",
    "分类选择规则：修复错误用 [FixBug]；新增能力用 [Feature]；图片、音频、字体、样式资源用 [Assets]；重构用 [Refactor]；文档用 [Docs]；测试用 [Test]；配置用 [Config]；纯样式布局用 [Style]；杂项维护用 [Chore]。",
    "按提交目的归并，不要按文件逐条罗列；多个文件服务同一目的时合并为一条描述。",
    "优先说明用户可感知的行为变化，其次说明安全边界、数据流或测试覆盖变化；避免复述函数名、变量名和机械实现细节。",
    "无法从 diff 判断目的时，使用保守描述，不要编造业务背景。",
    "描述要短，说明做了什么；如果 diff 同时包含多类改动，按主要目的分组输出，不要超过 4 行。",
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
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => line.trim());
  const firstTaggedLine = lines.findIndex((line) => /^\[[A-Za-z]+]/.test(line.trim()));
  if (firstTaggedLine !== -1) {
    const messageLines = [];
    for (const line of lines.slice(firstTaggedLine)) {
      const trimmed = line.trim();
      if (/^(\[[A-Za-z]+]\s*)+\s*--\s+\S/.test(trimmed)) {
        messageLines.push(trimmed);
        continue;
      }
      if (/^--\s+\S/.test(trimmed)) {
        messageLines.push(line);
        continue;
      }
      break;
    }
    if (messageLines.length) return stripQuotes(alignContinuationMarkers(messageLines).join("\n"));
  }
  return stripQuotes(lines.at(-1) || "");
}

function alignContinuationMarkers(lines) {
  let continuationIndent = "";
  return lines.map((line) => {
    const trimmed = line.trim();
    const taggedMatch = trimmed.match(/^((?:\[[A-Za-z]+]\s*)+)--\s+\S/);
    if (taggedMatch) {
      continuationIndent = " ".repeat(taggedMatch[1].length);
      return trimmed;
    }
    if (/^--\s+\S/.test(trimmed)) {
      return `${continuationIndent}${trimmed}`;
    }
    return line;
  });
}

function stripQuotes(value) {
  return String(value || "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
}

function formatFailure(value) {
  const line = String(value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean) || "未知错误";
  return line.length > 180 ? `${line.slice(0, 180)}...` : line;
}
