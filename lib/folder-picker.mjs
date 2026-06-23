import { runProcess } from "./git-executor.mjs";

const WindowsFolderDialogScript = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择 Git 仓库文件夹'
$dialog.ShowNewFolderButton = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
`.trim();

export async function pickFolder({ runProcessImpl = runProcess } = {}) {
  if (process.platform !== "win32") {
    throw new Error("folder picker is only supported on Windows");
  }

  const result = await runProcessImpl("powershell.exe", [
    "-NoProfile",
    "-STA",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    WindowsFolderDialogScript
  ], {
    timeout: 120000,
    maxBuffer: 1024 * 128
  });

  if (!result.ok) {
    throw new Error(result.stderr || result.error || "folder picker failed");
  }

  const path = parseSelectedFolderPath(result.stdout);
  return {
    ok: true,
    cancelled: !path,
    path
  };
}

export function parseSelectedFolderPath(stdout = "") {
  return String(stdout || "").trim();
}
