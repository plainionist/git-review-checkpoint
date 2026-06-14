import * as vscode from "vscode";
import {
  APPROVED_REF,
  ChangedFile,
  GitCommandError,
  PendingCommit,
  REVIEW_BRANCH,
  POLL_INTERVAL_MS,
  ensureCommitExists,
  getCompactDiff,
  getRepositoryRoot,
  hasRef,
  initializeApprovedRef,
  isAncestor,
  listPendingCommits,
  toShortHash,
  updateApprovedRef
} from "./git";
import { DiffWebviewController } from "./diffWebview";
import {
  REVIEW_CONTENT_SCHEME,
  ReviewContentProvider,
  createReviewFileUri
} from "./reviewContentProvider";
import {
  ChangedFileTreeItem,
  CommitTreeItem,
  ReviewTreeDataProvider
} from "./reviewView";
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

class ReviewCheckpointController implements vscode.Disposable {
  private readonly provider = new ReviewTreeDataProvider();
  private readonly treeView: vscode.TreeView<vscode.TreeItem>;
  private readonly diffWebview: DiffWebviewController;
  private readonly disposables: vscode.Disposable[] = [];
  private pollTimer?: NodeJS.Timeout;
  private gitRefreshSubscription?: vscode.Disposable;
  private selectedCommitHash?: string;
  private missingCheckpointPromptShown = false;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.treeView = vscode.window.createTreeView("reviewCheckpointView", {
      treeDataProvider: this.provider,
      showCollapseAll: false
    });

    this.diffWebview = new DiffWebviewController(
      context.extensionUri,
      async (commitHash) => this.approveSelectedCommit(commitHash)
    );

