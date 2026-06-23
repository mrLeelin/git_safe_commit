import { accessSync, constants } from "node:fs";
import path from "node:path";

const KnownAiTools = [
  { id: "codex", label: "Codex", command: "codex" },
  { id: "claude", label: "Claude", command: "claude" },
  { id: "gemini", label: "Gemini", command: "gemini" }
];

const WindowsExtensions = [".exe", ".cmd", ".bat", ".ps1"];

export function detectInstalledAi(options = {}) {
  const platform = options.platform || process.platform;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const pathExt = options.pathExt ?? process.env.PATHEXT ?? "";
  const extensions = executableExtensions(platform, pathExt);

  return KnownAiTools
    .map((tool) => {
      const executablePath = findOnPath(tool.command, pathEnv, extensions, options.canAccess);
      return executablePath
        ? {
            ...tool,
            installed: true,
            source: executablePath
          }
        : null;
    })
    .filter(Boolean);
}

function findOnPath(command, pathEnv, extensions, canAccess = defaultCanAccess) {
  for (const directory of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (canAccess(candidate)) return candidate;
    }
  }
  return "";
}

function executableExtensions(platform, pathExt) {
  if (platform !== "win32") return [""];
  const fromEnv = pathExt
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
  return ["", ...new Set([...fromEnv, ...WindowsExtensions])];
}

function defaultCanAccess(candidate) {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
