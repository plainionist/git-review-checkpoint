import * as vscode from "vscode";
import { ReviewState } from "./reviewModel";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function lineClass(line: string): string {
  if (line.startsWith("diff --git ")) {
    return "file-header";
  }
  if (line.startsWith("@@")) {
    return "hunk";
  }
  if (line.startsWith("+++ ") || line.startsWith("--- ")) {
    return "path";
  }
  if (line.startsWith("+") && !line.startsWith("+++ ")) {
    return "add";
  }
  if (line.startsWith("-") && !line.startsWith("--- ")) {
    return "delete";
  }
  if (
    line.startsWith("index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ")
  ) {
    return "meta";
  }
  return "context";
}

function renderDiff(diff: string): string {
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

    const cssClass = lineClass(line);
    chunks.push(
      `<span class="line ${cssClass}">${escapeHtml(line === "" ? " " : line)}</span>`
    );
  }

  if (inBlock) {
    chunks.push("</pre></section>");
  }

  return chunks.join("");
}

function nonce(): string {
  return Math.random().toString(36).slice(2);
}

export class DiffWebviewController implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly approveSelectedCommit: (commitHash: string) => Promise<void>,
    private readonly openSideBySideDiff: () => Promise<void>,
    private readonly openInlineDiff: () => Promise<void>
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

  public show(state: ReviewState, diff: string): void {
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

      this.panel.webview.onDidReceiveMessage(async (message: { command?: string; commitHash?: string }) => {
        if (message.command === "approve" && message.commitHash) {
          await this.approveSelectedCommit(message.commitHash);
        } else if (message.command === "openSideBySideDiff") {
          await this.openSideBySideDiff();
        } else if (message.command === "openInlineDiff") {
          await this.openInlineDiff();
        }
      }, undefined, this.disposables);
    } else {
      this.panel.reveal(vscode.ViewColumn.Active);
      this.panel.title = `Review Diff: ${state.selectedCommit.shortHash}`;
    }

    this.panel.webview.html = this.renderHtml(state, diff);
  }

  private renderHtml(state: ReviewState, diff: string): string {
    const selectedCommit = state.selectedCommit;
    if (!selectedCommit || !this.panel) {
      return "";
    }

    const scriptNonce = nonce();
    const stylesUri = this.panel.webview.asWebviewUri(
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
      state.status === "ready"
        ? '<button id="approve">Approve up to selected commit</button>'
        : "";
    const fileDiffButtons =
      state.changedFiles.length > 0 && state.comparisonBaseRef
        ? `<button id="openSideBySideDiff">Open side-by-side file diff</button>
    <button id="openInlineDiff">Open inline file diff</button>`
        : "";
    const approveScript =
      state.status === "ready"
        ? `document.getElementById("approve")?.addEventListener("click", () => {
      vscodeApi.postMessage({
        command: "approve",
        commitHash: ${JSON.stringify(selectedCommit.hash)}
      });
    });`
        : "";
    const fileDiffScript =
      state.changedFiles.length > 0 && state.comparisonBaseRef
        ? `document.getElementById("openSideBySideDiff")?.addEventListener("click", () => {
      vscodeApi.postMessage({ command: "openSideBySideDiff" });
    });
    document.getElementById("openInlineDiff")?.addEventListener("click", () => {
      vscodeApi.postMessage({ command: "openInlineDiff" });
    });`
        : "";

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
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .summary h1 {
      margin: 0 0 6px;
      font-size: 1.2rem;
    }
    .summary p {
      margin: 2px 0;
      color: var(--vscode-descriptionForeground);
    }
    button {
      border: none;
      border-radius: 4px;
      padding: 8px 12px;
      cursor: pointer;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .file {
      margin-bottom: 16px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
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
    .spacer {
      flex: 1;
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
    <div class="spacer"></div>
    ${fileDiffButtons}
    ${approveButton}
  </div>
  <img class="icon" src="${stylesUri}" alt="">
  ${renderDiff(diff)}
  <script nonce="${scriptNonce}">
    const vscodeApi = acquireVsCodeApi();
    ${approveScript}
    ${fileDiffScript}
  </script>
</body>
</html>`;
  }
}
