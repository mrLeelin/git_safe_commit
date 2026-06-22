import { $ } from "../dom.mjs";
import { bindBackdropClose, closeModal, openModal } from "./modal.mjs";

let outputText = "等待操作。";
let outputTitle = "查看结果";

export function openResultViewer() {
  $("#viewerTitle").textContent = outputTitle;
  $("#viewerBody").textContent = outputText;
  openModal("#viewerBackdrop");
}

export function closeResultViewer() {
  closeModal("#viewerBackdrop");
}

export function setOutput(value, title = "查看结果", openViewer = true) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  outputText = text;
  outputTitle = title;
  $("#viewerTitle").textContent = outputTitle;
  $("#viewerBody").textContent = outputText;
  if (openViewer) {
    openResultViewer();
  }
}

export function appendOutput(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  outputText = outputText && outputText !== "等待操作。"
    ? `${outputText.trimEnd()}\n\n${text}`
    : text;
  if ($("#viewerBackdrop").classList.contains("open")) {
    $("#viewerBody").textContent = outputText;
  }
}

export function bindOutputViewer() {
  $("#closeViewerBtn").onclick = closeResultViewer;
  bindBackdropClose("#viewerBackdrop", closeResultViewer);
  $("#copyViewerBtn").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("#viewerBody").textContent);
      $("#copyViewerBtn").textContent = "已复制";
      setTimeout(() => { $("#copyViewerBtn").textContent = "复制"; }, 900);
    } catch (error) {
      appendOutput(`复制失败：${error.message}`);
    }
  };
}
