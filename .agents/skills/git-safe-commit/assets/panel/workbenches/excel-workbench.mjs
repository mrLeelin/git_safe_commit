import { request } from "../api.mjs";
import { $, escapeHtml } from "../dom.mjs";
import { setOutput } from "../components/output-viewer.mjs";

export function createExcelWorkbench({ view, formatResults, openExcelModal, refreshAll }) {
  const choiceDrafts = new Map();
  let syncedScrollTarget = null;
  const MinZoom = 0.65;
  const MaxZoom = 1.6;
  const ZoomStep = 0.1;
  let closeCellEditorHandler = null;

  function choiceKey(sheetIndex, suffix) {
    return `${sheetIndex}:${suffix}`;
  }

  function excelPathKey(path) {
    return String(path || "").replaceAll("\\", "/").toLowerCase();
  }

  function excelConflictKey(excel) {
    if (!excel || excel.previewOnly) return "";
    return [
      excelPathKey(excel.path),
      excelPathKey(excel.base),
      excelPathKey(excel.ours),
      excelPathKey(excel.theirs)
    ].join("|");
  }

  function currentExcelPathKey() {
    return excelConflictKey(view.excel);
  }

  function activeSheet() {
    return (view.excel?.sheets || []).find((sheet) => sheet.sheetIndex === view.activeSheetIndex) || view.excel?.sheets?.[0] || null;
  }

  function excelZoom() {
    const zoom = Number(view.excelZoom || 1);
    return Math.min(MaxZoom, Math.max(MinZoom, Number.isFinite(zoom) ? zoom : 1));
  }

  function setExcelZoom(nextZoom, scrollState = captureScrollState()) {
    view.excelZoom = Math.round(Math.min(MaxZoom, Math.max(MinZoom, nextZoom)) * 100) / 100;
    renderExcelWorkbench(scrollState);
  }

  function rowChoice(sheetIndex, row) {
    return view.rowChoices.get(choiceKey(sheetIndex, row));
  }

  function cellChoice(sheetIndex, cell) {
    return view.cellChoices.get(choiceKey(sheetIndex, cell));
  }

  function activeConflictKey() {
    return view.activeExcelConflictKey || "";
  }

  function activeCellEditorKey() {
    return view.activeExcelCellEditorKey || "";
  }

  function setActiveConflict(sheetIndex, cell) {
    view.activeExcelConflictKey = choiceKey(sheetIndex, cell);
    renderExcelWorkbench();
  }

  function setActiveCellEditor(sheetIndex, target) {
    const key = choiceKey(sheetIndex, target);
    view.activeExcelCellEditorKey = activeCellEditorKey() === key ? "" : key;
    renderExcelWorkbench();
  }

  function activeCellEditorTarget() {
    const key = activeCellEditorKey();
    if (!key) return null;
    const separator = key.indexOf(":");
    if (separator < 0) return null;
    const sheetIndex = Number(key.slice(0, separator));
    const target = key.slice(separator + 1);
    const sideSeparator = target.indexOf(":");
    const side = sideSeparator > 0 ? target.slice(0, sideSeparator) : "";
    const address = sideSeparator > 0 ? target.slice(sideSeparator + 1) : target;
    return { sheetIndex, side, address };
  }

  function closeActiveCellEditor(scrollState = captureScrollState()) {
    if (!activeCellEditorKey()) return;
    view.activeExcelCellEditorKey = "";
    renderExcelWorkbench(scrollState);
  }

  function choicePayload() {
    const rowChoices = [...view.rowChoices.entries()].map(([key, choice]) => {
      const [sheetIndex, row] = key.split(":");
      const rowMeta = findExcelRow(Number(sheetIndex), Number(row));
      return {
        sheetIndex: Number(sheetIndex),
        row: Number(row),
        rowKey: rowMeta?.rowKey || "",
        baseRow: rowMeta?.baseRow || null,
        oursRow: rowMeta?.oursRow || null,
        theirsRow: rowMeta?.theirsRow || null,
        ...normalizeChoice(choice, "insert-row-after")
      };
    });
    const cellChoices = [...view.cellChoices.entries()].map(([key, choice]) => {
      const [sheetIndex, cell] = key.split(":");
      const cellMeta = findExcelCell(Number(sheetIndex), cell);
      return {
        sheetIndex: Number(sheetIndex),
        cell,
        rowKey: cellMeta?.row?.rowKey || "",
        baseRow: cellMeta?.row?.baseRow || null,
        oursRow: cellMeta?.row?.oursRow || null,
        theirsRow: cellMeta?.row?.theirsRow || null,
        baseCell: remapCellAddress(cell, cellMeta?.row?.baseRow),
        oursCell: remapCellAddress(cell, cellMeta?.row?.oursRow),
        theirsCell: remapCellAddress(cell, cellMeta?.row?.theirsRow),
        ...normalizeChoice(choice, "insert-column-after")
      };
    });
    return { rowChoices, cellChoices };
  }

  function excelLoadPayload(path, source = view.excel) {
    const payload = { path };
    if (source?.ours && source?.theirs) {
      payload.ours = source.ours;
      payload.theirs = source.theirs;
      if (source.base) payload.base = source.base;
    }
    return payload;
  }

  function saveCurrentChoiceDraft() {
    const key = currentExcelPathKey();
    if (!key) return;
    choiceDrafts.set(key, choicePayload());
  }

  function choiceSummary(choices = choicePayload()) {
    const label = (item) => item.rowKey || item.cell || `R${item.row}`;
    const sideName = (source) => source === "theirs" ? "THEIRS 右侧" : "OURS 左侧";
    const describeChoose = (item, source = item.source || "ours") => {
      if (source === "ours" && !item.oursRow && item.theirsRow) {
        return "采用 OURS 左侧空行，最终不保留右侧新增行";
      }
      if (source === "theirs" && item.oursRow && !item.theirsRow) {
        return "采用 THEIRS 右侧空行，最终删除左侧已有行";
      }
      return `采用 ${sideName(source)}`;
    };
    const describe = (item) => {
      if (item.action === "keep-both") {
        return `两边保留(${sideName(item.primary)} + ${sideName(item.secondary)})`;
      }
      return describeChoose(item);
    };
    const rows = (choices.rowChoices || []).map((item) => `Sheet${item.sheetIndex}:${label(item)}=${describe(item)}`);
    const cells = (choices.cellChoices || []).map((item) => `Sheet${item.sheetIndex}:${label(item)} ${item.cell || ""}=${describe(item)}`);
    return [...rows, ...cells].join("\n") || "无显式选择；非重叠改动自动合并，真正冲突默认暂用 OURS 预览";
  }

  function candidatePreviewSummary(preview) {
    if (!preview?.sheets?.length) return "";
    return preview.sheets.map((sheet) => {
      if (!Array.isArray(sheet.rows)) {
        return `${sheet.name}: summary=${sheet.classification || preview.summary || "unknown"}, diff=${sheet.diffCount || 0}, auto=${sheet.autoMergeCount || 0}, conflict=${sheet.conflictCount || 0}`;
      }
      const firstColumnValues = (sheet.rows || [])
        .map((row) => row.cells?.[0]?.ours?.display ?? "")
        .join("");
      return `${sheet.name}: A列=${firstColumnValues}`;
    }).join("\n");
  }

  function columnIndexFromAddress(address) {
    const letters = String(address || "").match(/^[A-Z]+/i)?.[0]?.toUpperCase() || "";
    let index = 0;
    for (const char of letters) {
      index = index * 26 + char.charCodeAt(0) - 64;
    }
    return index - 1;
  }

  function columnLettersFromAddress(address) {
    return String(address || "").match(/^[A-Z]+/i)?.[0]?.toUpperCase() || "";
  }

  function remapCellAddress(address, rowNumber) {
    const column = columnLettersFromAddress(address);
    return column && rowNumber ? `${column}${rowNumber}` : "";
  }

  function sideRowNumber(row, side) {
    if (!row) return "";
    if (side === "base") return row.baseRow || row.row || "";
    if (side === "theirs") return row.theirsRow || row.row || "";
    return row.oursRow || row.row || "";
  }

  function sideCellAddress(cell, side) {
    if (!cell) return "";
    if (side === "base") return cell.baseAddress || remapCellAddress(cell.address, cell.baseRow) || cell.address || "";
    if (side === "theirs") return cell.theirsAddress || remapCellAddress(cell.address, cell.theirsRow) || cell.address || "";
    return cell.oursAddress || remapCellAddress(cell.address, cell.oursRow) || cell.address || "";
  }

  function realCellAddressLabel(cell) {
    const parts = [
      cell?.baseAddress ? `B ${cell.baseAddress}` : "",
      sideCellAddress(cell, "ours") ? `O ${sideCellAddress(cell, "ours")}` : "",
      sideCellAddress(cell, "theirs") ? `T ${sideCellAddress(cell, "theirs")}` : "",
    ].filter(Boolean);
    return parts.join(" / ") || cell?.address || "";
  }

  function findExcelRow(sheetIndex, rowNumber) {
    const sheet = (view.excel?.sheets || []).find((item) => Number(item.sheetIndex) === Number(sheetIndex));
    return (sheet?.rows || []).find((item) => Number(item.row) === Number(rowNumber)) || null;
  }

  function findExcelCell(sheetIndex, address) {
    const sheet = (view.excel?.sheets || []).find((item) => Number(item.sheetIndex) === Number(sheetIndex));
    for (const row of sheet?.rows || []) {
      const cell = (row.cells || []).find((item) => item.address === address);
      if (cell) return { row, cell };
    }
    return null;
  }

  function cellDisplayValue(cell) {
    const value = cell?.ours?.display ?? cell?.theirs?.display ?? cell?.base?.display ?? cell?.display ?? "";
    return String(value ?? "").trim();
  }

  function valueAt(sheet, rowNumber, columnIndex) {
    const row = (sheet.rows || []).find((item) => Number(item.row) === rowNumber);
    return cellDisplayValue(row?.cells?.[columnIndex]);
  }

  function uniqueHeaderParts(parts) {
    const seen = new Set();
    return parts
      .map((part) => String(part || "").trim())
      .filter((part) => {
        if (!part || part.startsWith("##")) return false;
        const key = part.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function columnHeaderInfo(sheet, column, columnIndex, inserted = false) {
    const row1 = valueAt(sheet, 1, columnIndex);
    const row3 = valueAt(sheet, 3, columnIndex);
    const row4 = valueAt(sheet, 4, columnIndex);
    const meta = row3 ? uniqueHeaderParts([row3, row4]) : uniqueHeaderParts([row1, row4]);
    return {
      column,
      displayColumn: inserted ? `${column}+` : column,
      meta,
      inserted,
      title: uniqueHeaderParts([inserted ? `${column}+` : column, ...meta]).join(" / ")
    };
  }

  function renderColumnHeader(info) {
    const meta = info?.meta || [];
    return `
      <span class="column-head" title="${escapeHtml(info?.title || info?.displayColumn || "")}">
        <span class="column-head-main">${escapeHtml(info?.displayColumn || "")}</span>
        ${meta.map((part, index) => `<span class="${index === 0 ? "column-head-meta" : "column-head-desc"}">${escapeHtml(part)}</span>`).join("")}
      </span>
    `;
  }

  function renderRowHeader(row, side) {
    const sideRow = sideRowNumber(row, side);
    const refs = [
      row.baseRow ? `B${row.baseRow}` : "",
      row.oursRow ? `O${row.oursRow}` : "",
      row.theirsRow ? `T${row.theirsRow}` : ""
    ].filter(Boolean).join(" / ");
    const rowLabel = side === "theirs" ? "T" : "O";
    return `
      <div class="row-number">${escapeHtml(sideRow ? `${rowLabel}${sideRow}` : `#${row.row}`)}</div>
      ${row.rowKey ? `<div class="row-key" title="${escapeHtml(row.rowKey)}">Key ${escapeHtml(row.rowKey)}</div>` : ""}
      ${sideRow && Number(sideRow) !== Number(row.row) ? `<div class="row-side-ref">对齐行 #${escapeHtml(row.row)}</div>` : ""}
      ${refs ? `<div class="row-ref">${escapeHtml(refs)}</div>` : ""}
    `;
  }

  function focusedSheet(sheet) {
    const allRows = sheet.rows || [];
    const allColumns = sheet.columns || [];
    if (view.excel?.previewOnly) {
      const indexes = allColumns.map((_, index) => index);
      return {
        columns: allColumns,
        columnHeaders: new Map(indexes.map((index) => [allColumns[index], columnHeaderInfo(sheet, allColumns[index], index)])),
        rows: allRows,
        totalRows: allRows.length,
        totalColumns: allColumns.length,
        hiddenRows: 0,
        hiddenColumns: 0
      };
    }

    const columnIndexes = new Set();

    for (const address of sheet.diffCells || []) {
      const index = columnIndexFromAddress(address);
      if (index >= 0) columnIndexes.add(index);
    }

    allRows.forEach((row) => {
      (row.cells || []).forEach((cell, index) => {
        if (!cell.equal || cell.autoMerge || cell.conflict) {
          columnIndexes.add(index);
        }
      });
    });

    const indexes = [...columnIndexes]
      .filter((index) => index >= 0 && index < allColumns.length)
      .sort((a, b) => a - b);
    const rows = allRows
      .filter((row) => row.hasDiff || (row.cells || []).some((cell) => !cell.equal || cell.autoMerge || cell.conflict))
      .map((row) => ({
        ...row,
        cells: indexes.map((index) => row.cells[index]).filter(Boolean)
      }));

    return {
      columns: indexes.map((index) => allColumns[index]),
      columnHeaders: new Map(indexes.map((index) => [allColumns[index], columnHeaderInfo(sheet, allColumns[index], index)])),
      rows,
      totalRows: allRows.length,
      totalColumns: allColumns.length,
      hiddenRows: Math.max(0, allRows.length - rows.length),
      hiddenColumns: Math.max(0, allColumns.length - indexes.length)
    };
  }

  function conflictItems(sheet) {
    const items = [];
    for (const row of sheet.rows || []) {
      for (const cell of row.cells || []) {
        if (!cell.conflict) continue;
        const choice = cellChoice(sheet.sheetIndex, cell.address) || rowChoice(sheet.sheetIndex, row.row);
        items.push({
          sheetIndex: sheet.sheetIndex,
          row: row.row,
          column: cell.column,
          address: cell.address,
          displayAddress: realCellAddressLabel(cell),
          oursAddress: sideCellAddress(cell, "ours"),
          theirsAddress: sideCellAddress(cell, "theirs"),
          cell,
          choice,
          resolved: Boolean(choice),
        });
      }
    }
    return items;
  }

  function selectedConflict(sheet, items = conflictItems(sheet)) {
    const key = activeConflictKey();
    const selected = items.find((item) => choiceKey(item.sheetIndex, item.address) === key);
    return selected || items[0] || null;
  }

  function conflictChoiceLabel(item) {
    if (!item?.choice) return "未选择";
    const choice = normalizeChoice(item.choice);
    if (choice.action === "keep-both") {
      return choice.placement === "insert-row-after" ? "两边保留为新行" : "两边保留为新列";
    }
    return choice.source === "theirs" ? "采用合入分支" : "采用本分支";
  }

  function normalizePlacement(placement, fallback = "insert-column-after") {
    return placement === "insert-row-after" || placement === "insert-column-after" ? placement : fallback;
  }

  function normalizeChoice(choice = {}, defaultPlacement = "insert-column-after") {
    if (typeof choice === "string") {
      return { action: "choose", source: choice === "theirs" ? "theirs" : "ours" };
    }
    if (choice.action === "keep-both") {
      const primary = choice.primary === "theirs" ? "theirs" : "ours";
      const secondary = choice.secondary === "ours" ? "ours" : "theirs";
      return {
        action: "keep-both",
        primary,
        secondary: primary === secondary ? (primary === "ours" ? "theirs" : "ours") : secondary,
        placement: normalizePlacement(choice.placement, defaultPlacement),
      };
    }
    return { action: "choose", source: choice.source === "theirs" ? "theirs" : "ours" };
  }

  function choiceSource(choice) {
    if (!choice) return "";
    const normalized = normalizeChoice(choice);
    return normalized.action === "keep-both" ? normalized.primary : normalized.source;
  }

  function isKeepBoth(choice) {
    return Boolean(choice && normalizeChoice(choice).action === "keep-both");
  }

  function isKeepBothPlacement(choice, placement) {
    return Boolean(isKeepBoth(choice) && normalizeChoice(choice).placement === placement);
  }

  function applyChoicePayload(choices = {}) {
    view.rowChoices.clear();
    view.cellChoices.clear();

    for (const item of choices.rowChoices || []) {
      view.rowChoices.set(choiceKey(Number(item.sheetIndex), Number(item.row)), normalizeChoice(item, "insert-row-after"));
    }

    for (const item of choices.cellChoices || []) {
      const key = choiceKey(Number(item.sheetIndex), String(item.cell || ""));
      view.cellChoices.set(key, normalizeChoice(item, "insert-column-after"));
    }
  }

  function setRowChoice(sheetIndex, row, source) {
    const key = choiceKey(sheetIndex, row);
    view.rowChoices.set(key, { action: "choose", source: source === "theirs" ? "theirs" : "ours" });
    clearCellChoicesForRow(sheetIndex, row);
    view.activeExcelCellEditorKey = "";
    saveCurrentChoiceDraft();
    renderExcelWorkbench();
  }

  function setCellChoice(sheetIndex, cell, source) {
    const key = choiceKey(sheetIndex, cell);
    clearRowChoiceForCell(sheetIndex, cell);
    view.cellChoices.set(key, { action: "choose", source: source === "theirs" ? "theirs" : "ours" });
    view.activeExcelCellEditorKey = "";
    saveCurrentChoiceDraft();
    renderExcelWorkbench();
  }

  function setRowKeepBoth(sheetIndex, row, primary) {
    const first = primary === "theirs" ? "theirs" : "ours";
    view.rowChoices.set(choiceKey(sheetIndex, row), {
      action: "keep-both",
      primary: first,
      secondary: first === "ours" ? "theirs" : "ours",
      placement: "insert-row-after",
    });
    clearCellChoicesForRow(sheetIndex, row);
    view.activeExcelCellEditorKey = "";
    saveCurrentChoiceDraft();
    renderExcelWorkbench();
  }

  function setCellKeepBoth(sheetIndex, cell, primary, placement = "insert-column-after") {
    const first = primary === "theirs" ? "theirs" : "ours";
    clearRowChoiceForCell(sheetIndex, cell);
    view.cellChoices.set(choiceKey(sheetIndex, cell), {
      action: "keep-both",
      primary: first,
      secondary: first === "ours" ? "theirs" : "ours",
      placement: normalizePlacement(placement),
    });
    view.activeExcelCellEditorKey = "";
    saveCurrentChoiceDraft();
    renderExcelWorkbench();
  }

  function clearCellChoicesForRow(sheetIndex, row) {
    for (const cellKey of [...view.cellChoices.keys()]) {
      if (!cellKey.startsWith(`${sheetIndex}:`)) continue;
      const cellRow = Number(cellKey.match(/\d+$/)?.[0] || 0);
      if (cellRow === Number(row)) view.cellChoices.delete(cellKey);
    }
  }

  function clearRowChoiceForCell(sheetIndex, cell) {
    const row = Number(String(cell).match(/\d+$/)?.[0] || 0);
    if (row) view.rowChoices.delete(choiceKey(sheetIndex, row));
  }

  function mergedCell(sheet, cell) {
    if (cell.autoMerge) {
      const oursChanged = cell.base?.display !== cell.ours?.display;
      const theirsChanged = cell.base?.display !== cell.theirs?.display;
      const source = theirsChanged && !oursChanged ? "theirs" : "ours";
      return {
        source,
        cell: source === "theirs" ? cell.theirs : cell.ours
      };
    }
    const choice = cellChoice(sheet.sheetIndex, cell.address) || rowChoice(sheet.sheetIndex, cell.row);
    const source = choiceSource(choice) || "ours";
    return {
      source,
      keepBoth: isKeepBoth(choice),
      cell: source === "theirs" ? cell.theirs : cell.ours
    };
  }

  function sideIsSelectedForChoice(choice, side) {
    if (!choice) return side === "ours";
    const normalized = normalizeChoice(choice);
    if (normalized.action === "keep-both") return side === normalized.primary || side === normalized.secondary;
    return normalized.source === side;
  }

  function autoMergeLabel(cell, side) {
    const oursChanged = cell.base?.display !== cell.ours?.display;
    const theirsChanged = cell.base?.display !== cell.theirs?.display;
    const source = theirsChanged && !oursChanged ? "theirs" : "ours";
    if (side === source) return "单边改动，采用";
    return "未改动";
  }

  function updateResetChoicesButton() {
    const button = $("#resetExcelChoicesBtn");
    if (!button) return;
    button.disabled = !view.excel || Boolean(view.excel.previewOnly);
  }

  function captureScrollState(root = $("#excelWorkbench")) {
    if (!root) return {};
    const modalBody = root.closest(".excel-modal-body");
    const state = {
      modalBody: modalBody ? { top: modalBody.scrollTop, left: modalBody.scrollLeft } : null,
      tables: {},
      preview: null
    };
    root.querySelectorAll("[data-excel-side]").forEach((element) => {
      state.tables[element.dataset.excelSide] = {
        top: element.scrollTop,
        left: element.scrollLeft
      };
    });
    const preview = root.querySelector("[data-excel-preview]");
    if (preview) {
      state.preview = {
        top: preview.scrollTop,
        left: preview.scrollLeft
      };
    }
    return state;
  }

  function restoreScrollState(state = {}, root = $("#excelWorkbench")) {
    if (!root) return;
    root.querySelectorAll("[data-excel-side]").forEach((element) => {
      const saved = state.tables?.[element.dataset.excelSide];
      if (!saved) return;
      element.scrollTop = saved.top;
      element.scrollLeft = saved.left;
    });
    const preview = root.querySelector("[data-excel-preview]");
    if (preview && state.preview) {
      preview.scrollTop = state.preview.top;
      preview.scrollLeft = state.preview.left;
    }
    const modalBody = root.closest(".excel-modal-body");
    if (modalBody && state.modalBody) {
      modalBody.scrollTop = state.modalBody.top;
      modalBody.scrollLeft = state.modalBody.left;
    }
  }

  function syncPairedScroll(source, target) {
    if (!source || !target || source === syncedScrollTarget) return;
    syncedScrollTarget = target;
    target.scrollTop = source.scrollTop;
    target.scrollLeft = source.scrollLeft;
    requestAnimationFrame(() => {
      if (syncedScrollTarget === target) {
        syncedScrollTarget = null;
      }
    });
  }

  function positionDecisionPopover(root) {
    const layer = root.querySelector(".excel-floating-layer");
    const popover = layer?.querySelector(".cell-decision-popover");
    if (!layer || !popover) return;
    const anchor = root.querySelector(".cell-settings-btn.active, .row-settings-btn.active");
    if (!anchor) return;

    const anchorRect = anchor.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const gap = 8;
    const margin = 10;
    const maxLeft = Math.max(margin, window.innerWidth - popoverRect.width - margin);
    const left = Math.min(Math.max(anchorRect.left, margin), maxLeft);
    const belowTop = anchorRect.bottom + gap;
    const aboveTop = anchorRect.top - popoverRect.height - gap;
    const top = belowTop + popoverRect.height + margin <= window.innerHeight
      ? belowTop
      : Math.max(margin, aboveTop);

    layer.style.left = `${left}px`;
    layer.style.top = `${top}px`;
  }

  function bindDecisionPopoverDismiss(root) {
    if (closeCellEditorHandler) {
      document.removeEventListener("click", closeCellEditorHandler);
    }
    closeCellEditorHandler = (event) => {
      if (!activeCellEditorKey()) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".excel-floating-layer, [data-cell-settings], [data-row-settings]")) return;
      closeActiveCellEditor(captureScrollState(root));
    };
    document.addEventListener("click", closeCellEditorHandler);
  }

  function bindExcelScrollSync(root) {
    const ours = root.querySelector('[data-excel-side="ours"]');
    const theirs = root.querySelector('[data-excel-side="theirs"]');
    if (ours && theirs) {
      ours.addEventListener("scroll", () => syncPairedScroll(ours, theirs), { passive: true });
      theirs.addEventListener("scroll", () => syncPairedScroll(theirs, ours), { passive: true });
    }
    root.querySelectorAll("[data-excel-zoom-surface]").forEach((surface) => {
      surface.addEventListener("wheel", (event) => {
        if (!event.ctrlKey) return;
        event.preventDefault();
        const direction = event.deltaY < 0 ? 1 : -1;
        setExcelZoom(excelZoom() + direction * ZoomStep, captureScrollState(root));
      }, { passive: false });
    });
    root.querySelectorAll("[data-excel-zoom-wheel]").forEach((surface) => {
      surface.addEventListener("wheel", (event) => {
        event.preventDefault();
        const direction = event.deltaY < 0 ? 1 : -1;
        setExcelZoom(excelZoom() + direction * ZoomStep, captureScrollState(root));
      }, { passive: false });
    });
    root.querySelectorAll("[data-excel-side], [data-excel-preview]").forEach((surface) => {
      surface.addEventListener("scroll", () => closeActiveCellEditor(captureScrollState(root)), { passive: true });
    });
  }

  function resetExcelChoices() {
    view.rowChoices.clear();
    view.cellChoices.clear();
    saveCurrentChoiceDraft();
    renderExcelWorkbench();
    setOutput("已恢复初始值：非重叠改动自动合并，真正冲突默认暂用 OURS 预览。", "恢复初始值");
  }

  function loadExcelResponse(data) {
    if (!data.excelConflict) {
      throw new Error("服务端没有返回 Excel 工作台数据；如果不是 Git 冲突状态，请使用本地两表合并入口。");
    }
    saveCurrentChoiceDraft();
    view.excel = data.excelConflict;
    view.activeSheetIndex = view.excel?.sheets?.[0]?.sheetIndex || 1;
    applyChoicePayload(choiceDrafts.get(excelConflictKey(view.excel)));
    $("#binaryBox").textContent = [
      `冲突原路径: ${data.excelConflict.path}`,
      `BASE: ${data.excelConflict.base || "(none)"}`,
      `OURS: ${data.excelConflict.ours}`,
      `THEIRS: ${data.excelConflict.theirs}`,
      `summary: ${data.excelConflict.summary}`,
      `sheet count: ${data.excelConflict.sheetCount}`,
      "规则：左/右只改了不同格子时自动合并；只有同一格两边都改且值不同，才需要选择。"
    ].join("\n");
    renderExcelWorkbench();
    openExcelModal();
  }

  function loadExcelPreviewResponse(data) {
    if (!data.excelCandidatePreview) {
      throw new Error("服务端没有返回 Excel 候选预览数据。");
    }
    saveCurrentChoiceDraft();
    view.excel = {
      ...data.excelCandidatePreview,
      previewOnly: true
    };
    view.activeSheetIndex = view.excel?.sheets?.[0]?.sheetIndex || 1;
    view.rowChoices.clear();
    view.cellChoices.clear();
    $("#binaryBox").textContent = [
      `候选合并文件: ${data.excelCandidatePreview.candidate}`,
      `原冲突路径: ${data.excelCandidatePreview.finalPath || data.excelCandidatePreview.path}`,
      `summary: ${data.excelCandidatePreview.summary}`,
      `sheet count: ${data.excelCandidatePreview.sheetCount}`,
      "这是只读预览，不会覆盖原路径，不会 git add。"
    ].join("\n");
    renderExcelWorkbench();
    openExcelModal();
  }

  function renderSheetTabs() {
    const sheets = view.excel?.sheets || [];
    return `<div class="sheet-tabs">${sheets.map((sheet) => {
      const active = sheet.sheetIndex === view.activeSheetIndex ? " active" : "";
      const suffix = sheet.diffCount ? `<span>${sheet.diffCount} 差异</span>` : `<span>无差异</span>`;
      return `<button class="sheet-tab${active}" data-sheet="${sheet.sheetIndex}"><strong>${escapeHtml(sheet.name)}</strong>${suffix}</button>`;
    }).join("")}</div>`;
  }

  function alignmentLabel(sheet) {
    if (sheet?.alignment?.mode === "keyed") {
      return `按 ${sheet.alignment.keyColumn || "主键"} 列主键对齐`;
    }
    return "按行列坐标对齐";
  }

  function renderMetric(label, value, tone = "") {
    return `
      <div class="excel-metric ${tone}">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `;
  }

  function renderWorkbenchHero(sheet, focused, payload, disabled, previewOnly, warning, zoom) {
    const selectedCount = payload.rowChoices.length + payload.cellChoices.length;
    const riskTone = disabled ? "bad" : sheet.conflictCount ? "warn" : "ok";
    const riskLabel = disabled ? "结构阻断" : sheet.conflictCount ? "需要人工决策" : "可自动合并";
    const aiText = sheet.conflictCount
      ? "AI 预分析建议：先确认主键对齐，再逐格处理红色冲突；绿色为单边改动，已可自动进入候选。"
      : "AI 预分析建议：当前 sheet 没有真实冲突，主要检查自动合并结果和候选预览。";
    return `
      <section class="excel-workbench-hero ${riskTone}">
        <div class="excel-hero-main">
          <div class="excel-hero-title-row">
            <span class="excel-state-dot ${riskTone}"></span>
            <div>
              <h3>${escapeHtml(sheet.name || "Sheet")} 合并工作台</h3>
              <p>${escapeHtml(warning)}</p>
            </div>
          </div>
          <div class="excel-hero-meta">
            <span>${escapeHtml(riskLabel)}</span>
            <span>${escapeHtml(alignmentLabel(sheet))}</span>
            <span>${previewOnly ? "只读预览" : "候选文件模式"}</span>
            <span>缩放 ${Math.round(zoom * 100)}%</span>
          </div>
        </div>
        <div class="excel-hero-metrics">
          ${renderMetric("真实冲突", String(sheet.conflictCount || 0), "bad")}
          ${renderMetric("自动合并", String(sheet.autoMergeCount || 0), "ok")}
          ${renderMetric("已选择", String(selectedCount), selectedCount ? "info" : "")}
          ${renderMetric("聚焦范围", `${focused.rows.length}行 / ${focused.columns.length}列`, "info")}
          ${renderMetric("已隐藏", `${focused.hiddenRows}行 / ${focused.hiddenColumns}列`, "")}
        </div>
        <div class="excel-ai-panel">
          <strong>AI 预分析</strong>
          <span>${escapeHtml(aiText)}</span>
          <small>${escapeHtml(view.excel.summary || "")}</small>
        </div>
      </section>
    `;
  }

  function renderConflictDecisionTable(sheet) {
    const items = conflictItems(sheet);
    if (!items.length) {
      return `<div class="merge-decision-grid no-conflicts">
        <section class="merge-conflict-list">
          <div class="merge-section-head">
            <strong>冲突队列</strong>
            <span class="status-pill ok">当前 sheet 无需人工选择</span>
          </div>
          <div class="empty-conflict-state">没有红色冲突格。请检查下方候选预览，确认绿色自动合并符合预期。</div>
        </section>
      </div>`;
    }
    const selected = selectedConflict(sheet, items);
    const resolvedCount = items.filter((item) => item.resolved).length;
    return `
      <div class="merge-decision-grid">
        <section class="merge-conflict-list">
          <div class="merge-section-head">
            <strong>冲突队列</strong>
            <span class="status-pill ${resolvedCount === items.length ? "ok" : "warn"}">${resolvedCount}/${items.length} 已选择</span>
          </div>
          <div class="merge-conflict-table-wrap">
            <table class="merge-conflict-table">
              <thead>
                <tr>
                  <th>位置</th>
                  <th>OURS 本分支</th>
                  <th>THEIRS 合入分支</th>
                  <th>决策</th>
                </tr>
              </thead>
              <tbody>
                ${items.map((item) => {
                  const active = selected && selected.address === item.address ? " active" : "";
                  return `
                    <tr class="${active}" data-conflict-select="${item.address}" data-sheet="${item.sheetIndex}">
                      <td><button class="conflict-link" data-conflict-select="${item.address}" data-sheet="${item.sheetIndex}">${escapeHtml(item.displayAddress || item.address)}</button></td>
                      <td>${escapeHtml(item.cell.ours?.display || "")}</td>
                      <td>${escapeHtml(item.cell.theirs?.display || "")}</td>
                      <td><span class="decision-pill ${item.resolved ? "done" : ""}">${escapeHtml(conflictChoiceLabel(item))}</span></td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>
        </section>
        ${renderConflictDetail(sheet, selected)}
      </div>
    `;
  }

  function renderConflictDetail(sheet, item) {
    if (!item) return "";
    const choice = item.choice ? normalizeChoice(item.choice) : null;
    const oursActive = choice?.action === "choose" && choice.source === "ours";
    const theirsActive = choice?.action === "choose" && choice.source === "theirs";
    const rowActive = choice?.action === "keep-both" && choice.placement === "insert-row-after";
    const columnActive = choice?.action === "keep-both" && choice.placement === "insert-column-after";
    const selectedText = choice ? conflictChoiceLabel(item) : "请选择最终表的处理方式";
    const displayAddress = item.displayAddress || realCellAddressLabel(item.cell) || item.address;
    return `
      <section class="merge-conflict-detail">
        <div class="merge-section-head">
          <strong>当前冲突 ${escapeHtml(displayAddress)}</strong>
          <span class="decision-pill ${choice ? "done" : ""}">${escapeHtml(selectedText)}</span>
        </div>
        <div class="merge-value-grid">
          <div class="merge-value-card base">
            <span>BASE 共同祖先</span>
            <code>${escapeHtml(item.cell.base?.display || "(空)")}</code>
          </div>
          <div class="merge-value-card ours">
            <span>OURS 本分支</span>
            <code>${escapeHtml(item.cell.ours?.display || "(空)")}</code>
          </div>
          <div class="merge-value-card theirs">
            <span>THEIRS 合入分支</span>
            <code>${escapeHtml(item.cell.theirs?.display || "(空)")}</code>
          </div>
        </div>
        <div class="merge-decision-actions">
          <button class="btn secondary ${oursActive ? "active" : ""}" data-detail-cell-source="ours" data-sheet="${sheet.sheetIndex}" data-cell="${item.address}">采用 OURS</button>
          <button class="btn secondary ${theirsActive ? "active" : ""}" data-detail-cell-source="theirs" data-sheet="${sheet.sheetIndex}" data-cell="${item.address}">采用 THEIRS</button>
          <button class="btn secondary keep-both-btn ${rowActive ? "active" : ""}" data-detail-cell-keep-both="ours" data-detail-placement="insert-row-after" data-sheet="${sheet.sheetIndex}" data-cell="${item.address}">两边保留为新行</button>
          <button class="btn secondary keep-both-btn ${columnActive ? "active" : ""}" data-detail-cell-keep-both="ours" data-detail-placement="insert-column-after" data-sheet="${sheet.sheetIndex}" data-cell="${item.address}">两边保留为新列</button>
        </div>
        <div class="merge-detail-note">
          <strong>对比关系</strong>
          <span>BASE 是共同祖先；OURS 是当前分支；THEIRS 是合入分支。红色表示两边都改且结果不同，必须选择或保留两边。</span>
        </div>
      </section>
    `;
  }

  function renderCellDecisionEditor(sheet, cell, side = "ours") {
    const choice = cellChoice(sheet.sheetIndex, cell.address) || rowChoice(sheet.sheetIndex, cell.row);
    const normalized = choice ? normalizeChoice(choice) : null;
    const source = side === "theirs" ? "theirs" : "ours";
    const sourceActive = normalized?.action === "choose" && normalized.source === source;
    const rowActive = normalized?.action === "keep-both" && normalized.placement === "insert-row-after";
    const columnActive = normalized?.action === "keep-both" && normalized.placement === "insert-column-after";
    const sideLabel = source === "theirs" ? "THEIRS" : "OURS";
    const displayAddress = sideCellAddress(cell, source) || realCellAddressLabel(cell) || cell.address;
    return `
      <div class="cell-decision-popover">
        <div class="cell-decision-title">${escapeHtml(displayAddress)} ${sideLabel} 设置</div>
        <button class="cell-decision-option ${sourceActive ? "active" : ""}" data-popover-cell-source="${source}" data-sheet="${sheet.sheetIndex}" data-cell="${cell.address}">采用当前侧 ${sideLabel}</button>
        <button class="cell-decision-option keep-both ${rowActive ? "active" : ""}" data-popover-cell-keep-both="ours" data-popover-placement="insert-row-after" data-sheet="${sheet.sheetIndex}" data-cell="${cell.address}">两边保留为新行</button>
        <button class="cell-decision-option keep-both ${columnActive ? "active" : ""}" data-popover-cell-keep-both="ours" data-popover-placement="insert-column-after" data-sheet="${sheet.sheetIndex}" data-cell="${cell.address}">两边保留为新列</button>
      </div>
    `;
  }

  function renderRowDecisionEditor(sheet, row, side = "ours") {
    const choice = rowChoice(sheet.sheetIndex, row.row);
    const normalized = choice ? normalizeChoice(choice, "insert-row-after") : null;
    const source = side === "theirs" ? "theirs" : "ours";
    const sourceActive = normalized?.action === "choose" && normalized.source === source;
    const keepBothActive = normalized?.action === "keep-both";
    const sideLabel = source === "theirs" ? "THEIRS" : "OURS";
    const displayRow = sideRowNumber(row, source) || row.row;
    return `
      <div class="cell-decision-popover row-decision-popover">
        <div class="cell-decision-title">第 ${displayRow} 行 ${sideLabel} 设置</div>
        <button class="cell-decision-option ${sourceActive ? "active" : ""}" data-popover-row-source="${source}" data-sheet="${sheet.sheetIndex}" data-row="${row.row}">采用当前侧 ${sideLabel} 行</button>
        <button class="cell-decision-option keep-both ${keepBothActive ? "active" : ""}" data-popover-row-keep-both="ours" data-sheet="${sheet.sheetIndex}" data-row="${row.row}">两边保留为新行</button>
      </div>
    `;
  }

  function findCellByAddress(sheet, address) {
    for (const row of sheet.rows || []) {
      const cell = (row.cells || []).find((item) => item.address === address);
      if (cell) return cell;
    }
    return null;
  }

  function findRowByNumber(sheet, rowNumber) {
    return (sheet.rows || []).find((row) => Number(row.row) === Number(rowNumber)) || null;
  }

  function renderFloatingDecisionEditor(sheet) {
    const target = activeCellEditorTarget();
    if (!target || target.sheetIndex !== sheet.sheetIndex) return "";
    if (target.address.startsWith("row-")) {
      const row = findRowByNumber(sheet, Number(target.address.slice(4)));
      return row ? `<div class="excel-floating-layer">${renderRowDecisionEditor(sheet, row, target.side)}</div>` : "";
    }
    const cell = findCellByAddress(sheet, target.address);
    return cell ? `<div class="excel-floating-layer">${renderCellDecisionEditor(sheet, cell, target.side)}</div>` : "";
  }

  function renderExcelSide(sheet, side) {
    const title = side === "ours" ? "OURS 本分支" : "THEIRS 合入分支";
    const focused = focusedSheet(sheet);
    const rows = focused.rows;
    return `
      <div class="excel-pane ${side}">
        <div class="excel-pane-head">
          <div>
            <strong>${title}</strong>
            <span>${escapeHtml(side === "ours" ? sheet.oursName : sheet.theirsName)}</span>
          </div>
          <span class="status-pill ${side === "ours" ? "ours" : "theirs"}">${side === "ours" ? "左侧" : "右侧"}</span>
        </div>
        <div class="excel-table-wrap" data-excel-side="${side}" data-excel-zoom-surface="true">
          <table class="excel-table">
            <thead>
              <tr>
                <th class="row-head">行</th>
                ${focused.columns.map((col) => `<th>${renderColumnHeader(focused.columnHeaders.get(col))}</th>`).join("")}
              </tr>
            </thead>
            <tbody>
              ${rows.map((row) => `
                <tr>
                  <td class="row-head">
                    ${renderRowHeader(row, side)}
                    ${row.cells.some((cell) => cell.conflict) ? `
                      <div class="row-actions">
                        <button class="mini-btn row-settings-btn ${activeCellEditorKey() === choiceKey(sheet.sheetIndex, `${side}:row-${row.row}`) ? "active" : ""}" data-row-settings="${side}:row-${row.row}" data-sheet="${sheet.sheetIndex}">行设置</button>
                      </div>
                    ` : ""}
                  </td>
                  ${row.cells.map((cell) => {
                    const merged = mergedCell(sheet, cell);
                    const rawChoice = cellChoice(sheet.sheetIndex, cell.address) || rowChoice(sheet.sheetIndex, cell.row);
                    const resolved = Boolean(rawChoice);
                    const chosen = sideIsSelectedForChoice(rawChoice, side);
                    const rejected = resolved && cell.conflict && !chosen;
                    const unresolvedConflict = cell.conflict && !resolved;
                    const statusClass = cell.equal
                      ? ""
                      : unresolvedConflict
                        ? "conflict-cell"
                        : cell.conflict
                          ? "resolved-cell"
                          : cell.autoMerge
                            ? "auto-merge-cell"
                            : "diff-cell";
                    const editorKey = choiceKey(sheet.sheetIndex, `${side}:${cell.address}`);
                    const editorOpen = activeCellEditorKey() === editorKey;
                    const valueClass = cell.equal ? "excel-cell-value" : "excel-cell-value excel-cell-value-strong";
                    const displayAddress = sideCellAddress(cell, side) || realCellAddressLabel(cell) || cell.address;
                    return `
                      <td class="${statusClass} ${chosen && cell.conflict ? "chosen-cell" : ""} ${rejected ? "rejected-cell" : ""} ${editorOpen ? "cell-editor-open" : ""}" title="${escapeHtml(displayAddress)} ${escapeHtml(cell[side].display)}">
                        ${chosen && cell.conflict ? `<span class="chosen-cell-badge">${merged.keepBoth ? "保留两边" : "已采用"}</span>` : ""}
                        ${rejected ? `<span class="resolved-cell-badge">已解决</span>` : ""}
                        <div class="${valueClass}">${escapeHtml(cell[side].display)}</div>
                        ${unresolvedConflict ? '<div class="cell-actions"><span class="conflict-label">冲突</span></div>' : ""}
                        ${cell.autoMerge ? `<div class="cell-actions"><span class="auto-merge-label ${autoMergeLabel(cell, side) === "未改动" ? "unchanged" : ""}">${autoMergeLabel(cell, side)}</span></div>` : ""}
                        ${cell.conflict ? `
                          <div class="cell-actions">
                            <button class="mini-btn excel-choice-btn cell-settings-btn ${editorOpen ? "active" : ""}" title="设置 ${escapeHtml(displayAddress)} 的合并方式" data-cell-settings="${side}:${cell.address}" data-sheet="${sheet.sheetIndex}">设置</button>
                          </div>
                        ` : ""}
                      </td>
                    `;
                  }).join("")}
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderPreview(sheet) {
    const focused = focusedSheet(sheet);
    const preview = buildPreviewRows(sheet, focused);
    return `
      <section class="preview-panel">
        <div class="preview-panel-head">
          <div>
            <h3>候选合并预览</h3>
            <span class="muted">这里展示应用选择后的最终表格片段；蓝色 + 表示“两边都保留”新增的行或列。</span>
          </div>
          <span class="status-pill info">${preview.rows.length} 行 / ${preview.columns.length} 列</span>
        </div>
        <div class="preview-table-wrap" data-excel-preview="true" data-excel-zoom-surface="true">
          <table class="preview-table">
            <thead>
              <tr>
                <th>行</th>
                ${preview.columns.map((col) => `<th class="${col.inserted ? "preview-inserted" : ""}">${renderColumnHeader(col.header)}</th>`).join("")}
              </tr>
            </thead>
            <tbody>
              ${preview.rows.map((row) => `
                <tr class="${row.inserted ? "preview-inserted-row" : ""}">
                  <td>${escapeHtml(row.label)}</td>
                  ${row.cells.map((cell) => `<td class="${cell.className}" title="${escapeHtml(cell.title)}">${escapeHtml(cell.display)}${cell.badge ? `<div class="preview-cell-badge">${escapeHtml(cell.badge)}</div>` : ""}</td>`).join("")}
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function buildPreviewRows(sheet, focused) {
    const keepBothColumns = new Map();
    const keepBothRows = new Map();
    for (const row of focused.rows) {
      for (const cell of row.cells || []) {
        const choice = cellChoice(sheet.sheetIndex, cell.address);
        if (!isKeepBoth(choice)) continue;
        const normalized = normalizeChoice(choice);
        if (normalized.placement === "insert-column-after") {
          keepBothColumns.set(cell.column, normalized.secondary);
        } else if (normalized.placement === "insert-row-after") {
          const rowItem = keepBothRows.get(row.row) || { source: normalized.secondary, cells: new Map() };
          rowItem.cells.set(cell.column, normalized.secondary);
          keepBothRows.set(row.row, rowItem);
        }
      }
    }

    const columns = [];
    for (const col of focused.columns) {
      const header = focused.columnHeaders.get(col);
      columns.push({ label: col, original: col, inserted: false, header });
      if (keepBothColumns.has(col)) {
        columns.push({
          label: `${col}+`,
          original: col,
          inserted: true,
          source: keepBothColumns.get(col),
          header: { ...header, displayColumn: `${col}+`, inserted: true, title: `${header?.title || col} / 保留另一侧` }
        });
      }
    }

    const rows = [];
    for (const row of focused.rows) {
      rows.push(buildPreviewRow(sheet, row, columns));
      const rowKeepBoth = rowChoice(sheet.sheetIndex, row.row);
      if (isKeepBoth(rowKeepBoth)) {
        rows.push(buildPreviewRow(sheet, row, columns, true, normalizeChoice(rowKeepBoth).secondary));
      } else if (keepBothRows.has(row.row)) {
        rows.push(buildPreviewRow(sheet, row, columns, true, keepBothRows.get(row.row).source, keepBothRows.get(row.row).cells));
      }
    }
    return { columns, rows };
  }

  function buildPreviewRow(sheet, row, columns, inserted = false, insertedSource = "", insertedCellSources = null) {
    const byColumn = new Map((row.cells || []).map((cell) => [cell.column, cell]));
    const rowChoiceValue = rowChoice(sheet.sheetIndex, row.row);
    const cells = columns.map((column) => {
      const cell = byColumn.get(column.original);
      if (!cell) return { display: "", title: "", className: "", badge: "" };
      if (inserted) {
        const source = insertedCellSources?.get(column.original) || insertedSource || "theirs";
        const fromCellKeepBoth = Boolean(insertedCellSources);
        const isInsertedConflictCell = !fromCellKeepBoth || insertedCellSources.has(column.original);
        return {
          display: fromCellKeepBoth && !insertedCellSources.has(column.original) ? cell[choiceSource(rowChoiceValue) || "ours"]?.display || "" : cell[source]?.display || "",
          title: `keep-both row ${source}`,
          className: isInsertedConflictCell ? "diff-cell preview-keep-both" : "",
          badge: isInsertedConflictCell ? (source === "theirs" ? "合入分支" : "本分支") : "",
        };
      }
      if (column.inserted) {
        const choice = cellChoice(sheet.sheetIndex, cell.address);
        if (!isKeepBothPlacement(choice, "insert-column-after")) return { display: "", title: "inserted keep-both column", className: "preview-empty-inserted", badge: "" };
        const source = normalizeChoice(choice).secondary;
        return {
          display: cell[source]?.display || "",
          title: `keep-both column ${source}`,
          className: "diff-cell preview-keep-both",
          badge: source === "theirs" ? "合入分支" : "本分支",
        };
      }
      const merged = mergedCell(sheet, cell);
      const badge = merged.keepBoth ? (merged.source === "theirs" ? "合入分支" : "本分支") : "";
      return {
        display: merged.cell.display,
        title: merged.keepBoth ? `keep-both primary ${merged.source}` : merged.source,
        className: cell.equal ? "" : merged.keepBoth || isKeepBoth(rowChoiceValue) ? "diff-cell preview-keep-both" : "diff-cell",
        badge,
      };
    });
    return {
      label: row.rowKey ? `${row.rowKey}${inserted ? "+" : ""}` : (inserted ? `${row.row}+` : String(row.row)),
      inserted,
      cells,
    };
  }

  function renderExcelWorkbench(scrollState = null) {
    const root = $("#excelWorkbench");
    const currentScrollState = scrollState || captureScrollState(root);
    if (!view.excel) {
      root.innerHTML = "";
      $("#writeCandidateBtn").disabled = true;
      updateResetChoicesButton();
      return;
    }
    const sheet = activeSheet();
    if (!sheet) {
      root.innerHTML = `<div class="box bad">未读取到 sheet。</div>`;
      $("#writeCandidateBtn").disabled = true;
      updateResetChoicesButton();
      return;
    }

    const payload = choicePayload();
    const focused = focusedSheet(sheet);
    const previewOnly = Boolean(view.excel.previewOnly);
    const disabled = previewOnly || Boolean(view.excel.structureMismatch || sheet.structureMismatch);
    $("#writeCandidateBtn").disabled = disabled;
    updateResetChoicesButton();
    const warning = previewOnly
      ? "当前为候选合并文件只读预览；不会覆盖原冲突路径，也不会 git add。"
      : disabled
        ? "sheet 缺失、重命名或顺序不一致时禁止生成候选文件，请用 Excel/WPS 人工处理。"
        : "规则：非重叠格子自动合并；同一格两边都改且不同，才需要在左/右之间选择。";
    const zoom = excelZoom();
    root.style.setProperty("--excel-zoom", String(zoom));
    root.innerHTML = `
      ${renderWorkbenchHero(sheet, focused, payload, disabled, previewOnly, warning, zoom)}
      <div class="excel-workbench-toolbar" data-excel-zoom-wheel="true">
        <div>
          <strong>表格视图</strong>
          <span class="muted">在工具条滚轮缩放；表格内 Ctrl + 滚轮缩放，普通滚轮滚动表格。当前仅显示有差异的行列。</span>
        </div>
        <div class="toolbar">
          <button class="mini-btn" data-excel-zoom="out">缩小</button>
          <span class="zoom-pill">${Math.round(zoom * 100)}%</span>
          <button class="mini-btn" data-excel-zoom="in">放大</button>
          <button class="mini-btn" data-excel-zoom="reset">100%</button>
        </div>
      </div>
      ${renderSheetTabs()}
      ${sheet.truncated ? `<div class="box warn">当前 sheet 只显示前 ${sheet.visibleRows} 行、${sheet.visibleCols} 列。大表请先缩小冲突范围或人工处理。</div>` : ""}
      ${previewOnly ? "" : renderConflictDecisionTable(sheet)}
      ${previewOnly ? "" : `
      <div class="excel-grid">
        ${renderExcelSide(sheet, "ours")}
        ${renderExcelSide(sheet, "theirs")}
      </div>`}
      ${renderPreview(sheet)}
      ${renderFloatingDecisionEditor(sheet)}
    `;

    root.querySelectorAll("[data-sheet]").forEach((button) => {
      if (button.classList.contains("sheet-tab")) {
        button.onclick = () => {
          view.activeSheetIndex = Number(button.dataset.sheet);
          renderExcelWorkbench();
        };
      }
    });
    root.querySelectorAll("[data-row-source]").forEach((button) => {
      button.onclick = () => setRowChoice(Number(button.dataset.sheet), Number(button.dataset.row), button.dataset.rowSource);
    });
    root.querySelectorAll("[data-row-keep-both]").forEach((button) => {
      button.onclick = () => setRowKeepBoth(Number(button.dataset.sheet), Number(button.dataset.row), button.dataset.rowKeepBoth);
    });
    root.querySelectorAll("[data-cell-source]").forEach((button) => {
      button.onclick = () => setCellChoice(Number(button.dataset.sheet), button.dataset.cell, button.dataset.cellSource);
    });
    root.querySelectorAll("[data-cell-keep-both]").forEach((button) => {
      button.onclick = () => setCellKeepBoth(Number(button.dataset.sheet), button.dataset.cell, button.dataset.cellKeepBoth, button.dataset.cellKeepBothPlacement);
    });
    root.querySelectorAll("[data-cell-settings]").forEach((button) => {
      button.onclick = (event) => {
        event.stopPropagation();
        setActiveCellEditor(Number(button.dataset.sheet), button.dataset.cellSettings);
      };
    });
    root.querySelectorAll("[data-row-settings]").forEach((button) => {
      button.onclick = (event) => {
        event.stopPropagation();
        setActiveCellEditor(Number(button.dataset.sheet), button.dataset.rowSettings);
      };
    });
    root.querySelectorAll("[data-popover-cell-source]").forEach((button) => {
      button.onclick = () => setCellChoice(Number(button.dataset.sheet), button.dataset.cell, button.dataset.popoverCellSource);
    });
    root.querySelectorAll("[data-popover-cell-keep-both]").forEach((button) => {
      button.onclick = () => setCellKeepBoth(Number(button.dataset.sheet), button.dataset.cell, button.dataset.popoverCellKeepBoth, button.dataset.popoverPlacement);
    });
    root.querySelectorAll("[data-popover-row-source]").forEach((button) => {
      button.onclick = () => setRowChoice(Number(button.dataset.sheet), Number(button.dataset.row), button.dataset.popoverRowSource);
    });
    root.querySelectorAll("[data-popover-row-keep-both]").forEach((button) => {
      button.onclick = () => setRowKeepBoth(Number(button.dataset.sheet), Number(button.dataset.row), button.dataset.popoverRowKeepBoth);
    });
    root.querySelectorAll("[data-conflict-select]").forEach((element) => {
      element.onclick = () => setActiveConflict(Number(element.dataset.sheet), element.dataset.conflictSelect);
    });
    root.querySelectorAll("[data-detail-cell-source]").forEach((button) => {
      button.onclick = () => setCellChoice(Number(button.dataset.sheet), button.dataset.cell, button.dataset.detailCellSource);
    });
    root.querySelectorAll("[data-detail-cell-keep-both]").forEach((button) => {
      button.onclick = () => setCellKeepBoth(Number(button.dataset.sheet), button.dataset.cell, button.dataset.detailCellKeepBoth, button.dataset.detailPlacement);
    });
    root.querySelectorAll("[data-excel-zoom]").forEach((button) => {
      button.onclick = () => {
        const action = button.dataset.excelZoom;
        const zoomState = captureScrollState(root);
        if (action === "in") setExcelZoom(excelZoom() + ZoomStep, zoomState);
        if (action === "out") setExcelZoom(excelZoom() - ZoomStep, zoomState);
        if (action === "reset") setExcelZoom(1, zoomState);
      };
    });
    bindExcelScrollSync(root);
    restoreScrollState(currentScrollState, root);
    positionDecisionPopover(root);
    bindDecisionPopoverDismiss(root);
  }

  async function loadExcelWorkbench(source = view.excel) {
    const path = $("#binaryPath").value.trim();
    if (!path) {
      setOutput("ERROR\n请输入 .xlsx 冲突原路径。", "打开 Excel 工作台失败");
      return;
    }

    setOutput("正在导出并加载 Excel 冲突...", "打开 Excel 工作台");
    try {
      const data = await request("/api/excel-conflict/load", {
        method: "POST",
        body: JSON.stringify(excelLoadPayload(path, source))
      });
      loadExcelResponse(data);
      setOutput(formatResults(data), "Excel 工作台已加载");
      await refreshAll();
    } catch (error) {
      setOutput(`ERROR\n${error.message}`, "打开 Excel 工作台失败");
    }
  }

  async function openExcelWorkbenchForPath(path, source) {
    $("#binaryPath").value = path;
    await loadExcelWorkbench(source === undefined ? view.excel : source);
  }

  async function openExcelCandidate(candidate) {
    if (!candidate?.choices) {
      setOutput("ERROR\n缺少 Excel 选择记录路径。", "查看表格选择记录失败");
      return;
    }

    setOutput("正在读取表格选择记录...", "查看表格选择记录");
    try {
      const choiceData = await request("/api/backup-file/read", {
        method: "POST",
        body: JSON.stringify({ path: candidate.choices })
      });
      setOutput([
        `候选合并文件: ${candidate.candidate}`,
        `选择记录: ${candidate.choices}`,
        `最终确认后放回: ${candidate.finalPath}`,
        "",
        choiceData.content || "(空文件)"
      ].join("\n"), "表格选择记录已打开");
    } catch (error) {
      setOutput(`ERROR\n${error.message}`, "查看表格选择记录失败");
    }
  }

  async function previewExcelCandidate(candidate) {
    if (!candidate?.candidate) {
      setOutput("ERROR\n缺少 Excel 候选文件路径。", "预览最终表格失败");
      return;
    }

    setOutput("正在读取候选合并文件...", "预览最终表格");
    try {
      const data = await request("/api/excel-candidate/preview", {
        method: "POST",
        body: JSON.stringify({
          path: candidate.path,
          candidate: candidate.candidate,
          choices: candidate.choices,
          finalPath: candidate.finalPath
        })
      });
      loadExcelPreviewResponse(data);
      setOutput([
        `候选合并文件: ${candidate.candidate}`,
        `最终确认后放回: ${candidate.finalPath}`,
        "",
        "已打开只读最终表格预览。"
      ].join("\n"), "最终表格预览已打开");
    } catch (error) {
      setOutput(`ERROR\n${error.message}`, "预览最终表格失败");
    }
  }

  async function writeExcelCandidate() {
    if (!view.excel) {
      setOutput("ERROR\n请先打开 Excel 合并工作台。", "生成候选失败");
      return;
    }
    if (view.excel.structureMismatch) {
      setOutput("ERROR\nsheet 结构不一致，禁止生成候选文件。", "生成候选失败");
      return;
    }
    const choices = choicePayload();
    setOutput("正在生成候选合并文件...", "生成候选合并文件");
    try {
      const data = await request("/api/excel-conflict/write-candidate", {
        method: "POST",
        body: JSON.stringify({
          path: view.excel.path,
          base: view.excel.base,
          ours: view.excel.ours,
          theirs: view.excel.theirs,
          choices
        })
      });
      $("#binaryBox").textContent = [
        `候选合并文件: ${data.excelCandidate.candidate}`,
        `选择记录: ${data.excelCandidate.choices}`,
        `最终确认后手工放回: ${data.excelCandidate.finalPath}`,
        `本次应用选择: ${choiceSummary(data.excelCandidate.appliedChoices || choices)}`,
        candidatePreviewSummary(data.excelCandidate.preview),
        "guard 未覆盖原路径，未 git add。"
      ].filter(Boolean).join("\n");
      setOutput(formatResults(data), "候选合并文件已生成");
      await previewExcelCandidate(data.excelCandidate);
      $("#binaryBox").textContent = [
        `候选合并文件: ${data.excelCandidate.candidate}`,
        `选择记录: ${data.excelCandidate.choices}`,
        `最终确认后手工放回: ${data.excelCandidate.finalPath}`,
        "",
        "本次应用选择:",
        choiceSummary(data.excelCandidate.appliedChoices || choices),
        "",
        candidatePreviewSummary(data.excelCandidate.preview),
        "guard 未覆盖原路径，未 git add。"
      ].filter(Boolean).join("\n");
      await refreshAll();
    } catch (error) {
      setOutput(`ERROR\n${error.message}`, "生成候选失败");
    }
  }

  return {
    openExcelWorkbenchForPath,
    openExcelCandidate,
    previewExcelCandidate,
    resetExcelChoices,
    writeExcelCandidate
  };
}
