import * as vscode from "vscode";
import { ReviewState } from "./reviewModel";

export type DiffRenderMode = "inline" | "sideBySideCompact" | "sideBySideFull";

export interface FullDiffFile {
  displayPath: string;
  status: string;
  leftContent: string;
  rightContent: string;
}

export interface ReviewDiffContent {
  mode: DiffRenderMode;
  diffText?: string;
  fullFiles?: FullDiffFile[];
}

interface ParsedCompactRow {
  kind: "hunk" | "line";
  text?: string;
  leftText?: string;
  rightText?: string;
  leftClass?: string;
  rightClass?: string;
}

interface ParsedCompactFile {
  title: string;
  rows: ParsedCompactRow[];
}

interface FullDiffRow {
  leftText: string;
  rightText: string;
  leftClass: "context" | "blank" | "delete";
  rightClass: "context" | "blank" | "add";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function nonce(): string {
  return Math.random().toString(36).slice(2);
}

function renderInlineDiff(diff: string): string {
  const files = parseCompactDiff(diff);
  if (files.length === 0) {
    return `<div class="empty">No changed hunks in the selected review range.</div>`;
  }

  return files
    .map((file) => {
      const lines = file.rows
        .map((row) => {
          if (row.kind === "hunk") {
            return `<span class="line hunk">${escapeHtml(row.text ?? "")}</span>`;
          }

          if (row.leftClass === "delete") {
            return `<span class="line delete">-${escapeHtml(row.leftText ?? "")}</span>`;
          }

          if (row.rightClass === "add") {
            return `<span class="line add">+${escapeHtml(row.rightText ?? "")}</span>`;
          }

          return `<span class="line context"> ${escapeHtml(row.leftText ?? "")}</span>`;
        })
        .join("");

      return `<section class="file">
  <div class="file-title">${escapeHtml(file.title)}</div>
  <pre>${lines}</pre>
</section>`;
    })
    .join("");
}

function parseCompactDiff(diff: string): ParsedCompactFile[] {
  if (!diff.trim()) {
    return [];
  }

  const files: ParsedCompactFile[] = [];
  const lines = diff.replace(/\r/g, "").split("\n");
  let current: ParsedCompactFile | undefined;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) {
        files.push(current);
      }

      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const title = match
        ? match[1] === match[2]
          ? match[2]
          : `${match[1]} -> ${match[2]}`
        : line;

      current = {
        title,
        rows: []
      };
      inHunk = false;
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("@@")) {
      current.rows.push({
        kind: "hunk",
        text: line
      });
      inHunk = true;
      continue;
    }

    if (!inHunk || line === "\\ No newline at end of file") {
      continue;
    }

    if (line.startsWith(" ")) {
      const content = line.slice(1);
      current.rows.push({
        kind: "line",
        leftText: content,
        rightText: content,
        leftClass: "context",
        rightClass: "context"
      });
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("--- ")) {
      current.rows.push({
        kind: "line",
        leftText: line.slice(1),
        rightText: "",
        leftClass: "delete",
        rightClass: "blank"
      });
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++ ")) {
      current.rows.push({
        kind: "line",
        leftText: "",
        rightText: line.slice(1),
        leftClass: "blank",
        rightClass: "add"
      });
    }
  }

  if (current) {
    files.push(current);
  }

  return files;
}

function renderCompactSideBySide(diff: string): string {
  const files = parseCompactDiff(diff);
  if (files.length === 0) {
    return `<div class="empty">No changed hunks in the selected review range.</div>`;
  }

  return files
    .map((file) => {
      const rows = renderCompactRows(file.rows);

      return `<section class="file">
  <div class="file-title">${escapeHtml(file.title)}</div>
  <table class="side-table">
    <thead>
      <tr>
        <th>Base</th>
        <th>Selected</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</section>`;
    })
    .join("");
}

