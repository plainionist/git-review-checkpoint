import * as vscode from "vscode";
import { PendingCommit } from "./git";
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
      command: "reviewCheckpoint.activateCommit",
      title: "Activate Commit",
      arguments: [commit.hash]
    };
  }
}

class StaticTreeItem extends vscode.TreeItem {
  public constructor(
    label: string,
    options?: {
      description?: string;
      tooltip?: string;
      iconId?: string;
    }
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = options?.description;
    this.tooltip = options?.tooltip;
    this.iconPath = options?.iconId
      ? new vscode.ThemeIcon(options.iconId)
      : undefined;
  }
}

class SpacerTreeItem extends vscode.TreeItem {
  public constructor() {
    super("\u00A0", vscode.TreeItemCollapsibleState.None);
  }
}

class ActionTreeItem extends vscode.TreeItem {
  public constructor(
    label: string,
    command: string,
    iconId: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.command = {
      command,
      title: label
    };
    this.iconPath = new vscode.ThemeIcon(iconId);
    this.contextValue = "action";
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
    void element;
    return this.buildRootItems();
  }

  private buildRootItems(): vscode.TreeItem[] {
    if (this.state.status === "error") {
      return [
        new StaticTreeItem(this.state.message ?? "Unable to load Review Checkpoint.", {
          iconId: "error"
        })
      ];
    }

    const items: vscode.TreeItem[] = [];

    if (this.state.message) {
      items.push(
        new StaticTreeItem(this.state.message, {
          iconId: this.state.status === "missing-checkpoint" ? "warning" : "info"
        })
      );

      if (this.state.pendingCommits.length > 0) {
        items.push(new SpacerTreeItem());
      }
    }

    items.push(...this.buildActionItems());

    if (this.state.pendingCommits.length > 0 && items.length > 0) {
      items.push(new SpacerTreeItem());
    }

    if (this.state.pendingCommits.length === 0) {
      return items.length > 0
        ? items
        : [
            new StaticTreeItem("Everything up to master is approved.", {
              iconId: "info"
            })
          ];
    }

    items.push(
      ...this.state.pendingCommits.map(
        (commit) =>
          new CommitTreeItem(
            commit,
            this.state.selectedCommit?.hash === commit.hash,
            this.state.status === "ready" ? "pendingCommit" : "recentCommit"
          )
      )
    );

    return items;
  }

  private buildActionItems(): vscode.TreeItem[] {
    const items: vscode.TreeItem[] = [
      new ActionTreeItem("Refresh", "reviewCheckpoint.refresh", "refresh")
    ];

    if (this.state.pendingCommits.length > 0) {
      items.push(
        new ActionTreeItem(
          "Choose commit",
          "reviewCheckpoint.showPendingCommits",
          "list-selection"
        )
      );
    }

    if (this.state.selectedCommit && this.state.comparisonBaseRef) {
      items.push(
        new ActionTreeItem(
          "Show review diff",
          "reviewCheckpoint.showReviewDiff",
          "diff"
        ),
        new ActionTreeItem(
          "Open side-by-side diff",
          "reviewCheckpoint.openSideBySideDiff",
          "split-horizontal"
        ),
        new ActionTreeItem(
          "Open inline diff",
          "reviewCheckpoint.openInlineDiff",
          "list-flat"
        )
      );
    }

    if (this.state.status === "missing-checkpoint") {
      items.push(
        new ActionTreeItem(
          "Initialize Review Checkpoint",
          "reviewCheckpoint.initializeCheckpoint",
          "add"
        )
      );
    }

    if (this.state.status === "ready" && this.state.selectedCommit) {
      items.push(
        new ActionTreeItem(
          "Approve up to selected commit",
          "reviewCheckpoint.approveSelectedCommit",
          "pass"
        )
      );
    }

    return items;
  }
}
