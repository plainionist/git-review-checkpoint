import * as vscode from "vscode";
import {
  ChangedFile,
  GitCommandError,
  PendingCommit,
  POLL_INTERVAL_MS,
  ReviewBranch,
  ensureCommitExists,
  getCompactFileDiff,
  getCompactDiff,
  getRepositoryRoot,
  hasRef,
  initializeApprovedRef,
  isAncestor,
  listPendingCommits,
  readFileAtRevision,
  toShortHash,
  updateApprovedRef
} from "./git";
import {
  DiffRenderMode,
  DiffWebviewController,
  FullDiffFile,
  ReviewDiffContent
} from "./diffWebview";
import { REVIEW_CONTENT_SCHEME, ReviewContentProvider } from "./reviewContentProvider";
import { CommitTreeItem, ReviewTreeDataProvider } from "./reviewView";
import { ReviewState, loadReviewState } from "./reviewModel";

interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

interface GitApi {
  repositories: GitRepositoryApi[];
}

interface GitRepositoryApi {
  rootUri: vscode.Uri;
  state: {
    onDidChange: vscode.Event<void>;
  };
}

interface ReviewDiffCache {
  key: string;
  compactDiff?: string;
  fullFiles?: FullDiffFile[];
}

function buildCompactFilePreview(diff: string): { left: string; right: string } {
  const left: string[] = [];
  const right: string[] = [];
  const lines = diff.replace(/\r/g, "").split("\n");
  let hasHunks = false;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      hasHunks = true;
      left.push(line);
      right.push(line);
      continue;
    }

    if (!hasHunks || line === "\\ No newline at end of file") {
      continue;
    }

    if (line.startsWith(" ")) {
      const content = line.slice(1);
      left.push(content);
      right.push(content);
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("--- ")) {
      left.push(line.slice(1));
      right.push("");
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++ ")) {
      left.push("");
      right.push(line.slice(1));
      continue;
    }
  }

  if (!hasHunks) {
    const fallback = diff.trim() || "No textual hunk preview is available for this file.";
    return {
      left: fallback,
      right: fallback
    };
  }

  return {
    left: left.join("\n"),
    right: right.join("\n")
  };
}

class ReviewCheckpointController implements vscode.Disposable {
  private readonly provider = new ReviewTreeDataProvider();
  private readonly treeView: vscode.TreeView<vscode.TreeItem>;
  private readonly diffWebview: DiffWebviewController;
  private readonly reviewContentProvider = new ReviewContentProvider();
  private readonly disposables: vscode.Disposable[] = [];
  private pollTimer?: NodeJS.Timeout;
  private gitRefreshSubscription?: vscode.Disposable;
  private selectedCommitHash?: string;
  private diffRenderMode: DiffRenderMode = "inline";
  private diffCache?: ReviewDiffCache;
  private refreshRequestVersion = 0;
  private diffRequestVersion = 0;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.treeView = vscode.window.createTreeView("reviewCheckpointView", {
      treeDataProvider: this.provider,
      showCollapseAll: false
    });

    this.diffWebview = new DiffWebviewController(
      context.extensionUri,
      async (commitHash) => this.approveSelectedCommit(commitHash),
      async (mode) => {
        this.diffRenderMode = mode;
        await this.showReviewDiff(undefined, mode);
      }
    );