function renderCompactRows(rows: readonly ParsedCompactRow[]): string {
  const htmlRows: string[] = [];
  let index = 0;

  while (index < rows.length) {
    const row = rows[index];
    if (row.kind === "hunk") {
      htmlRows.push(`<tr class="hunk-row"><td colspan="2">${escapeHtml(row.text ?? "")}</td></tr>`);
      index += 1;
      continue;
    }

    if (isCompactDeleteOnlyRow(row)) {
      const deleteRows: ParsedCompactRow[] = [];
      while (index < rows.length && isCompactDeleteOnlyRow(rows[index])) {
        deleteRows.push(rows[index]);
        index += 1;
      }

      const addRows: ParsedCompactRow[] = [];
      while (index < rows.length && isCompactAddOnlyRow(rows[index])) {
        addRows.push(rows[index]);
        index += 1;
      }

      if (addRows.length > 0) {
        const pairCount = Math.max(deleteRows.length, addRows.length);
        for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
          const deleteRow = deleteRows[pairIndex];
          const addRow = addRows[pairIndex];
          htmlRows.push(`<tr>
  <td class="${deleteRow ? "delete" : "blank"}">${escapeHtml(deleteRow?.leftText ?? " ")}</td>
  <td class="${addRow ? "add" : "blank"}">${escapeHtml(addRow?.rightText ?? " ")}</td>
</tr>`);
        }
        continue;
      }

      for (const deleteRow of deleteRows) {
        htmlRows.push(`<tr>
  <td class="delete">${escapeHtml(deleteRow.leftText ?? " ")}</td>
  <td class="blank"> </td>
</tr>`);
      }
      continue;
    }

    htmlRows.push(`<tr>
  <td class="${row.leftClass ?? "context"}">${escapeHtml(row.leftText ?? " ")}</td>
  <td class="${row.rightClass ?? "context"}">${escapeHtml(row.rightText ?? " ")}</td>
</tr>`);
    index += 1;
  }

  return htmlRows.join("");
}

function isCompactDeleteOnlyRow(row: ParsedCompactRow): boolean {
  return (
    row.kind === "line" &&
    row.leftClass === "delete" &&
    row.rightClass === "blank"
  );
}

function isCompactAddOnlyRow(row: ParsedCompactRow): boolean {
  return (
    row.kind === "line" &&
    row.leftClass === "blank" &&
    row.rightClass === "add"
  );
}

const MAX_EXACT_DIFF_CELLS = 4_000_000;
const HEURISTIC_LOOKAHEAD = 80;

function buildAlignedFullRows(leftLines: string[], rightLines: string[]): FullDiffRow[] {
  const totalCells = leftLines.length * rightLines.length;
  if (totalCells <= MAX_EXACT_DIFF_CELLS) {
    return coalesceReplacementRows(buildAlignedFullRowsExact(leftLines, rightLines));
  }

  return coalesceReplacementRows(buildAlignedFullRowsHeuristic(leftLines, rightLines));
}

function coalesceReplacementRows(rows: readonly FullDiffRow[]): FullDiffRow[] {
  const result: FullDiffRow[] = [];

  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (!isDeleteOnlyRow(row)) {
      result.push(row);
      index += 1;
      continue;
    }

    const deleteRows: FullDiffRow[] = [];
    while (index < rows.length && isDeleteOnlyRow(rows[index])) {
      deleteRows.push(rows[index]);
      index += 1;
    }

    const addRows: FullDiffRow[] = [];
    while (index < rows.length && isAddOnlyRow(rows[index])) {
      addRows.push(rows[index]);
      index += 1;
    }

    if (addRows.length === 0) {
      result.push(...deleteRows);
      continue;
    }

    const pairCount = Math.max(deleteRows.length, addRows.length);
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
      const deleteRow = deleteRows[pairIndex];
      const addRow = addRows[pairIndex];
      result.push({
        leftText: deleteRow?.leftText ?? "",
        rightText: addRow?.rightText ?? "",
        leftClass: deleteRow ? "delete" : "blank",
        rightClass: addRow ? "add" : "blank"
      });
    }
  }

  return result;
}

function isDeleteOnlyRow(row: FullDiffRow): boolean {
  return row.leftClass === "delete" && row.rightClass === "blank";
}

function isAddOnlyRow(row: FullDiffRow): boolean {
  return row.leftClass === "blank" && row.rightClass === "add";
}

