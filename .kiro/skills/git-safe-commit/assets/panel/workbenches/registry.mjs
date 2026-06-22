const Boundary = String.raw`[\s:;"'<>，。；：、]+`;
const XlsxPattern = new RegExp(String.raw`(?:^|${Boundary})([^\s:;"'<>，。；：、]+\.xlsx)(?=$|${Boundary})`, "i");
const ScriptPattern = new RegExp(String.raw`(?:^|${Boundary})([^\s:;"'<>，。；：、]+\.(?:mjs|js|cjs|py|ps1|bat|cmd|sh))(?=$|${Boundary})`, "i");
const TextPattern = new RegExp(String.raw`(?:^|${Boundary})([^\s:;"'<>，。；：、]+\.(?:cs|asmdef|asmref|ts|tsx|cjs|java|kt|cpp|h|hpp|c|go|rs|md|txt|json|jsonc|xml|yml|yaml|toml|ini|editorconfig|gitignore|gitattributes|shader|hlsl|cginc|compute|uss|uxml))(?=$|${Boundary})`, "i");

export function createWorkbenchRegistry({ view, excelWorkbench, scriptWorkbench, textWorkbench }) {
  function normalizePath(value) {
    return String(value || "").replaceAll("\\", "/");
  }

  function isUnmergedPath(filePath) {
    const normalized = normalizePath(filePath);
    return (view.status?.unmerged || []).some((item) => normalizePath(item) === normalized);
  }

  function resolve(blocker) {
    const normalized = normalizePath(blocker);
    const xlsxPath = normalized.match(XlsxPattern)?.[1] || "";
    if (xlsxPath) {
      return {
        label: "打开表格冲突合并",
        open: () => excelWorkbench.openExcelWorkbenchForPath(xlsxPath, null)
      };
    }

    const scriptPath = normalized.match(ScriptPattern)?.[1] || "";
    if (scriptPath && isUnmergedPath(scriptPath)) {
      return {
        label: "打开脚本冲突合并",
        open: () => textWorkbench.openTextWorkbenchForPath(scriptPath)
      };
    }

    const textPath = normalized.match(TextPattern)?.[1] || "";
    if (textPath && isUnmergedPath(textPath)) {
      return {
        label: "打开文本冲突合并",
        open: () => textWorkbench.openTextWorkbenchForPath(textPath)
      };
    }

    return null;
  }

  return { resolve };
}
