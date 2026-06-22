import { setOutput } from "../components/output-viewer.mjs";

export function createScriptWorkbench() {
  function openForBlocker(blocker) {
    setOutput(
      [
        "脚本工作台尚未接入具体解析器。",
        "",
        "阻断项：",
        blocker
      ].join("\n"),
      "脚本工作台"
    );
  }

  return { openForBlocker };
}
