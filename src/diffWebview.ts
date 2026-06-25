import * as vscode from "vscode";
import { ReviewState } from "./reviewModel";

export type DiffRenderMode = "inline" | "sideBySideCompact" | "sideBySideFull";

export interface FullDiffFile {
  displayPath: string;
  openPath: string;
  status: string;
  leftContent: string;
  rightContent: string;
}

export interface ReviewDiffContent {
  mode: DiffRenderMode;
  ignoreWhitespace: boolean;
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
  openPath?: string;
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

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function nonce(): string {
  return Math.random().toString(36).slice(2);
}

// ----- Intra-line (character-level) diff helpers -----

const MAX_INTRA_LINE_TOKENS = 500;

interface CharSegment {
  text: string;
  highlight: boolean;
}

function tokenizeLine(line: string): string[] {
  return line.match(/\w+|\W+/g) ?? [];
}

function computeIntraLineDiff(
  left: string,
  right: string
): { leftSegs: CharSegment[]; rightSegs: CharSegment[] } {
  if (!left || !right) {
    return {
      leftSegs: [{ text: left, highlight: false }],
      rightSegs: [{ text: right, highlight: false }]
    };
  }

  const leftTokens = tokenizeLine(left);
  const rightTokens = tokenizeLine(right);

  if (leftTokens.length > MAX_INTRA_LINE_TOKENS || rightTokens.length > MAX_INTRA_LINE_TOKENS) {
    return {
      leftSegs: [{ text: left, highlight: false }],
      rightSegs: [{ text: right, highlight: false }]
    };
  }

  const m = leftTokens.length;
  const n = rightTokens.length;
  const dp = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0)
  );

  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (leftTokens[i] === rightTokens[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const leftSegs: CharSegment[] = [];
  const rightSegs: CharSegment[] = [];
  let i = 0;
  let j = 0;

  while (i < m || j < n) {
    if (i < m && j < n && leftTokens[i] === rightTokens[j]) {
      appendCharSeg(leftSegs, leftTokens[i], false);
      appendCharSeg(rightSegs, rightTokens[j], false);
      i += 1;
      j += 1;
    } else if (j >= n || (i < m && dp[i + 1][j] >= dp[i][j + 1])) {
      appendCharSeg(leftSegs, leftTokens[i], true);
      i += 1;
    } else {
      appendCharSeg(rightSegs, rightTokens[j], true);
      j += 1;
    }
  }

  return { leftSegs, rightSegs };
}

function appendCharSeg(segs: CharSegment[], char: string, highlight: boolean): void {
  if (segs.length > 0 && segs[segs.length - 1].highlight === highlight) {
    segs[segs.length - 1].text += char;
  } else {
    segs.push({ text: char, highlight });
  }
}

function renderSegments(segs: CharSegment[], highlightClass: string): string {
  return segs
    .map((seg) =>
      seg.highlight
        ? `<span class="${highlightClass}">${escapeHtml(seg.text)}</span>`
        : escapeHtml(seg.text)
    )
    .join("");
}

function renderFileTitle(title: string, status?: string, openPath?: string): string {
  const statusMarkup = status
    ? ` <span class="status">${escapeHtml(status)}</span>`
    : "";
  const openButtonMarkup = `<button type="button" class="file-open" data-command="openFile"${
    openPath ? ` data-path="${escapeHtmlAttribute(openPath)}"` : " disabled"
  }>Open in Editor</button>`;

  return `<div class="file-title"><span>${escapeHtml(title)}${statusMarkup}</span>${openButtonMarkup}</div>`;
}

function renderInlineRows(rows: readonly ParsedCompactRow[]): string {
  const spans: string[] = [];
  let index = 0;

  while (index < rows.length) {
    const row = rows[index];

    if (row.kind === "hunk") {
      spans.push(`<span class="line hunk">${escapeHtml(row.text ?? "")}</span>`);
      index += 1;
      continue;
    }

    if (row.leftClass === "delete") {
      const deleteRows: ParsedCompactRow[] = [];
      while (index < rows.length && rows[index].kind === "line" && rows[index].leftClass === "delete") {
        deleteRows.push(rows[index]);
        index += 1;
      }

      const addRows: ParsedCompactRow[] = [];
      while (index < rows.length && rows[index].kind === "line" && rows[index].rightClass === "add") {
        addRows.push(rows[index]);
        index += 1;
      }

      for (let pairIndex = 0; pairIndex < deleteRows.length; pairIndex += 1) {
        const deleteRow = deleteRows[pairIndex];
        const addRow = addRows[pairIndex];
        const deleteText = deleteRow.leftText ?? "";
        const addText = addRow?.rightText ?? "";

        if (addRow && deleteText && addText) {
          const { leftSegs, rightSegs } = computeIntraLineDiff(deleteText, addText);
          spans.push(`<span class="line delete">-${renderSegments(leftSegs, "delete-char")}</span>`);
          spans.push(`<span class="line add">+${renderSegments(rightSegs, "add-char")}</span>`);
        } else {
          spans.push(`<span class="line delete">-${escapeHtml(deleteText)}</span>`);
        }
      }

      for (let addIndex = deleteRows.length; addIndex < addRows.length; addIndex += 1) {
        spans.push(`<span class="line add">+${escapeHtml(addRows[addIndex]?.rightText ?? "")}</span>`);
      }

      continue;
    }

    if (row.rightClass === "add") {
      spans.push(`<span class="line add">+${escapeHtml(row.rightText ?? "")}</span>`);
      index += 1;
      continue;
    }

    spans.push(`<span class="line context"> ${escapeHtml(row.leftText ?? "")}</span>`);
    index += 1;
  }

  return spans.join("");
}

function renderInlineDiff(diff: string): string {
  const files = parseCompactDiff(diff);
  if (files.length === 0) {
    return `<div class="empty">No changed hunks in the selected review range.</div>`;
  }

  return files
    .map((file) => {
      const lines = renderInlineRows(file.rows);

        return `<section class="file">
      ${renderFileTitle(file.title, undefined, file.openPath)}
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
        openPath: match?.[2],
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
  ${renderFileTitle(file.title, undefined, file.openPath)}
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
          const leftText = deleteRow?.leftText ?? "";
          const rightText = addRow?.rightText ?? "";

          let leftContent: string;
          let rightContent: string;
          if (deleteRow && addRow && leftText && rightText) {
            const { leftSegs, rightSegs } = computeIntraLineDiff(leftText, rightText);
            leftContent = renderSegments(leftSegs, "delete-char") || " ";
            rightContent = renderSegments(rightSegs, "add-char") || " ";
          } else {
            leftContent = escapeHtml(leftText || " ");
            rightContent = escapeHtml(rightText || " ");
          }

          htmlRows.push(`<tr>
  <td class="${deleteRow ? "delete" : "blank"}">${leftContent}</td>
  <td class="${addRow ? "add" : "blank"}">${rightContent}</td>
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

function normalizeWhitespaceForCompare(line: string): string {
  return line.replace(/\s+/g, "");
}

function buildAlignedFullRows(
  leftLines: string[],
  rightLines: string[],
  ignoreWhitespace: boolean
): FullDiffRow[] {
  const leftKeys = ignoreWhitespace
    ? leftLines.map(normalizeWhitespaceForCompare)
    : leftLines;
  const rightKeys = ignoreWhitespace
    ? rightLines.map(normalizeWhitespaceForCompare)
    : rightLines;

  const totalCells = leftLines.length * rightLines.length;
  if (totalCells <= MAX_EXACT_DIFF_CELLS) {
    return coalesceReplacementRows(
      buildAlignedFullRowsExact(leftLines, rightLines, leftKeys, rightKeys)
    );
  }

  return coalesceReplacementRows(
    buildAlignedFullRowsHeuristic(leftLines, rightLines, leftKeys, rightKeys)
  );
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

function buildAlignedFullRowsExact(
  leftLines: string[],
  rightLines: string[],
  leftKeys: readonly string[],
  rightKeys: readonly string[]
): FullDiffRow[] {
  const leftCount = leftLines.length;
  const rightCount = rightLines.length;
  const dp: number[][] = Array.from({ length: leftCount + 1 }, () =>
    new Array<number>(rightCount + 1).fill(0)
  );

  for (let leftIndex = leftCount - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = rightCount - 1; rightIndex >= 0; rightIndex -= 1) {
      if (leftKeys[leftIndex] === rightKeys[rightIndex]) {
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
    const leftKey = leftKeys[leftIndex];
    const rightKey = rightKeys[rightIndex];

    if (
      leftIndex < leftCount &&
      rightIndex < rightCount &&
      leftKey === rightKey
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

function buildAlignedFullRowsHeuristic(
  leftLines: string[],
  rightLines: string[],
  leftKeys: readonly string[],
  rightKeys: readonly string[]
): FullDiffRow[] {
  const rows: FullDiffRow[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < leftLines.length || rightIndex < rightLines.length) {
    const leftLine = leftLines[leftIndex];
    const rightLine = rightLines[rightIndex];
    const leftKey = leftKeys[leftIndex];
    const rightKey = rightKeys[rightIndex];

    if (
      leftIndex < leftLines.length &&
      rightIndex < rightLines.length &&
      leftKey === rightKey
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
        ? findLookaheadMatch(rightKeys, rightIndex + 1, leftKey ?? "", HEURISTIC_LOOKAHEAD)
        : -1;
    const leftMatch =
      rightIndex < rightLines.length
        ? findLookaheadMatch(leftKeys, leftIndex + 1, rightKey ?? "", HEURISTIC_LOOKAHEAD)
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

function renderFullSideBySide(
  files: readonly FullDiffFile[],
  ignoreWhitespace: boolean
): string {
  if (files.length === 0) {
    return `<div class="empty">No changed files in the selected review range.</div>`;
  }

  return files
    .map((file) => {
      const leftLines = file.leftContent.replace(/\r/g, "").split("\n");
      const rightLines = file.rightContent.replace(/\r/g, "").split("\n");
      const rows = buildAlignedFullRows(leftLines, rightLines, ignoreWhitespace)
        .map((row) => {
          let leftContent: string;
          let rightContent: string;

          if (row.leftClass === "delete" && row.rightClass === "add" && row.leftText && row.rightText) {
            const { leftSegs, rightSegs } = computeIntraLineDiff(row.leftText, row.rightText);
            leftContent = renderSegments(leftSegs, "delete-char") || " ";
            rightContent = renderSegments(rightSegs, "add-char") || " ";
          } else {
            leftContent = escapeHtml(row.leftText || " ");
            rightContent = escapeHtml(row.rightText || " ");
          }

          return `<tr>
  <td class="${row.leftClass}">${leftContent}</td>
  <td class="${row.rightClass}">${rightContent}</td>
</tr>`;
        })
        .join("");

        return `<section class="file">
      ${renderFileTitle(file.displayPath, file.status, file.openPath)}
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

function renderLoadingBody(): string {
  return `<div class="loading-state" role="status" aria-live="polite" aria-label="Loading diff">
  <div class="spinner" aria-hidden="true"></div>
  <div class="loading-text">Loading diff...</div>
</div>`;
}

function renderModeOption(mode: DiffRenderMode, label: string, activeMode: DiffRenderMode): string {
  const selected = mode === activeMode ? ' selected="selected"' : "";
  return `<option value="${mode}"${selected}>${label}</option>`;
}

export class DiffWebviewController implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly approveSelectedCommit: (commitHash: string) => Promise<void>,
    private readonly setRenderMode: (mode: DiffRenderMode) => Promise<void>,
    private readonly setIgnoreWhitespace: (ignoreWhitespace: boolean) => Promise<void>,
    private readonly openFileInEditor: (path: string) => Promise<void>
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

  public showLoading(
    state: ReviewState,
    mode: DiffRenderMode,
    ignoreWhitespace: boolean
  ): void {
    if (!state.selectedCommit) {
      return;
    }

    this.ensurePanel(state);
    this.panel!.webview.html = this.renderHtml(
      state,
      {
        mode,
        ignoreWhitespace
      },
      true
    );
  }

  public show(state: ReviewState, content: ReviewDiffContent): void {
    if (!state.selectedCommit) {
      return;
    }

    this.ensurePanel(state);
    this.panel!.webview.html = this.renderHtml(state, content, false);
  }

  private ensurePanel(state: ReviewState): void {
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
        async (message: {
          command?: string;
          commitHash?: string;
          mode?: DiffRenderMode;
          ignoreWhitespace?: boolean;
          path?: string;
        }) => {
          if (message.command === "approve" && message.commitHash) {
            await this.approveSelectedCommit(message.commitHash);
          } else if (message.command === "setMode" && message.mode) {
            await this.setRenderMode(message.mode);
          } else if (
            message.command === "setIgnoreWhitespace" &&
            typeof message.ignoreWhitespace === "boolean"
          ) {
            await this.setIgnoreWhitespace(message.ignoreWhitespace);
          } else if (message.command === "openFile" && message.path) {
            await this.openFileInEditor(message.path);
          }
        },
        undefined,
        this.disposables
      );
    } else {
      this.panel.reveal(vscode.ViewColumn.Active);
      this.panel.title = `Review Diff: ${state.selectedCommit.shortHash}`;
    }
  }

  private renderHtml(
    state: ReviewState,
    content: ReviewDiffContent,
    isLoading: boolean
  ): string {
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

    const body = isLoading
      ? renderLoadingBody()
      : content.mode === "inline"
        ? renderInlineDiff(content.diffText ?? "")
        : content.mode === "sideBySideCompact"
          ? renderCompactSideBySide(content.diffText ?? "")
          : renderFullSideBySide(content.fullFiles ?? [], content.ignoreWhitespace);

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
      --review-add-line-bg: color-mix(in srgb, var(--vscode-diffEditor-insertedLineBackground, rgba(0, 255, 0, 0.12)) 82%, transparent);
      --review-delete-line-bg: color-mix(in srgb, var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, 0.12)) 82%, transparent);
      --review-add-char-bg: color-mix(in srgb, var(--vscode-diffEditor-insertedTextBackground, rgba(0, 180, 0, 0.45)) 92%, transparent);
      --review-delete-char-bg: color-mix(in srgb, var(--vscode-diffEditor-removedTextBackground, rgba(200, 0, 0, 0.45)) 92%, transparent);
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
    .toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--vscode-foreground);
      font-size: 0.85rem;
    }
    .toggle input {
      margin: 0;
    }
    select {
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
      border-radius: 4px;
      padding: 4px 8px;
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
      background: var(--vscode-dropdown-background, var(--vscode-editor-background));
      font-size: 0.85rem;
    }
    select:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 0;
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
    .file + .file {
      margin-top: 24px;
    }
    .file-title {
      background: var(--vscode-editorInfo-background, var(--vscode-editor-inactiveSelectionBackground));
      border-bottom: 1px solid var(--vscode-editorInfo-border, var(--vscode-panel-border));
      padding: 14px 16px;
      font-weight: 600;
      font-size: 1.05rem;
      line-height: 1.35;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .file-open {
      padding: 2px 8px;
      font-size: 0.8rem;
    }
    .status {
      color: var(--vscode-descriptionForeground);
      font-weight: 400;
      font-size: 0.9rem;
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
      background: var(--review-add-line-bg);
      color: var(--vscode-diffEditor-insertedTextForeground, var(--vscode-foreground));
    }
    .delete {
      background: var(--review-delete-line-bg);
      color: var(--vscode-diffEditor-removedTextForeground, var(--vscode-foreground));
    }
    .empty {
      padding: 24px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      color: var(--vscode-descriptionForeground);
    }
    .loading-state {
      min-height: 220px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
    }
    .spinner {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: 3px solid var(--vscode-progressBar-background, var(--vscode-descriptionForeground));
      border-right-color: transparent;
      animation: spin 0.75s linear infinite;
    }
    .loading-text {
      font-size: 0.95rem;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
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
      background: var(--review-add-line-bg);
    }
    .side-table td.add {
      background: var(--review-add-line-bg);
    }
    .side-table td.delete {
      background: var(--review-delete-line-bg);
    }
    .hunk-row td {
      background: var(--vscode-diffEditor-diagonalFill);
      color: var(--vscode-editorInfo-foreground);
      font-weight: 600;
    }
    .delete-char {
      background: var(--review-delete-char-bg);
      border-radius: 1px;
    }
    .add-char {
      background: var(--review-add-char-bg);
      border-radius: 1px;
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
      <label class="toggle" for="ignore-whitespace">
        <input type="checkbox" id="ignore-whitespace" ${content.ignoreWhitespace ? 'checked="checked"' : ""}>
        <span>Ignore whitespaces</span>
      </label>
      <select id="diff-mode" aria-label="Diff mode">
        ${renderModeOption("inline", "Inline", content.mode)}
        ${renderModeOption("sideBySideCompact", "Side-by-side", content.mode)}
        ${renderModeOption("sideBySideFull", "Side-by-side (full)", content.mode)}
      </select>
    </div>
  </div>
  <img class="icon" src="${iconUri}" alt="">
  ${body}
  <script nonce="${scriptNonce}">
    const vscodeApi = acquireVsCodeApi();
    const modeSelect = document.getElementById("diff-mode");
    if (modeSelect instanceof HTMLSelectElement) {
      modeSelect.addEventListener("change", () => {
        vscodeApi.postMessage({ command: "setMode", mode: modeSelect.value });
      });
    }

    const ignoreWhitespaceToggle = document.getElementById("ignore-whitespace");
    if (ignoreWhitespaceToggle instanceof HTMLInputElement) {
      ignoreWhitespaceToggle.addEventListener("change", () => {
        vscodeApi.postMessage({
          command: "setIgnoreWhitespace",
          ignoreWhitespace: ignoreWhitespaceToggle.checked
        });
      });
    }

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

      if (command === "approve") {
        vscodeApi.postMessage({
          command: "approve",
          commitHash: ${JSON.stringify(selectedCommit.hash)}
        });
      } else if (command === "openFile") {
        const path = button.dataset.path;
        if (path) {
          vscodeApi.postMessage({
            command: "openFile",
            path
          });
        }
      }
    });
  </script>
</body>
</html>`;
  }
}
