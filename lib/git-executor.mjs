import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { getLogger } from "./logger.mjs";

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
  "merge",
  "push",
  "rebase",
  "add",
  "restore",
  "stash",
  "checkout",
  "ls-files",
  "check-ignore",
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

export function summarizeGitInvocation(args) {
  const normalized = normalizeGitArgs(args);
  return {
    command: normalized[0] ? `git ${normalized[0]}` : "git",
    argCount: Math.max(0, normalized.length - 1)
  };
}

export async function runGit(repoPath, args, options = {}) {
  const cwd = validateRepoPath(repoPath);
  const gitArgs = validateGitArgs(args);
  const { traceId, ...processOptions } = options;

  const logger = getLogger();
  const invocation = summarizeGitInvocation(gitArgs);
  logger?.debug("git", traceId || "", invocation.command, { cwd, argCount: invocation.argCount });

  const result = await runProcess("git", gitArgs, {
    cwd,
    timeout: processOptions.timeout || 120000,
    maxBuffer: processOptions.maxBuffer || 1024 * 1024 * 30,
    encoding: processOptions.encoding,
    env: processOptions.env
  });

  const extra = {
    code: result.code,
    ok: result.ok,
    stdoutLen: (result.stdout || "").length,
    stderrLen: (result.stderr || "").length
  };
  logger?.debug("git", traceId || "", `→ exit:${result.code}`, extra);

  if (!result.ok) {
    logger?.warn("git", traceId || "", `git command failed: ${invocation.command}`, {
      code: result.code,
      stderrLen: (result.stderr || "").length,
      argCount: invocation.argCount
    });
  }

  return result;
}

export function runProcess(file, args, options = {}) {
  return new Promise((resolve) => {
    const timeout = options.timeout || 120000;
    const maxBuffer = options.maxBuffer || 1024 * 1024 * 30;
    let stdout = options.encoding === "buffer" ? Buffer.alloc(0) : "";
    let stderr = "";
    let settled = false;
    let child;
    let stdoutIdleTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(stdoutIdleTimer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child?.kill();
      finish({
        command: [file, ...args].join(" "),
        ok: false,
        code: 1,
        stdout,
        stderr,
        error: `process timed out after ${timeout}ms`
      });
    }, timeout);

    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      finish({
        command: [file, ...args].join(" "),
        ok: false,
        code: 1,
        stdout: "",
        stderr: "",
        error: error.message || String(error)
      });
      return;
    }

    if (options.encoding !== "buffer") child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = options.encoding === "buffer" ? Buffer.concat([stdout, chunk]) : stdout + chunk;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBuffer) child.kill();
      if (options.resolveOnStdoutIdleMs) {
        clearTimeout(stdoutIdleTimer);
        stdoutIdleTimer = setTimeout(() => {
          child.kill();
          finish({
            command: [file, ...args].join(" "),
            ok: true,
            code: 0,
            stdout,
            stderr,
            error: ""
          });
        }, options.resolveOnStdoutIdleMs);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stdout.length + stderr.length > maxBuffer) child.kill();
    });
    child.on("error", (error) => {
      finish({
        command: [file, ...args].join(" "),
        ok: false,
        code: 1,
        stdout,
        stderr,
        error: error.message || String(error)
      });
    });
    child.on("close", (code) => {
      finish({
        command: [file, ...args].join(" "),
        ok: code === 0,
        code: typeof code === "number" ? code : 1,
        stdout,
        stderr,
        error: code === 0 ? "" : `process exited with code ${code ?? 1}`
      });
    });

    if (options.input !== undefined) {
      child.stdin.end(String(options.input));
    } else {
      child.stdin.end();
    }
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
