import * as vscode from "vscode";
import { APPROVED_REF, ChangedFile, PendingCommit } from "./git";
import { ReviewState } from "./reviewModel";

export class CommitTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly commit: PendingCommit,
    selected: boolean,
    contextValue = "pendingCommit"
  ) {
    super(`${commit.shortHash}  ${commit.subject}`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = contextValue;
    this.description = selected ? `${commit.date}  selected` : commit.date;
    this.iconPath = new vscode.ThemeIcon(selected ? "target" : "git-commit");
    this.tooltip = `${commit.hash}\n${commit.author} • ${commit.date}\n${commit.subject}`;
    this.command = {
      command: "reviewCheckpoint.selectCommit",
      title: "Select Pending Commit",
      arguments: [commit.hash]
    };
  }
}

export class ChangedFileTreeItem extends vscode.TreeItem {
  public constructor(public readonly file: ChangedFile) {
    super(file.displayPath, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "changedFile";
    this.description = file.status;
    this.tooltip = `${file.status}\n${file.displayPath}`;
    this.iconPath = new vscode.ThemeIcon("diff");
    this.command = {
      command: "reviewCheckpoint.openSideBySideDiff",
      title: "Open Side-by-Side Diff",
      arguments: [file]
    };
  }
}

class StaticTreeItem extends vscode.TreeItem {
  public readonly children: vscode.TreeItem[];

  public constructor(
    label: string,
    children: vscode.TreeItem[] = [],
    options?: {
      description?: string;
      tooltip?: string;
      iconId?: string;
      contextValue?: string;
      command?: vscode.Command;
      collapsibleState?: vscode.TreeItemCollapsibleState;
    }
  ) {
    super(
      label,
      options?.collapsibleState ??
        (children.length > 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None)
    );
    this.children = children;
    this.description = options?.description;
    this.tooltip = options?.tooltip;
    this.contextValue = options?.contextValue;
    this.command = options?.command;
    this.iconPath = options?.iconId
      ? new vscode.ThemeIcon(options.iconId)
      : undefined;
  }
}

export class ReviewTreeDataProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  private readonly changeEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  private state: ReviewState = {
    status: "error",
    pendingCommits: [],
    changedFiles: [],
    message: "Loading Review Checkpoint..."
  };

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public getState(): ReviewState {
    return this.state;
  }

  public setState(state: ReviewState): void {
    this.state = state;
    this.changeEmitter.fire(undefined);
  }

  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
    if (element instanceof StaticTreeItem) {
      return element.children;
    }

    return this.buildRootItems();
  }

  private buildRootItems(): vscode.TreeItem[] {
    if (this.state.status === "error") {
      return [
        new StaticTreeItem(this.state.message ?? "Unable to load Review Checkpoint.", [], {
          iconId: "error"
        })
      ];
    }

    const items: vscode.TreeItem[] = [];

    if (this.state.approvedShortHash) {
      items.push(
        new StaticTreeItem(`Approved marker: ${this.state.approvedShortHash}`, [], {
          tooltip: this.state.approvedCommit,
          iconId: "pass"
        })
      );
    } else {
      items.push(
        new StaticTreeItem("Approved marker: missing", [], {
          iconId: "warning",
          tooltip: "No approved marker exists yet."
        })
      );
    }

    if (this.state.masterShortHash) {
      items.push(
        new StaticTreeItem(`Current master: ${this.state.masterShortHash}`, [], {
          tooltip: this.state.masterCommit,
          iconId: "git-branch"
        })
      );
    }

    if (this.state.reviewRange) {
      items.push(
        new StaticTreeItem("Review range", [], {
          description: `${APPROVED_REF}..${this.state.selectedCommit?.shortHash ?? ""}`,
          tooltip: this.state.reviewRange,
          iconId: "compare-changes"
        })
      );
    }

    const commitChildren =
      this.state.pendingCommits.length > 0
        ? this.state.pendingCommits.map(
            (commit) =>
              new CommitTreeItem(
                commit,
                this.state.selectedCommit?.hash === commit.hash,
                this.state.status === "ready" ? "pendingCommit" : "recentCommit"
              )
          )
        : [
            new StaticTreeItem(
              this.state.message ?? "Everything up to master is approved.",
              [],
              { iconId: "info" }
            )
          ];

    items.push(
      new StaticTreeItem(
        this.state.status === "missing-checkpoint"
          ? `Latest master commits (${this.state.pendingCommits.length})`
          : `Pending commits (${this.state.pendingCommits.length})`,
        commitChildren,
        { iconId: "history" }
      )
    );

    const changedFileChildren =
      this.state.changedFiles.length > 0
        ? this.state.changedFiles.map((file) => new ChangedFileTreeItem(file))
        : [
            new StaticTreeItem(
              this.state.status === "missing-checkpoint"
                ? "Initialize Review Checkpoint to define a review range."
                : this.state.pendingCommits.length > 0
                ? "Select a pending commit to inspect changed files."
                : this.state.message ?? "No changed files.",
              [],
              { iconId: "info" }
            )
          ];

    items.push(
      new StaticTreeItem(
        this.state.selectedCommit
          ? `Changed files for ${this.state.selectedCommit.shortHash} (${this.state.changedFiles.length})`
          : "Changed files (0)",
        changedFileChildren,
        { iconId: "files" }
      )
    );

    if (this.state.status === "missing-checkpoint") {
      items.push(
        new StaticTreeItem("Initialize Review Checkpoint", [], {
          iconId: "add",
          command: {
            command: "reviewCheckpoint.initializeCheckpoint",
            title: "Initialize Checkpoint"
          }
        })
      );
    }

    return items;
  }
}
