#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const expectedGuardVersion = "2026-06-17.ensure-server-v1";
const __filename = fileURLToPath(import.meta.url);
const skillDir = path.resolve(path.dirname(__filename), "..");
const serverScript = path.join(skillDir, "scripts", "git-safe-commit-server.mjs");
const port = Number(process.env.GIT_SAFE_COMMIT_PORT || 17371);
const host = "127.0.0.1";
const baseUrl = `http://${host}:${port}`;

function run(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd: options.cwd || process.cwd(),
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeout || 10000
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
        stdout: stdout || "",
        stderr: stderr || "",
        error: error ? String(error.message || error) : ""
      });
    });
  });
}

async function findRepoRoot() {
  const result = await run("git", ["rev-parse", "--show-toplevel"]);
  if (!result.ok || !result.stdout.trim()) {
    throw new Error(`not inside a git repository: ${process.cwd()}`);
  }
  return normalizePath(result.stdout.trim());
}

function normalizePath(value) {
  return path.resolve(String(value || "")).replaceAll("\\", "/").toLowerCase();
}

function getJson(pathname, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`${baseUrl}${pathname}`, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve({ ok: res.statusCode === 200, statusCode: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (error) {
          resolve({ ok: false, statusCode: res.statusCode, error: error.message });
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("request timed out"));
    });
    req.on("error", (error) => {
      resolve({ ok: false, error: error.message });
    });
  });
}

async function listeningPid() {
  if (process.platform === "win32") {
    const ps = await run("powershell", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-Command",
      `$c = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { [string]$c.OwningProcess }`
    ]);
    const pid = Number(ps.stdout.trim());
    if (Number.isInteger(pid) && pid > 0) return pid;
  }

  const netstat = await run("netstat", ["-ano"]);
  const line = netstat.stdout.split(/\r?\n/).find((item) => item.includes(`127.0.0.1:${port}`) && item.toUpperCase().includes("LISTENING"));
  const pid = Number(line?.trim().split(/\s+/).at(-1));
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

async function stopProcess(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Fall through to taskkill on Windows.
  }
  await sleep(700);

  const stillListening = await listeningPid();
  if (stillListening !== pid) return true;

  if (process.platform === "win32") {
    const killed = await run("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 10000 });
    await sleep(500);
    return killed.ok;
  }
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

async function startServer(repoRoot) {
  const logDir = path.join(repoRoot, ".git", "git-safe-commit-backups");
  await mkdir(logDir, { recursive: true });
  const outFd = openSync(path.join(logDir, "observer-server.log"), "a");
  const errFd = openSync(path.join(logDir, "observer-server.err.log"), "a");
  const child = spawn(process.execPath, [serverScript], {
    cwd: repoRoot,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", outFd, errFd],
    env: {
      ...process.env,
      GIT_SAFE_COMMIT_PORT: String(port)
    }
  });
  child.unref();
  return child.pid;
}

async function waitForExpectedServer(repoRoot) {
  const expectedRepoRoot = normalizePath(repoRoot);
  const expectedSkillDir = normalizePath(skillDir);
  for (let i = 0; i < 30; i += 1) {
    const info = await getJson("/api/info", 1000);
    if (
      info.ok &&
      info.data?.ok &&
      info.data.guardVersion === expectedGuardVersion &&
      normalizePath(info.data.repoRoot) === expectedRepoRoot &&
      normalizePath(info.data.skillDir) === expectedSkillDir
    ) {
      return info.data;
    }
    await sleep(250);
  }
  throw new Error(`observer server did not become ready on ${baseUrl}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExpectedServer(info, repoRoot) {
  if (!info.ok || !info.data?.ok) return false;
  return (
    info.data.guardVersion === expectedGuardVersion &&
    normalizePath(info.data.repoRoot) === normalizePath(repoRoot) &&
    normalizePath(info.data.skillDir) === normalizePath(skillDir)
  );
}

function isOwnedGuardServer(info, repoRoot) {
  if (!info.ok || !info.data?.ok) return false;
  const sameRepo = normalizePath(info.data.repoRoot) === normalizePath(repoRoot);
  const sameSkill = normalizePath(info.data.skillDir) === normalizePath(skillDir);
  return sameRepo && sameSkill;
}

async function main() {
  const repoRoot = await findRepoRoot();
  const before = await getJson("/api/info");
  const actions = [];

  if (isExpectedServer(before, repoRoot)) {
    console.log(JSON.stringify({
      ok: true,
      action: "already-running",
      url: baseUrl,
      guardVersion: before.data.guardVersion,
      pid: before.data.pid,
      repoRoot: before.data.repoRoot
    }, null, 2));
    return;
  }

  const pid = await listeningPid();
  if (pid) {
    if (!isOwnedGuardServer(before, repoRoot)) {
      throw new Error(`port ${port} is already used by pid ${pid}, but it is not this repo's git-safe-commit guard`);
    }
    const stopped = await stopProcess(Number(before.data.pid || pid));
    actions.push({ action: "stop-old-server", pid: Number(before.data.pid || pid), ok: stopped });
    if (!stopped) {
      throw new Error(`failed to stop old observer server pid ${before.data.pid || pid}`);
    }
  }

  const startedPid = await startServer(repoRoot);
  actions.push({ action: "start-server", pid: startedPid });
  const ready = await waitForExpectedServer(repoRoot);

  console.log(JSON.stringify({
    ok: true,
    action: before.ok ? "updated-server" : "started-server",
    url: baseUrl,
    guardVersion: ready.guardVersion,
    pid: ready.pid,
    repoRoot: ready.repoRoot,
    actions
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    url: baseUrl
  }, null, 2));
  process.exitCode = 1;
});
