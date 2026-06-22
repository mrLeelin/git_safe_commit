import { execFile } from "node:child_process";
import path from "node:path";

const ForbiddenPatterns = [
  /^pull$/,
  /^clean(?:\s|$)/,
  /^clean$/,
  /^reset\s+--hard$/,
  /^stash\s+pop$/,
  /^push\s+.*(?:--force|-f)(?:\s|$)/
];

const AllowedFirstArgs = new Set([
  "status",
  "rev-parse",
  "rev-list",
  "branch",
  "log",
  "diff",
  "fetch",
  "push",
  "rebase",
  "add",
  "restore",
  "stash",
  "checkout",
  "ls-files",
  "grep",
  "apply",
  "show",
  "show-ref",
  "commit"
]);

export function normalizeGitArgs(args) {
  if (!Array.isArray(args)) {
    throw new Error("git args must be an array");
  }
  return args.map((item) => String(item));
}

export function validateGitArgs(args) {
  const normalized = normalizeGitArgs(args);
  if (!normalized.length) {
    throw new Error("git args are required");
  }

  const joined = normalized.join(" ");
  for (const pattern of ForbiddenPatterns) {
    if (pattern.test(joined)) {
      throw new Error(`forbidden git command: git ${joined}`);
    }
  }

  const first = normalized[0];
  if (!AllowedFirstArgs.has(first)) {
    throw new Error(`git command is not allowlisted: git ${joined}`);
  }

  if (normalized.some((part) => part.includes("\0"))) {
    throw new Error("git args contain invalid NUL byte");
  }

  return normalized;
}

export function validateRepoPath(repoPath) {
  if (!path.isAbsolute(String(repoPath || ""))) {
    throw new Error(`repoPath must be absolute: ${repoPath}`);
  }
  return path.resolve(repoPath);
}

export async function runGit(repoPath, args, options = {}) {
  const cwd = validateRepoPath(repoPath);
  const gitArgs = validateGitArgs(args);
  return runProcess("git", gitArgs, {
    cwd,
    timeout: options.timeout || 120000,
    maxBuffer: options.maxBuffer || 1024 * 1024 * 30
  });
}

export function runProcess(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd: options.cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeout || 120000,
      maxBuffer: options.maxBuffer || 1024 * 1024 * 30
    }, (error, stdout, stderr) => {
      const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
      resolve({
        command: [file, ...args].join(" "),
        ok: code === 0,
        code,
        stdout: stdout || "",
        stderr: stderr || "",
        error: error?.message || ""
      });
    });
  });
}

export function pathInsideRepo(repoPath, filePath) {
  const root = validateRepoPath(repoPath);
  const fullPath = path.resolve(root, filePath);
  const relative = path.relative(root, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path is outside repo: ${filePath}`);
  }
  return { root, fullPath, relative: relative.replaceAll("\\", "/") };
}
