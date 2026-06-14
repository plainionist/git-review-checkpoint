import * as vscode from "vscode";
import { readFileAtRevision } from "./git";

export const REVIEW_CONTENT_SCHEME = "review-checkpoint";

interface ReviewContentUriData {
  repositoryPath: string;
  ref: string;
  empty: boolean;
}

function parseUriData(uri: vscode.Uri): ReviewContentUriData {
  const query = new URLSearchParams(uri.query);
  return {
    repositoryPath: query.get("repositoryPath") ?? "",
    ref: query.get("ref") ?? "",
    empty: query.get("empty") === "1"
  };
}

export function createReviewFileUri(
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

export class ReviewContentProvider
  implements vscode.TextDocumentContentProvider
{
  public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const data = parseUriData(uri);
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

