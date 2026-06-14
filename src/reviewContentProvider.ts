import * as vscode from "vscode";
import { readFileAtRevision } from "./git";

export const REVIEW_CONTENT_SCHEME = "review-checkpoint";

interface ReviewContentUriData {
  contentId?: string;
  repositoryPath: string;
  ref: string;
  empty: boolean;
}

function parseUriData(uri: vscode.Uri): ReviewContentUriData {
  const query = new URLSearchParams(uri.query);
  return {
    contentId: query.get("contentId") ?? undefined,
    repositoryPath: query.get("repositoryPath") ?? "",
    ref: query.get("ref") ?? "",
    empty: query.get("empty") === "1"
  };
}

export class ReviewContentProvider
  implements vscode.TextDocumentContentProvider
{
  private readonly generatedContent = new Map<string, string>();
  private nextContentId = 0;

  public createRevisionUri(
    repositoryPath: string,
    ref: string,
    filePath: string,
    empty = false
  ): vscode.Uri {
    const query = new URLSearchParams({
      repositoryPath,
      ref,
      empty: empty ? "1" : "0"
    });

    return vscode.Uri.from({
      scheme: REVIEW_CONTENT_SCHEME,
      path: `/${filePath}`,
      query: query.toString()
    });
  }

  public createGeneratedContentUri(
    filePath: string,
    content: string
  ): vscode.Uri {
    const contentId = String(++this.nextContentId);
    this.generatedContent.set(contentId, content);

    return vscode.Uri.from({
      scheme: REVIEW_CONTENT_SCHEME,
      path: `/${filePath}`,
      query: new URLSearchParams({
        contentId
      }).toString()
    });
  }

  public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const data = parseUriData(uri);
    if (data.contentId) {
      return this.generatedContent.get(data.contentId) ?? "";
    }

    if (data.empty) {
      return "";
    }

    return readFileAtRevision(
      data.repositoryPath,
      data.ref,
      uri.path.replace(/^\//, "")
    );
  }
}