    this.disposables.push(this.treeView, this.diffWebview);
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(
        REVIEW_CONTENT_SCHEME,
        new ReviewContentProvider()
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
          await this.openSideBySideDiff(file);
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
        "reviewCheckpoint.selectCommit",
        async (commitHash: string) => {
          if (this.selectedCommitHash === commitHash) {
            return;
          }

          this.selectedCommitHash = commitHash;
          await this.refresh({ showInitializationPrompt: false });
        }
      )
    );
  }

  private registerLifecycle(): void {
    this.disposables.push(
      this.treeView.onDidChangeVisibility(async (event) => {
        if (event.visible) {
          this.missingCheckpointPromptShown = false;
          await this.refresh();
          this.startPolling();
          this.attachGitRefresh();
        } else {
          this.stopPolling();
          this.gitRefreshSubscription?.dispose();
          this.gitRefreshSubscription = undefined;
          this.missingCheckpointPromptShown = false;
        }
      }),
      this.treeView.onDidChangeSelection(async (event) => {
        const selectedItem = event.selection[0];
        if (
          selectedItem instanceof CommitTreeItem &&
          selectedItem.commit.hash !== this.selectedCommitHash
        ) {
          this.selectedCommitHash = selectedItem.commit.hash;
          await this.refresh({ showInitializationPrompt: false });
        }
      })
    );
  }

  public async refresh(options?: {
    showInitializationPrompt?: boolean;
  }): Promise<void> {
    const workspacePath = this.resolveWorkspacePath();
    if (!workspacePath) {
      this.provider.setState({
        status: "error",
        pendingCommits: [],
        changedFiles: [],
        message: "Review Checkpoint needs a single workspace folder."
      });
      this.treeView.message = "Review Checkpoint needs a single workspace folder.";
      return;
    }

    try {
      const state = await loadReviewState(workspacePath, this.selectedCommitHash);
      this.selectedCommitHash = state.selectedCommit?.hash;
      this.provider.setState(state);
      this.treeView.message = state.message;

      if (
        options?.showInitializationPrompt !== false &&
        state.status === "missing-checkpoint" &&
        this.treeView.visible &&
        !this.missingCheckpointPromptShown
      ) {
        this.missingCheckpointPromptShown = true;
        const choice = await vscode.window.showInformationMessage(
          "No approved marker exists yet. Initialize it to current master?",
          "Initialize"
        );

        if (choice === "Initialize") {
          await this.initializeCheckpoint(true);
        }
      }
    } catch (error) {
      const message = this.toUserMessage(error);
      this.provider.setState({
        status: "error",
        pendingCommits: [],
        changedFiles: [],
        message
      });
      this.treeView.message = message;
      vscode.window.showErrorMessage(message);
    }
  }

  private async initializeCheckpoint(skipPrompt = false): Promise<void> {
    const state = await this.getCurrentState();
    if (!state.repositoryPath) {
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
        "No approved marker exists yet. Initialize it to current master?",
        "Initialize"
      );

      if (choice !== "Initialize") {
        return;
      }
    }

    await initializeApprovedRef(state.repositoryPath);
    this.missingCheckpointPromptShown = false;
    await this.refresh({ showInitializationPrompt: false });
  }

  private async showPendingCommits(): Promise<void> {
    const state = await this.getCurrentState();
    if (state.status !== "ready") {
      vscode.window.showInformationMessage(
        state.message ?? "No pending commits are available."
      );
      return;
    }

    if (state.pendingCommits.length === 0) {
      vscode.window.showInformationMessage("Everything up to master is approved.");
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

  private async showReviewDiff(commitHash?: string): Promise<void> {
    if (commitHash && commitHash !== this.selectedCommitHash) {
      this.selectedCommitHash = commitHash;
      await this.refresh({ showInitializationPrompt: false });
    }

    const state = await this.getCurrentState();
    if (state.status !== "ready" || !state.selectedCommit || !state.repositoryPath) {
      vscode.window.showInformationMessage(
        state.message ?? "No selected commit is available."
      );
      return;
    }

    const diff = await getCompactDiff(
      state.repositoryPath,
      state.selectedCommit.hash
    );
    this.diffWebview.show(state, diff);
  }

  private async openSideBySideDiff(file?: ChangedFile): Promise<void> {
    const state = await this.getCurrentState();
    if (state.status !== "ready" || !state.selectedCommit || !state.repositoryPath) {
      vscode.window.showInformationMessage(
        state.message ?? "No selected commit is available."
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

    const leftUri = createReviewFileUri(
      state.repositoryPath,
      APPROVED_REF,
      leftPath,
      changedFile.statusCode === "A"
    );
    const rightUri = createReviewFileUri(
      state.repositoryPath,
      state.selectedCommit.hash,
      rightPath,
      changedFile.statusCode === "D"
    );

    const title = `${changedFile.displayPath} (${state.approvedShortHash ?? "base"} ↔ ${state.selectedCommit.shortHash})`;
    await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title);
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
    if (state.status !== "ready" || !state.repositoryPath) {
      vscode.window.showErrorMessage(
        state.message ?? "Review Checkpoint is not ready."
      );
      return;
    }

    const targetCommitHash = commitHash ?? state.selectedCommit?.hash;
    if (!targetCommitHash) {
      vscode.window.showInformationMessage("Select a pending commit first.");
      return;
    }

    const shortHash = toShortHash(targetCommitHash);
    const choice = await vscode.window.showWarningMessage(
      `Move ${APPROVED_REF} to ${shortHash}?`,
      {
        modal: true,
        detail:
          "This marks all commits up to this commit as approved."
      },
      "Approve"
    );

    if (choice !== "Approve") {
      return;
    }

    await this.validateApprovalTarget(state.repositoryPath, targetCommitHash);
    await updateApprovedRef(state.repositoryPath, targetCommitHash);
    this.diffWebview.close();
    this.selectedCommitHash = undefined;
    await this.refresh({ showInitializationPrompt: false });
  }

  private async validateApprovalTarget(
    repositoryPath: string,
    commitHash: string
  ): Promise<void> {
    const repositoryRoot = await getRepositoryRoot(repositoryPath);
    const approvedRefExists = await hasRef(repositoryRoot, APPROVED_REF);
    if (!approvedRefExists) {
      throw new Error("No approved marker exists yet.");
    }

    const commitExists = await ensureCommitExists(repositoryRoot, commitHash);
    if (!commitExists) {
      throw new Error("The selected commit no longer exists.");
    }

    const reachableFromMaster = await isAncestor(
      repositoryRoot,
      commitHash,
      REVIEW_BRANCH
    );
    if (!reachableFromMaster) {
      throw new Error("The selected commit is not reachable from master.");
    }

    const pendingCommits = await listPendingCommits(repositoryRoot);
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
