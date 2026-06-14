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
  metadata: string[];
  rows: ParsedCompactRow[];
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
  if (!diff.trim()) {
    return `<div class="empty">No changed hunks in the selected review range.</div>`;
  }

  const lines = diff.replace(/\r/g, "").split("\n");
  const chunks: string[] = [];
  let inBlock = false;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (inBlock) {
        chunks.push("</pre></section>");
      }
      chunks.push('<section class="file"><pre>');
      inBlock = true;
    }

    const cssClass = line.startsWith("diff --git ")
      ? "file-header"
      : line.startsWith("@@")
        ? "hunk"
        : line.startsWith("+++ ") || line.startsWith("--- ")
          ? "path"
          : line.startsWith("+") && !line.startsWith("+++ ")
            ? "add"
            : line.startsWith("-") && !line.startsWith("--- ")
              ? "delete"
              : line.startsWith("index ") ||
                  line.startsWith("rename from ") ||
                  line.startsWith("rename to ") ||
                  line.startsWith("new file mode ") ||
                  line.startsWith("deleted file mode ")
                ? "meta"
                : "context";

    chunks.push(
      `<span class="line ${cssClass}">${escapeHtml(line === "" ? " " : line)}</span>`
    );
  }

  if (inBlock) {
    chunks.push("</pre></section>");
  }

  return chunks.join("");
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
        metadata: [],
        rows: []
      };
      inHunk = false;
      continue;
    }

    if (!current) {
      continue;
    }

    if (
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ") ||
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ")
    ) {
      current.metadata.push(line);
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
      const metadata = file.metadata.length > 0
        ? `<div class="meta-block">${file.metadata
            .map((line) => `<div>${escapeHtml(line)}</div>`)
            .join("")}</div>`
        : "";

      const rows = file.rows
        .map((row) => {
          if (row.kind === "hunk") {
            return `<tr class="hunk-row"><td colspan="2">${escapeHtml(row.text ?? "")}</td></tr>`;
          }

          return `<tr>
  <td class="${row.leftClass ?? "context"}">${escapeHtml(row.leftText ?? " ")}</td>
  <td class="${row.rightClass ?? "context"}">${escapeHtml(row.rightText ?? " ")}</td>
</tr>`;
        })
        .join("");

      return `<section class="file">
  <div class="file-title">${escapeHtml(file.title)}</div>
  ${metadata}
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

function renderFullSideBySide(files: readonly FullDiffFile[]): string {
  if (files.length === 0) {
    return `<div class="empty">No changed files in the selected review range.</div>`;
  }

  return files
    .map((file) => {
      const leftLines = file.leftContent.replace(/\r/g, "").split("\n");
      const rightLines = file.rightContent.replace(/\r/g, "").split("\n");
      const rowCount = Math.max(leftLines.length, rightLines.length);
      const rows: string[] = [];

      for (let index = 0; index < rowCount; index += 1) {
        const left = leftLines[index] ?? "";
        const right = rightLines[index] ?? "";
        const changed = left !== right;
        rows.push(`<tr>
  <td class="${changed ? "changed" : "context"}">${escapeHtml(left || " ")}</td>
  <td class="${changed ? "changed" : "context"}">${escapeHtml(right || " ")}</td>
</tr>`);
      }

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
      ${rows.join("")}
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
  return `<button id="${id}" class="${mode === activeMode ? "active" : ""}">${label}</button>`;
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
        ? '<button class="approve" id="approve">Approve</button>'
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
    .meta-block {
      padding: 8px 12px;
      color: var(--vscode-descriptionForeground);
      border-top: 1px solid var(--vscode-panel-border);
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
    .path, .meta {
      color: var(--vscode-descriptionForeground);
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
      ${renderModeButton("mode-full", "side-by-side (full)", "sideBySideFull", content.mode)}
      ${renderModeButton("mode-compact", "side-by-side", "sideBySideCompact", content.mode)}
    </div>
  </div>
  <img class="icon" src="${iconUri}" alt="">
  ${body}
  <script nonce="${scriptNonce}">
    const vscodeApi = acquireVsCodeApi();
    document.getElementById("approve")?.addEventListener("click", () => {
      vscodeApi.postMessage({
        command: "approve",
        commitHash: ${JSON.stringify(selectedCommit.hash)}
      });
    });
    document.getElementById("mode-inline")?.addEventListener("click", () => {
      vscodeApi.postMessage({ command: "setMode", mode: "inline" });
    });
    document.getElementById("mode-full")?.addEventListener("click", () => {
      vscodeApi.postMessage({ command: "setMode", mode: "sideBySideFull" });
    });
    document.getElementById("mode-compact")?.addEventListener("click", () => {
      vscodeApi.postMessage({ command: "setMode", mode: "sideBySideCompact" });
    });
  </script>
</body>
</html>`;
  }
}
