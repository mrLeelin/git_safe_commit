import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { pathInsideRepo, runGit as runGitDefault } from "./git-executor.mjs";

const TextConflictExtensions = new Set([
  ".cs", ".asmdef", ".asmref", ".js", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".ps1", ".sh", ".bat", ".cmd",
  ".java", ".kt", ".cpp", ".h", ".hpp", ".c", ".go", ".rs", ".md", ".txt", ".json", ".jsonc", ".xml",
  ".yml", ".yaml", ".toml", ".ini", ".editorconfig", ".gitignore", ".gitattributes", ".shader", ".hlsl",
  ".cginc", ".compute", ".uss", ".uxml"
]);

export async function loadTextConflict({ repoPath, filePath, runGit = runGitDefault } = {}) {
  const relative = validateConflictPath(repoPath, filePath);
  assertTextConflict(relative);
  await assertUnmerged(repoPath, relative, runGit);
  const [base, ours, theirs] = await Promise.all([
    readGitStageText(repoPath, relative, 1, runGit),
    readGitStageText(repoPath, relative, 2, runGit),
    readGitStageText(repoPath, relative, 3, runGit)
  ]);
  let current = { available: true, content: "", error: "" };
  try {
    current.content = await readFile(path.resolve(repoPath, relative), "utf8");
  } catch (error) {
    current = { available: false, content: "", error: error.message || String(error) };
  }
  return { ok: true, textConflict: { path: relative, finalPath: relative, base, ours, theirs, current } };
}

export async function writeTextCandidate({ repoPath, filePath, content = "", source = "edited", lineChoices = [] } = {}) {
  const relative = validateConflictPath(repoPath, filePath);
  assertTextConflict(relative);
  const candidateRoot = path.join(repoPath, ".git", "git-safe-commit-backups", timestamp(), "text-merge-candidates");
  await mkdir(candidateRoot, { recursive: true });
  const ext = path.extname(relative);
  const baseName = path.basename(relative, ext).replace(/[^a-zA-Z0-9._-]/g, "_") || "merged";
  const outputPath = path.join(candidateRoot, `${baseName}.merged.${timestamp()}${ext || ".txt"}`);
  const choicePath = path.join(candidateRoot, `${baseName}.choices.${timestamp()}.json`);
  const choices = {
    path: relative,
    source: String(source || "edited"),
    lineChoices: Array.isArray(lineChoices) ? lineChoices : [],
    contentLength: String(content).length,
    finalPath: relative
  };
  await writeFile(outputPath, String(content), "utf8");
  await writeFile(choicePath, JSON.stringify(choices, null, 2), "utf8");
  return {
    ok: true,
    textCandidate: {
      path: relative,
      candidate: toRepoRelative(repoPath, outputPath),
      choices: toRepoRelative(repoPath, choicePath),
      finalPath: relative,
      source: choices.source
    }
  };
}

export async function exportBinaryConflict({ repoPath, filePath, runGit = runGitDefault } = {}) {
  const relative = validateConflictPath(repoPath, filePath);
  await assertUnmerged(repoPath, relative, runGit);
  const binaryRoot = path.join(repoPath, ".git", "git-safe-commit-backups", timestamp(), "binary-conflicts");
  await mkdir(binaryRoot, { recursive: true });
  const ext = path.extname(relative) || ".bin";
  const name = path.basename(relative);
  const basePath = path.join(binaryRoot, `${name}.base${ext}`);
  const oursPath = path.join(binaryRoot, `${name}.ours${ext}`);
  const theirsPath = path.join(binaryRoot, `${name}.theirs${ext}`);
  const [base, ours, theirs] = await Promise.all([
    readGitStageRaw(repoPath, relative, 1, runGit),
    readGitStageRaw(repoPath, relative, 2, runGit),
    readGitStageRaw(repoPath, relative, 3, runGit)
  ]);
  if (base.ok) await writeFile(basePath, base.stdout, "utf8");
  if (!ours.ok || !theirs.ok) {
    throw new Error(`binary conflict stages are unavailable: ${relative}`);
  }
  await writeFile(oursPath, ours.stdout, "utf8");
  await writeFile(theirsPath, theirs.stdout, "utf8");
  return {
    ok: true,
    binaryConflict: {
      path: relative,
      base: base.ok ? toRepoRelative(repoPath, basePath) : "",
      ours: toRepoRelative(repoPath, oursPath),
      theirs: toRepoRelative(repoPath, theirsPath),
      finalPath: relative
    }
  };
}

function validateConflictPath(repoPath, filePath) {
  if (!filePath || typeof filePath !== "string") throw new Error("conflict path is required");
  return pathInsideRepo(repoPath, filePath).relative;
}

function assertTextConflict(filePath) {
  const ext = path.extname(filePath);
  if (!TextConflictExtensions.has(ext) && !TextConflictExtensions.has(path.basename(filePath))) {
    throw new Error(`text conflict workbench does not support this file type: ${filePath}`);
  }
}

async function assertUnmerged(repoPath, filePath, runGit) {
  const result = await runGit(repoPath, ["ls-files", "-u", "--", filePath]);
  if (!result.ok || !result.stdout.trim()) {
    throw new Error(`no unmerged stages found for ${filePath}`);
  }
}

async function readGitStageText(repoPath, filePath, stage, runGit) {
  const result = await readGitStageRaw(repoPath, filePath, stage, runGit);
  return {
    stage,
    available: result.ok,
    content: result.ok ? result.stdout.toString("utf8") : "",
    byteLength: result.ok ? result.stdout.length : 0,
    error: result.ok ? "" : (result.stderr || result.error || `stage ${stage} is unavailable`)
  };
}

async function readGitStageRaw(repoPath, filePath, stage, runGit) {
  return runGit(repoPath, ["show", `:${stage}:${filePath}`], { encoding: "buffer" });
}

function toRepoRelative(repoPath, targetPath) {
  return path.relative(repoPath, targetPath).replaceAll("\\", "/");
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