    this.disposables.push(this.treeView, this.diffWebview);
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(
        REVIEW_CONTENT_SCHEME,
        this.reviewContentProvider
      )
    );

    this.registerCommands();
    this.registerLifecycle();
  }

  public dispose(): void {
    this.stopPolling();
    this.gitRefreshSubscription?.dispose();
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  private registerCommands(): void {
    this.disposables.push(
      vscode.commands.registerCommand("reviewCheckpoint.refresh", async () => {
        await this.refresh();
      }),
      vscode.commands.registerCommand(
        "reviewCheckpoint.initializeCheckpoint",
        async () => {
          await this.initializeCheckpoint();
        }
      ),
      vscode.commands.registerCommand(
        "reviewCheckpoint.showPendingCommits",
        async () => {
          await this.showPendingCommits();
        }
      ),
      vscode.commands.registerCommand(
        "reviewCheckpoint.showReviewDiff",
        async (item?: PendingCommit | CommitTreeItem) => {
          const commitHash =
            item instanceof CommitTreeItem
              ? item.commit.hash
              : typeof item === "object" && item !== null && "hash" in item
                ? String(item.hash)
                : undefined;
          await this.showReviewDiff(commitHash);
        }
      ),
      vscode.commands.registerCommand(
        "reviewCheckpoint.openSideBySideDiff",
        async (file?: ChangedFile) => {
          await this.openFileDiff("sideBySideFull", file);
        }
      ),
      vscode.commands.registerCommand(
        "reviewCheckpoint.openInlineDiff",
        async (file?: ChangedFile) => {
          await this.openFileDiff("inline", file);
        }
      ),
      vscode.commands.registerCommand(
        "reviewCheckpoint.approveSelectedCommit",
        async (item?: PendingCommit | CommitTreeItem) => {
          const commitHash =
            item instanceof CommitTreeItem
              ? item.commit.hash
              : typeof item === "object" && item !== null && "hash" in item
                ? String(item.hash)
                : undefined;
          await this.approveSelectedCommit(commitHash);
        }
      ),
      vscode.commands.registerCommand(
        "reviewCheckpoint.activateCommit",
        async (commitHash: string) => {
          this.selectedCommitHash = commitHash;
          this.applyOptimisticSelection(commitHash);
          await this.showReviewDiff(commitHash);
        }
      )
    );
  }

  private registerLifecycle(): void {
    this.disposables.push(
      this.treeView.onDidChangeVisibility(async (event) => {
        if (event.visible) {
          await this.refresh();
          this.startPolling();
          this.attachGitRefresh();
        } else {
          this.stopPolling();
          this.gitRefreshSubscription?.dispose();
          this.gitRefreshSubscription = undefined;
        }
      }),
      this.treeView.onDidChangeSelection((event) => {
        const selectedItem = event.selection[0];
        if (
          selectedItem instanceof CommitTreeItem &&
          selectedItem.commit.hash !== this.selectedCommitHash
        ) {
          this.selectedCommitHash = selectedItem.commit.hash;
          this.applyOptimisticSelection(selectedItem.commit.hash);
        }
      })
    );
  }

  private applyOptimisticSelection(commitHash: string): void {
    const state = this.provider.getState();
    if (state.status === "error") {
      return;
    }

    const selectedCommit = state.pendingCommits.find(
      (commit) => commit.hash === commitHash
    );
    if (!selectedCommit || state.selectedCommit?.hash === selectedCommit.hash) {
      return;
    }

    this.provider.setState({
      ...state,
      selectedCommit
    });
  }

  public async refresh(options?: {
    showInitializationPrompt?: boolean;
  }): Promise<void> {
    const requestVersion = ++this.refreshRequestVersion;
    const workspacePath = this.resolveWorkspacePath();
    if (!workspacePath) {
      this.provider.setState({
        status: "error",
        pendingCommits: [],
        changedFiles: [],
        message: "Review Checkpoint needs a single workspace folder."
      });
      this.treeView.message = undefined;
      return;
    }

    try {
      const state = await loadReviewState(workspacePath, this.selectedCommitHash);
      if (requestVersion !== this.refreshRequestVersion) {
        return;
      }

      this.selectedCommitHash = state.selectedCommit?.hash;
      this.invalidateDiffCacheIfNeeded(state);
      this.provider.setState(state);
      this.treeView.message = undefined;
    } catch (error) {
      if (requestVersion !== this.refreshRequestVersion) {
        return;
      }

      const message = this.toUserMessage(error);
      this.provider.setState({
        status: "error",
        pendingCommits: [],
        changedFiles: [],
        message
      });
      this.treeView.message = undefined;
      vscode.window.showErrorMessage(message);
    }
  }

  private async initializeCheckpoint(skipPrompt = false): Promise<void> {
    const state = await this.getCurrentState();
    if (!state.repositoryPath || !state.approvedRef || !state.reviewBranch) {
      vscode.window.showErrorMessage(
        state.message ?? "No repository is available for Review Checkpoint."
      );
      return;
    }

    if (state.status !== "missing-checkpoint") {
      vscode.window.showInformationMessage(
        "The approved marker already exists."
      );
      return;
    }

    if (!skipPrompt) {
      const choice = await vscode.window.showInformationMessage(
        `No approved marker exists yet. Initialize it to current ${state.reviewBranch}?`,
        "Initialize"
      );

      if (choice !== "Initialize") {
        return;
      }
    }
    await initializeApprovedRef(
      state.repositoryPath,
      state.approvedRef,
      state.reviewBranch
    );
    await this.refresh({ showInitializationPrompt: false });
  }

  private async showPendingCommits(): Promise<void> {
    const state = await this.getCurrentState();
    if (state.status === "error") {
      vscode.window.showInformationMessage(
        state.message ?? "No pending commits are available."
      );
      return;
    }

    if (state.pendingCommits.length === 0) {
      vscode.window.showInformationMessage(
        state.status === "missing-checkpoint"
          ? "No commits were found in the timeline."
          : "Everything in the timeline is approved."
      );
      return;
    }

    const picked = await vscode.window.showQuickPick(
      state.pendingCommits.map((commit) => ({
        label: `${commit.shortHash} ${commit.subject}`,
        description: `${commit.date} • ${commit.author}`,
        commit
      })),
      {
        placeHolder: "Select a pending commit"
      }
    );

    if (!picked) {
      return;
    }

    this.selectedCommitHash = picked.commit.hash;
    await this.refresh({ showInitializationPrompt: false });
  }

  private async showReviewDiff(
    commitHash?: string,
    mode?: DiffRenderMode
  ): Promise<void> {
    const requestVersion = ++this.diffRequestVersion;

    if (commitHash) {
      this.selectedCommitHash = commitHash;
      this.applyOptimisticSelection(commitHash);
    }

    if (mode) {
      this.diffRenderMode = mode;
    }
    const requestedMode = this.diffRenderMode;

    const optimisticState = this.provider.getState();
    if (
      optimisticState.status !== "error" &&
      optimisticState.selectedCommit &&
      optimisticState.repositoryPath &&
      optimisticState.comparisonBaseRef
    ) {
      this.diffWebview.showLoading(optimisticState, requestedMode);
    }

    if (commitHash) {
      await this.refresh({ showInitializationPrompt: false });
      if (requestVersion !== this.diffRequestVersion) {
        return;
      }
    }

    const state = await this.getCurrentState();
    if (requestVersion !== this.diffRequestVersion) {
      return;
    }

    if (
      state.status === "error" ||
      !state.selectedCommit ||
      !state.repositoryPath
    ) {
      vscode.window.showInformationMessage(
        state.message ?? "No selected commit is available."
      );
      return;
    }

    if (!state.comparisonBaseRef) {
      vscode.window.showInformationMessage(
        "The selected commit has no previous commit to compare against."
      );
      return;
    }

    this.diffWebview.showLoading(state, requestedMode);

    const content = await this.buildReviewDiffContent(state, requestedMode);
    if (requestVersion !== this.diffRequestVersion) {
      return;
    }

    this.diffWebview.show(state, content);
  }

  private async openSideBySideDiff(file?: ChangedFile): Promise<void> {
    await this.openFileDiff("sideBySideFull", file);
  }

  private async openInlineDiff(file?: ChangedFile): Promise<void> {
    await this.openFileDiff("inline", file);
  }

  private async openCompactSideBySideDiff(file?: ChangedFile): Promise<void> {
    await this.openFileDiff("sideBySideCompact", file);
  }

  private async openFileDiff(
    mode: "sideBySideCompact" | "sideBySideFull" | "inline",
    file?: ChangedFile
  ): Promise<void> {
    const state = await this.getCurrentState();
    if (
      state.status === "error" ||
      !state.selectedCommit ||
      !state.repositoryPath
    ) {
      vscode.window.showInformationMessage(
        state.message ?? "No selected commit is available."
      );
      return;
    }

    if (!state.comparisonBaseRef) {
      vscode.window.showInformationMessage(
        "The selected commit has no previous commit to compare against."
      );
      return;
    }

    const changedFile = file ?? (await this.pickChangedFile(state));
    if (!changedFile) {
      return;
    }

    const leftPath =
      changedFile.statusCode === "A"
        ? changedFile.newPath ?? changedFile.path
        : changedFile.oldPath ?? changedFile.path;
    const rightPath =
      changedFile.statusCode === "D"
        ? changedFile.oldPath ?? changedFile.path
        : changedFile.newPath ?? changedFile.path;

    let leftUri: vscode.Uri;
    let rightUri: vscode.Uri;

    if (mode === "sideBySideCompact") {
      const compactDiff = await getCompactFileDiff(
        state.repositoryPath,
        state.comparisonBaseRef,
        state.selectedCommit.hash,
        changedFile.path
      );
      const preview = buildCompactFilePreview(compactDiff);
      leftUri = this.reviewContentProvider.createGeneratedContentUri(
        leftPath,
        preview.left
      );
      rightUri = this.reviewContentProvider.createGeneratedContentUri(
        rightPath,
        preview.right
      );
    } else {
      leftUri = this.reviewContentProvider.createRevisionUri(
        state.repositoryPath,
        state.comparisonBaseRef,
        leftPath,
        changedFile.statusCode === "A"
      );
      rightUri = this.reviewContentProvider.createRevisionUri(
        state.repositoryPath,
        state.selectedCommit.hash,
        rightPath,
        changedFile.statusCode === "D"
      );
    }

    const title = `${changedFile.displayPath} (${state.comparisonBaseShortHash ?? "base"} ↔ ${state.selectedCommit.shortHash})`;
    await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title);

    const rendersSideBySide = vscode.workspace
      .getConfiguration("diffEditor")
      .get<boolean>("renderSideBySide", true);
    const shouldToggle =
      (mode === "inline" && rendersSideBySide) ||
      (mode !== "inline" && !rendersSideBySide);

    if (shouldToggle) {
      await vscode.commands.executeCommand(
        "workbench.action.compareEditor.toggleInlineView"
      );
    }
  }

  private async pickChangedFile(state: ReviewState): Promise<ChangedFile | undefined> {
    if (state.changedFiles.length === 0) {
      vscode.window.showInformationMessage("No changed files for the selected review range.");
      return undefined;
    }

    const picked = await vscode.window.showQuickPick(
      state.changedFiles.map((file) => ({
        label: file.displayPath,
        description: file.status,
        file
      })),
      {
        placeHolder: "Select a changed file"
      }
    );

    return picked?.file;
  }

  private async approveSelectedCommit(commitHash?: string): Promise<void> {
    const state = await this.getCurrentState();
    if (!state.repositoryPath || !state.reviewBranch || !state.approvedRef) {
      vscode.window.showErrorMessage(
        state.message ?? "Review Checkpoint is not ready."
      );
      return;
    }

    const targetCommitHash = commitHash ?? state.selectedCommit?.hash;
    if (!targetCommitHash) {
      vscode.window.showInformationMessage("Select a commit first.");
      return;
    }

    if (state.status === "missing-checkpoint") {
      await this.validateCommitOnBranch(
        state.repositoryPath,
        state.reviewBranch,
        targetCommitHash
      );
      await updateApprovedRef(
        state.repositoryPath,
        state.approvedRef,
        targetCommitHash
      );
      this.diffWebview.close();
      this.selectedCommitHash = undefined;
      await this.refresh({ showInitializationPrompt: false });
      return;
    }

    if (state.status !== "ready") {
      vscode.window.showErrorMessage(
        state.message ?? "Review Checkpoint is not ready."
      );
      return;
    }

    await this.validateApprovalTarget(
      state.repositoryPath,
      state.reviewBranch,
      state.approvedRef,
      targetCommitHash
    );
    await updateApprovedRef(
      state.repositoryPath,
      state.approvedRef,
      targetCommitHash
    );
    this.diffWebview.close();
    this.selectedCommitHash = undefined;
    await this.refresh({ showInitializationPrompt: false });
  }

  private async buildReviewDiffContent(
    state: ReviewState,
    mode: DiffRenderMode
  ): Promise<ReviewDiffContent> {
    if (!state.repositoryPath || !state.selectedCommit || !state.comparisonBaseRef) {
      return {
        mode,
        diffText: ""
      };
    }

    const cache = this.getDiffCache(state);

    if (mode === "sideBySideFull") {
      if (!cache.fullFiles) {
        cache.fullFiles = await this.loadFullDiffFiles(state);
      }

      return {
        mode,
        fullFiles: cache.fullFiles
      };
    }

    if (!cache.compactDiff) {
      cache.compactDiff = await getCompactDiff(
        state.repositoryPath,
        state.comparisonBaseRef,
        state.selectedCommit.hash
      );
    }

    return {
      mode,
      diffText: cache.compactDiff
    };
  }

  private async loadFullDiffFiles(state: ReviewState): Promise<FullDiffFile[]> {
    if (!state.repositoryPath || !state.selectedCommit || !state.comparisonBaseRef) {
      return [];
    }

    return Promise.all(
      state.changedFiles.map(async (changedFile) => {
        const leftPath =
          changedFile.statusCode === "A"
            ? changedFile.newPath ?? changedFile.path
            : changedFile.oldPath ?? changedFile.path;
        const rightPath =
          changedFile.statusCode === "D"
            ? changedFile.oldPath ?? changedFile.path
            : changedFile.newPath ?? changedFile.path;

        const [leftContent, rightContent] = await Promise.all([
          changedFile.statusCode === "A"
            ? Promise.resolve("")
            : readFileAtRevision(
                state.repositoryPath as string,
                state.comparisonBaseRef as string,
                leftPath
              ),
          changedFile.statusCode === "D"
            ? Promise.resolve("")
            : readFileAtRevision(
                state.repositoryPath as string,
                state.selectedCommit!.hash,
                rightPath
              )
        ]);

        return {
          displayPath: changedFile.displayPath,
          status: changedFile.status,
          leftContent,
          rightContent
        };
      })
    );
  }

  private getDiffCache(state: ReviewState): ReviewDiffCache {
    const key = this.getDiffCacheKey(state);
    if (!this.diffCache || this.diffCache.key !== key) {
      this.diffCache = { key };
    }

    return this.diffCache;
  }

  private invalidateDiffCacheIfNeeded(state: ReviewState): void {
    const key = this.getDiffCacheKey(state);
    if (this.diffCache?.key !== key) {
      this.diffCache = undefined;
    }
  }

  private getDiffCacheKey(state: ReviewState): string {
    return [
      state.repositoryPath ?? "",
      state.comparisonBaseRef ?? "",
      state.selectedCommit?.hash ?? "",
      String(state.changedFiles.length)
    ].join("|");
  }

  private async validateCommitOnBranch(
    repositoryPath: string,
    reviewBranch: ReviewBranch,
    commitHash: string
  ): Promise<void> {
    const repositoryRoot = await getRepositoryRoot(repositoryPath);
    const commitExists = await ensureCommitExists(repositoryRoot, commitHash);
    if (!commitExists) {
      throw new Error("The selected commit no longer exists.");
    }

    const reachableFromReviewBranch = await isAncestor(
      repositoryRoot,
      commitHash,
      reviewBranch
    );
    if (!reachableFromReviewBranch) {
      throw new Error(`The selected commit is not reachable from ${reviewBranch}.`);
    }
  }

  private async validateApprovalTarget(
    repositoryPath: string,
    reviewBranch: ReviewBranch,
    approvedRef: string,
    commitHash: string
  ): Promise<void> {
    const repositoryRoot = await getRepositoryRoot(repositoryPath);
    const approvedRefExists = await hasRef(repositoryRoot, approvedRef);
    if (!approvedRefExists) {
      throw new Error("No approved marker exists yet.");
    }

    await this.validateCommitOnBranch(repositoryRoot, reviewBranch, commitHash);

    const pendingCommits = await listPendingCommits(
      repositoryRoot,
      approvedRef,
      reviewBranch
    );
    if (!pendingCommits.some((commit) => commit.hash === commitHash)) {
      throw new Error(
        "The selected commit is no longer in the pending range."
      );
    }
  }

  private resolveWorkspacePath(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length !== 1) {
      return undefined;
    }

    return folders[0].uri.fsPath;
  }

  private async getCurrentState(): Promise<ReviewState> {
    const state = this.provider.getState();
    if (state.repositoryPath || state.status === "ready" || state.status === "missing-checkpoint") {
      return state;
    }

    await this.refresh({ showInitializationPrompt: false });
    return this.provider.getState();
  }

  private attachGitRefresh(): void {
    this.gitRefreshSubscription?.dispose();
    this.gitRefreshSubscription = undefined;

    const currentState = this.provider.getState();
    if (!currentState.repositoryPath) {
      return;
    }

    const gitExtension = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
    const exports = gitExtension?.isActive ? gitExtension.exports : gitExtension?.activate();
    Promise.resolve(exports)
      .then((resolved) => {
        if (!resolved) {
          return;
        }

        const api = resolved.getAPI(1);
        const repository = api.repositories.find(
          (candidate) =>
            candidate.rootUri.fsPath.toLowerCase() ===
            currentState.repositoryPath?.toLowerCase()
        );

        if (!repository) {
          return;
        }

        this.gitRefreshSubscription = repository.state.onDidChange(() => {
          if (this.treeView.visible) {
            void this.refresh({ showInitializationPrompt: false });
          }
        });
        this.disposables.push(this.gitRefreshSubscription);
      })
      .catch(() => {
        this.gitRefreshSubscription = undefined;
      });
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      if (this.treeView.visible) {
        void this.refresh({ showInitializationPrompt: false });
      }
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private toUserMessage(error: unknown): string {
    if (typeof error === "string") {
      return error;
    }

    if (error instanceof Error) {
      if (error instanceof GitCommandError) {
        if (/not a git repository/i.test(error.stderr)) {
          return "Not a Git repository.";
        }
        if (/unknown revision|needed a single revision|bad revision/i.test(error.stderr)) {
          return "Git could not resolve the requested review range.";
        }
        return error.stderr || error.message;
      }

      return error.message;
    }

    return "Review Checkpoint failed.";
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new ReviewCheckpointController(context);
  context.subscriptions.push(controller);
}

export function deactivate(): void {}
