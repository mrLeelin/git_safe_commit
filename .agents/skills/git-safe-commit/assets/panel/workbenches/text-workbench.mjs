import { request } from "../api.mjs";
import { $, escapeHtml } from "../dom.mjs";
import { setOutput } from "../components/output-viewer.mjs";

export function createTextWorkbench({ view, formatResults, openTextModal, refreshAll }) {
  const Sources = ["current", "base", "ours", "theirs"];
  const MergeChoices = ["ours", "theirs", "both", "none"];

  function sourceLabel(source) {
    return {
      current: "当前冲突文件",
      ours: "本分支",
      theirs: "合入分支",
      base: "共同祖先",
      both: "两边都保留",
      none: "清空",
      edited: "手动编辑",
      line: "按行选择"
    }[source] || source;
  }

  function sourceDescription(source) {
    return {
      current: "Git 当前写在工作区的冲突文件，通常包含 <<<<<<< / ======= / >>>>>>> 标记。",
      base: "两边改动开始分叉前的共同版本，用来判断谁改了什么。",
      ours: "当前检出的本分支版本，也就是合并时的 OURS。",
      theirs: "正在合入的来源分支版本，也就是合并时的 THEIRS。"
    }[source] || "";
  }

  function getSourceContent(source) {
    const conflict = view.text;
    if (!conflict) return "";
    return conflict[source]?.content || "";
  }

  function splitLines(content) {
    const text = String(content || "");
    const lines = text.split(/\r?\n/);
    if (lines.length > 1 && lines.at(-1) === "") {
      lines.pop();
    }
    return lines;
  }

  function lcsPairs(left, right) {
    const dp = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
    for (let i = left.length - 1; i >= 0; i--) {
      for (let j = right.length - 1; j >= 0; j--) {
        dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const pairs = [];
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) {
      if (left[i] === right[j]) {
        pairs.push([i, j]);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        i++;
      } else {
        j++;
      }
    }
    return pairs;
  }

  function buildLineRows(oursText, theirsText) {
    const ours = splitLines(oursText);
    const theirs = splitLines(theirsText);
    const pairs = lcsPairs(ours, theirs);
    const rows = [];
    let left = 0;
    let right = 0;

    function pushChanged(untilLeft, untilRight) {
      const leftBlock = ours.slice(left, untilLeft);
      const rightBlock = theirs.slice(right, untilRight);
      const count = Math.max(leftBlock.length, rightBlock.length);
      for (let offset = 0; offset < count; offset++) {
        const oursLine = leftBlock[offset] ?? "";
        const theirsLine = rightBlock[offset] ?? "";
        rows.push({
          id: rows.length,
          kind: "changed",
          oursLineNumber: offset < leftBlock.length ? left + offset + 1 : "",
          theirsLineNumber: offset < rightBlock.length ? right + offset + 1 : "",
          ours: oursLine,
          theirs: theirsLine,
          choice: oursLine && theirsLine && oursLine !== theirsLine ? "both" : oursLine ? "ours" : "theirs"
        });
      }
    }

    for (const [nextLeft, nextRight] of pairs) {
      pushChanged(nextLeft, nextRight);
      rows.push({
        id: rows.length,
        kind: "same",
        oursLineNumber: nextLeft + 1,
        theirsLineNumber: nextRight + 1,
        ours: ours[nextLeft],
        theirs: theirs[nextRight],
        choice: "both"
      });
      left = nextLeft + 1;
      right = nextRight + 1;
    }

    pushChanged(ours.length, theirs.length);
    return rows;
  }

  function ensureLineMergeRows() {
    if (!view.text) return [];
    if (!Array.isArray(view.textLineRows)) {
      view.textLineRows = buildLineRows(getSourceContent("ours"), getSourceContent("theirs"));
    }
    return view.textLineRows;
  }

  function rowContent(row) {
    if (row.kind === "same") return [row.ours];
    if (row.choice === "ours") return row.ours ? [row.ours] : [];
    if (row.choice === "theirs") return row.theirs ? [row.theirs] : [];
    if (row.choice === "both") {
      const result = [];
      if (row.ours) result.push(row.ours);
      if (row.theirs && row.theirs !== row.ours) result.push(row.theirs);
      return result;
    }
    return [];
  }

  function composeLineDraft() {
    return ensureLineMergeRows().flatMap(rowContent).join("\n");
  }

  function lineChoiceSummary() {
    return ensureLineMergeRows()
      .filter((row) => row.kind === "changed")
      .map((row) => ({
        row: row.id,
        oursLine: row.oursLineNumber,
        theirsLine: row.theirsLineNumber,
        choice: row.choice,
        ours: row.ours,
        theirs: row.theirs
      }));
  }

  function syncDraftFromRows() {
    view.textDraftSource = "line";
    view.textDraft = composeLineDraft();
  }

  function setDraftFromSource(source) {
    view.textDraftSource = source;
    view.textDraft = getSourceContent(source);
    renderTextWorkbench();
  }

  function setAllRows(choice) {
    const scrollState = captureTextScrollState();
    ensureLineMergeRows().forEach((row) => {
      if (row.kind === "changed") row.choice = choice;
    });
    syncDraftFromRows();
    renderTextWorkbench(scrollState);
  }

  function setRowChoice(rowId, choice) {
    const row = ensureLineMergeRows().find((item) => item.id === Number(rowId));
    if (!row || row.kind !== "changed" || !MergeChoices.includes(choice)) return;
    const scrollState = captureTextScrollState();
    row.choice = choice;
    syncDraftFromRows();
    renderTextWorkbench(scrollState);
  }

  function captureTextScrollState(root = $("#textWorkbench")) {
    if (!root) return {};
    const modalBody = root.closest(".excel-modal-body");
    const lineTable = root.querySelector(".text-line-table-wrap");
    const editor = root.querySelector("#textCandidateEditor");
    return {
      modalBody: modalBody ? { top: modalBody.scrollTop, left: modalBody.scrollLeft } : null,
      lineTable: lineTable ? { top: lineTable.scrollTop, left: lineTable.scrollLeft } : null,
      editor: editor ? { top: editor.scrollTop, left: editor.scrollLeft } : null
    };
  }

  function restoreTextScrollState(state = {}, root = $("#textWorkbench")) {
    if (!root) return;
    const lineTable = root.querySelector(".text-line-table-wrap");
    if (lineTable && state.lineTable) {
      lineTable.scrollTop = state.lineTable.top;
      lineTable.scrollLeft = state.lineTable.left;
    }
    const editor = root.querySelector("#textCandidateEditor");
    if (editor && state.editor) {
      editor.scrollTop = state.editor.top;
      editor.scrollLeft = state.editor.left;
    }
    const modalBody = root.closest(".excel-modal-body");
    if (modalBody && state.modalBody) {
      modalBody.scrollTop = state.modalBody.top;
      modalBody.scrollLeft = state.modalBody.left;
    }
  }

  function renderSourcePane(source) {
    const data = view.text?.[source] || {};
    const active = view.textDraftSource === source ? " active" : "";
    const disabled = data.available === false ? " disabled" : "";
    const content = data.available === false ? data.error || "stage unavailable" : data.content || "";
    return `
      <div class="text-pane${active}">
        <div class="text-pane-head">
          <div>
            <span>${sourceLabel(source)}</span>
            <div class="text-pane-desc">${escapeHtml(sourceDescription(source))}</div>
          </div>
          <button class="mini-btn${active}" data-text-source="${source}"${disabled}>整份采用</button>
        </div>
        <pre class="text-source">${escapeHtml(content)}</pre>
      </div>
    `;
  }

  function renderLineChoiceButton(row, choice) {
    const active = row.choice === choice ? " active" : "";
    const tone = choice === "ours" ? " ours" : choice === "theirs" ? " theirs" : "";
    return `<button class="mini-btn text-choice-btn${tone}${active}" data-line-choice="${choice}" data-row-id="${row.id}">${sourceLabel(choice)}</button>`;
  }

  function renderLineRow(row) {
    const changed = row.kind === "changed";
    return `
      <tr class="${changed ? "line-changed" : "line-same"}">
        <td class="line-number">${escapeHtml(String(row.oursLineNumber || ""))}</td>
        <td class="${changed ? "line-ours-cell" : ""}"><pre class="line-cell">${escapeHtml(row.ours)}</pre></td>
        <td class="line-number">${escapeHtml(String(row.theirsLineNumber || ""))}</td>
        <td class="${changed ? "line-theirs-cell" : ""}"><pre class="line-cell">${escapeHtml(row.theirs)}</pre></td>
        <td class="line-choice">
          ${changed ? `<span class="text-conflict-label">冲突</span>${MergeChoices.map((choice) => renderLineChoiceButton(row, choice)).join("")}` : '<span class="muted">same</span>'}
        </td>
      </tr>
    `;
  }

  function renderLineMergeTable() {
    const rows = ensureLineMergeRows();
    return `
      <div class="text-line-merge">
        <div class="text-line-toolbar">
          <div>
            <strong>按行对比：本分支 ↔ 合入分支</strong>
            <span class="muted">${rows.length} 行；共同祖先用于判断两边分别改了什么</span>
          </div>
          <div class="toolbar">
            <button class="mini-btn" data-line-all="ours">全部用本分支</button>
            <button class="mini-btn" data-line-all="theirs">全部用合入分支</button>
            <button class="mini-btn" data-line-all="both">全部保留两边</button>
            <button class="mini-btn" data-line-all="none">清空冲突行</button>
            <button class="mini-btn" data-text-source="current">重置为当前冲突文件</button>
          </div>
        </div>
        <div class="text-line-table-wrap">
          <table class="text-line-table">
            <thead>
              <tr>
                <th>本#</th>
                <th>本分支</th>
                <th>合#</th>
                <th>合入分支</th>
                <th>选择</th>
              </tr>
            </thead>
            <tbody>${rows.map(renderLineRow).join("")}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderTextWorkbench(scrollState = null) {
    const root = $("#textWorkbench");
    if (!view.text) {
      root.innerHTML = "";
      $("#writeTextCandidateBtn").disabled = true;
      return;
    }

    $("#textBox").textContent = [
      `冲突路径：${view.text.path}`,
      "上方合并结果可以随时手动编辑；下方按钮只是在帮你快速把某一边内容填入合并结果。",
      "页面只生成 .git/git-safe-commit-backups 下的候选文件，不覆盖原路径，也不会执行 git add。"
    ].join("\n");
    $("#writeTextCandidateBtn").disabled = false;

    root.innerHTML = `
      <div class="text-candidate">
        <div class="excel-pane-head">
          <span>合并结果（可随时编辑）</span>
          <span>${escapeHtml(view.text.path)}</span>
        </div>
        <textarea id="textCandidateEditor" spellcheck="false">${escapeHtml(view.textDraft || "")}</textarea>
      </div>
      <div class="text-relation box">
        <strong>对比关系</strong>
        <span>共同祖先 → 本分支：本地这边做了哪些改动。</span>
        <span>共同祖先 → 合入分支：对方分支做了哪些改动。</span>
        <span>当前冲突文件：Git 把无法自动决定的地方留在工作区。</span>
        <span>合并结果：你最终要确认的候选文本，可以直接编辑。</span>
      </div>
      <div class="box warn">当前候选来源：${escapeHtml(sourceLabel(view.textDraftSource || "current"))} | 长度：${(view.textDraft || "").length}</div>
      ${renderLineMergeTable()}
      <div class="text-grid">
        ${Sources.map(renderSourcePane).join("")}
      </div>
    `;

    root.querySelectorAll("[data-text-source]").forEach((button) => {
      button.onclick = () => setDraftFromSource(button.dataset.textSource);
    });
    root.querySelectorAll("[data-line-all]").forEach((button) => {
      button.onclick = () => setAllRows(button.dataset.lineAll);
    });
    root.querySelectorAll("[data-line-choice]").forEach((button) => {
      button.onclick = () => setRowChoice(button.dataset.rowId, button.dataset.lineChoice);
    });
    const editor = $("#textCandidateEditor");
    editor.oninput = () => {
      view.textDraft = editor.value;
      view.textDraftSource = "edited";
    };
    if (scrollState) {
      restoreTextScrollState(scrollState, root);
    }
  }

  function loadTextResponse(data) {
    if (!data.textConflict) {
      throw new Error("server did not return text conflict workbench data");
    }
    view.text = data.textConflict;
    view.textLineRows = buildLineRows(getSourceContent("ours"), getSourceContent("theirs"));
    syncDraftFromRows();
    renderTextWorkbench();
    openTextModal();
  }

  async function openTextWorkbenchForPath(path) {
    setOutput("Loading text conflict...", "Open text merge workbench");
    try {
      const data = await request("/api/text-conflict/load", {
        method: "POST",
        body: JSON.stringify({ path })
      });
      loadTextResponse(data);
      setOutput(formatResults(data), "Text merge workbench loaded");
      await refreshAll();
    } catch (error) {
      setOutput(`ERROR\n${error.message}`, "Open text merge workbench failed");
    }
  }

  async function writeTextCandidate() {
    if (!view.text) {
      setOutput("ERROR\nOpen the text merge workbench first.", "Write text candidate failed");
      return;
    }
    const editor = $("#textCandidateEditor");
    const content = editor ? editor.value : view.textDraft || "";
    setOutput("Writing text merge candidate...", "Write text merge candidate");
    try {
      const data = await request("/api/text-conflict/write-candidate", {
        method: "POST",
        body: JSON.stringify({
          path: view.text.path,
          source: view.textDraftSource || "edited",
          lineChoices: lineChoiceSummary(),
          content
        })
      });
      $("#textBox").textContent = [
        `Candidate: ${data.textCandidate.candidate}`,
        `Choices: ${data.textCandidate.choices}`,
        `Final path after confirmation: ${data.textCandidate.finalPath}`,
        "The guard did not overwrite the original path and did not run git add."
      ].join("\n");
      setOutput(formatResults(data), "Text merge candidate written");
      await refreshAll();
    } catch (error) {
      setOutput(`ERROR\n${error.message}`, "Write text candidate failed");
    }
  }

  return {
    openTextWorkbenchForPath,
    writeTextCandidate
  };
}