function buildAlignedFullRowsExact(leftLines: string[], rightLines: string[]): FullDiffRow[] {
  const leftCount = leftLines.length;
  const rightCount = rightLines.length;
  const dp: number[][] = Array.from({ length: leftCount + 1 }, () =>
    new Array<number>(rightCount + 1).fill(0)
  );

  for (let leftIndex = leftCount - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = rightCount - 1; rightIndex >= 0; rightIndex -= 1) {
      if (leftLines[leftIndex] === rightLines[rightIndex]) {
        dp[leftIndex][rightIndex] = dp[leftIndex + 1][rightIndex + 1] + 1;
      } else {
        dp[leftIndex][rightIndex] = Math.max(
          dp[leftIndex + 1][rightIndex],
          dp[leftIndex][rightIndex + 1]
        );
      }
    }
  }

  const rows: FullDiffRow[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < leftCount || rightIndex < rightCount) {
    const leftLine = leftLines[leftIndex];
    const rightLine = rightLines[rightIndex];

    if (
      leftIndex < leftCount &&
      rightIndex < rightCount &&
      leftLine === rightLine
    ) {
      rows.push({
        leftText: leftLine,
        rightText: rightLine,
        leftClass: "context",
        rightClass: "context"
      });
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    if (
      rightIndex >= rightCount ||
      (leftIndex < leftCount &&
        dp[leftIndex + 1][rightIndex] >= dp[leftIndex][rightIndex + 1])
    ) {
      rows.push({
        leftText: leftLine ?? "",
        rightText: "",
        leftClass: "delete",
        rightClass: "blank"
      });
      leftIndex += 1;
      continue;
    }

    rows.push({
      leftText: "",
      rightText: rightLine ?? "",
      leftClass: "blank",
      rightClass: "add"
    });
    rightIndex += 1;
  }

  return rows;
}

function buildAlignedFullRowsHeuristic(leftLines: string[], rightLines: string[]): FullDiffRow[] {
  const rows: FullDiffRow[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < leftLines.length || rightIndex < rightLines.length) {
    const leftLine = leftLines[leftIndex];
    const rightLine = rightLines[rightIndex];

    if (
      leftIndex < leftLines.length &&
      rightIndex < rightLines.length &&
      leftLine === rightLine
    ) {
      rows.push({
        leftText: leftLine,
        rightText: rightLine,
        leftClass: "context",
        rightClass: "context"
      });
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    const rightMatch =
      leftIndex < leftLines.length
        ? findLookaheadMatch(rightLines, rightIndex + 1, leftLine ?? "", HEURISTIC_LOOKAHEAD)
        : -1;
    const leftMatch =
      rightIndex < rightLines.length
        ? findLookaheadMatch(leftLines, leftIndex + 1, rightLine ?? "", HEURISTIC_LOOKAHEAD)
        : -1;

    if (
      rightMatch !== -1 &&
      (leftMatch === -1 || rightMatch - rightIndex <= leftMatch - leftIndex)
    ) {
      while (rightIndex < rightMatch) {
        rows.push({
          leftText: "",
          rightText: rightLines[rightIndex],
          leftClass: "blank",
          rightClass: "add"
        });
        rightIndex += 1;
      }
      continue;
    }

    if (leftMatch !== -1) {
      while (leftIndex < leftMatch) {
        rows.push({
          leftText: leftLines[leftIndex],
          rightText: "",
          leftClass: "delete",
          rightClass: "blank"
        });
        leftIndex += 1;
      }
      continue;
    }

    if (leftIndex < leftLines.length) {
      rows.push({
        leftText: leftLines[leftIndex],
        rightText: "",
        leftClass: "delete",
        rightClass: "blank"
      });
      leftIndex += 1;
    }
    if (rightIndex < rightLines.length) {
      rows.push({
        leftText: "",
        rightText: rightLines[rightIndex],
        leftClass: "blank",
        rightClass: "add"
      });
      rightIndex += 1;
    }
  }

  return rows;
}

function findLookaheadMatch(
  lines: readonly string[],
  startIndex: number,
  needle: string,
  lookahead: number
): number {
  const end = Math.min(lines.length, startIndex + lookahead);
  for (let index = startIndex; index < end; index += 1) {
    if (lines[index] === needle) {
      return index;
    }
  }

  return -1;
}

function renderFullSideBySide(files: readonly FullDiffFile[]): string {
  if (files.length === 0) {
    return `<div class="empty">No changed files in the selected review range.</div>`;
  }

  return files
    .map((file) => {
      const leftLines = file.leftContent.replace(/\r/g, "").split("\n");
      const rightLines = file.rightContent.replace(/\r/g, "").split("\n");
      const rows = buildAlignedFullRows(leftLines, rightLines)
        .map(
          (row) => `<tr>
  <td class="${row.leftClass}">${escapeHtml(row.leftText || " ")}</td>
  <td class="${row.rightClass}">${escapeHtml(row.rightText || " ")}</td>
</tr>`
        )
        .join("");

      return `<section class="file">
  <div class="file-title">${escapeHtml(file.displayPath)} <span class="status">${escapeHtml(file.status)}</span></div>
  <table class="side-table full">
    <thead>
      <tr>
        <th>Base</th>
        <th>Selected</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</section>`;
    })
    .join("");
}

function renderModeButton(
  id: string,
  label: string,
  mode: DiffRenderMode,
  activeMode: DiffRenderMode
): string {
  return `<button type="button" id="${id}" data-mode="${mode}" class="${mode === activeMode ? "active" : ""}">${label}</button>`;
}

export class DiffWebviewController implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly approveSelectedCommit: (commitHash: string) => Promise<void>,
    private readonly setRenderMode: (mode: DiffRenderMode) => Promise<void>
  ) {}

  public dispose(): void {
    this.panel?.dispose();
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  public close(): void {
    this.panel?.dispose();
  }

  public show(state: ReviewState, content: ReviewDiffContent): void {
    if (!state.selectedCommit) {
      return;
    }

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "reviewCheckpoint.diff",
        `Review Diff: ${state.selectedCommit.shortHash}`,
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true
        }
      );

      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });

      this.panel.webview.onDidReceiveMessage(
        async (message: { command?: string; commitHash?: string; mode?: DiffRenderMode }) => {
          if (message.command === "approve" && message.commitHash) {
            await this.approveSelectedCommit(message.commitHash);
          } else if (message.command === "setMode" && message.mode) {
            await this.setRenderMode(message.mode);
          }
        },
        undefined,
        this.disposables
      );
    } else {
      this.panel.reveal(vscode.ViewColumn.Active);
      this.panel.title = `Review Diff: ${state.selectedCommit.shortHash}`;
    }

    this.panel.webview.html = this.renderHtml(state, content);
  }

  private renderHtml(state: ReviewState, content: ReviewDiffContent): string {
    const selectedCommit = state.selectedCommit;
    if (!selectedCommit || !this.panel) {
      return "";
    }

    const scriptNonce = nonce();
    const iconUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "resources", "review-checkpoint.svg")
    );

    const comparisonSummary =
      state.status === "missing-checkpoint"
        ? state.comparisonBaseShortHash
          ? `Diff to previous commit: ${escapeHtml(state.comparisonBaseShortHash)}`
          : "No previous commit available."
        : state.comparisonBaseShortHash
          ? `Approved marker: ${escapeHtml(state.comparisonBaseShortHash)}`
          : "Approved marker: missing";

    const reviewRangeSummary = state.reviewRange
      ? `<p>Review range: ${escapeHtml(state.reviewRange)}</p>`
      : "";
    const approveButton =
      state.status !== "error"
        ? '<button type="button" class="approve" data-command="approve">Approve</button>'
        : "";

    const body =
      content.mode === "inline"
        ? renderInlineDiff(content.diffText ?? "")
        : content.mode === "sideBySideCompact"
          ? renderCompactSideBySide(content.diffText ?? "")
          : renderFullSideBySide(content.fullFiles ?? []);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${
    this.panel.webview.cspSource
  } data:; style-src 'unsafe-inline' ${
      this.panel.webview.cspSource
    }; script-src 'nonce-${scriptNonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Review Diff</title>
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 16px;
    }
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 2;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
      align-items: start;
      gap: 12px;
      background: var(--vscode-editor-background);
      margin-bottom: 16px;
      padding-top: 4px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .summary h1 {
      margin: 0 0 6px;
      font-size: 1.2rem;
    }
    .summary {
      min-width: 0;
    }
    .summary p {
      margin: 2px 0;
      color: var(--vscode-descriptionForeground);
    }
    .approve-wrap {
      justify-self: center;
      align-self: center;
    }
    .actions {
      justify-self: end;
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    button {
      border: none;
      border-radius: 4px;
      padding: 4px 8px;
      cursor: pointer;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font-size: 0.85rem;
      line-height: 1.2;
      white-space: nowrap;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button.active {
      outline: 1px solid var(--vscode-focusBorder);
      background: var(--vscode-button-hoverBackground);
    }
    .file {
      margin-bottom: 16px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
    }
    .file-title {
      background: var(--vscode-editor-inactiveSelectionBackground);
      padding: 10px 12px;
      font-weight: 600;
    }
    .status {
      color: var(--vscode-descriptionForeground);
      font-weight: 400;
    }
    pre {
      margin: 0;
      padding: 0;
      white-space: pre-wrap;
      word-break: break-word;
      tab-size: 4;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.45;
    }
    .line {
      display: block;
      padding: 0 12px;
    }
    .file-header {
      background: var(--vscode-editor-inactiveSelectionBackground);
      color: var(--vscode-editor-foreground);
      font-weight: 600;
      padding-top: 10px;
      padding-bottom: 10px;
    }
    .hunk {
      background: var(--vscode-diffEditor-diagonalFill);
      color: var(--vscode-editorInfo-foreground);
    }
    .add {
      background: var(--vscode-diffEditor-insertedLineBackground);
      color: var(--vscode-diffEditor-insertedTextForeground, var(--vscode-foreground));
    }
    .delete {
      background: var(--vscode-diffEditor-removedLineBackground);
      color: var(--vscode-diffEditor-removedTextForeground, var(--vscode-foreground));
    }
    .empty {
      padding: 24px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      color: var(--vscode-descriptionForeground);
    }
    .side-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
    }
    .side-table th,
    .side-table td {
      vertical-align: top;
      text-align: left;
      padding: 4px 10px;
      white-space: pre-wrap;
      word-break: break-word;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .side-table th {
      background: var(--vscode-editor-inactiveSelectionBackground);
      font-weight: 600;
    }
    .side-table td.blank {
      background: var(--vscode-editor-background);
    }
    .side-table td.context {
      background: var(--vscode-editor-background);
    }
    .side-table td.changed {
      background: var(--vscode-diffEditor-insertedLineBackground);
    }
    .side-table td.add {
      background: var(--vscode-diffEditor-insertedLineBackground);
    }
    .side-table td.delete {
      background: var(--vscode-diffEditor-removedLineBackground);
    }
    .hunk-row td {
      background: var(--vscode-diffEditor-diagonalFill);
      color: var(--vscode-editorInfo-foreground);
      font-weight: 600;
    }
    .icon {
      display: none;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="summary">
      <h1>${escapeHtml(selectedCommit.shortHash)} ${escapeHtml(selectedCommit.subject)}</h1>
      <p>${comparisonSummary}</p>
      ${reviewRangeSummary}
      <p>Author: ${escapeHtml(selectedCommit.author)} • ${escapeHtml(selectedCommit.date)}</p>
    </div>
    <div class="approve-wrap">
      ${approveButton}
    </div>
    <div class="actions">
      ${renderModeButton("mode-inline", "inline", "inline", content.mode)}
      ${renderModeButton("mode-compact", "side-by-side", "sideBySideCompact", content.mode)}
      ${renderModeButton("mode-full", "side-by-side (full)", "sideBySideFull", content.mode)}
    </div>
  </div>
  <img class="icon" src="${iconUri}" alt="">
  ${body}
  <script nonce="${scriptNonce}">
    const vscodeApi = acquireVsCodeApi();
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const button = target.closest("button");
      if (!(button instanceof HTMLButtonElement)) {
        return;
      }

      const command = button.dataset.command;
      const mode = button.dataset.mode;

      if (command === "approve") {
        vscodeApi.postMessage({
          command: "approve",
          commitHash: ${JSON.stringify(selectedCommit.hash)}
        });
      } else if (mode) {
        vscodeApi.postMessage({ command: "setMode", mode });
      }
    });
  </script>
</body>
</html>`;
  }
}
