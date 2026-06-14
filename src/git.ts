import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SUPPORTED_REVIEW_BRANCHES = ["main", "master"] as const;
export const POLL_INTERVAL_MS = 15_000;
export const DIFF_CONTEXT_LINES = 3;
export const INITIAL_COMMIT_PREVIEW_COUNT = 20;

export type ReviewBranch = (typeof SUPPORTED_REVIEW_BRANCHES)[number];

export interface ReviewTarget {
  reviewBranch: ReviewBranch;
  approvedRef: string;
}

export interface PendingCommit {
  hash: string;
  shortHash: string;
  date: string;
  author: string;
  subject: string;
}

export interface ChangedFile {
  status: string;
  statusCode: string;
  path: string;
  oldPath?: string;
  newPath?: string;
  displayPath: string;
}

export class GitCommandError extends Error {
  public readonly stderr: string;

  public constructor(
    public readonly args: readonly string[],
    stderr: string,
    public readonly exitCode?: number
  ) {
    super(`Git command failed: git ${args.join(" ")}`);
    this.name = "GitCommandError";
    this.stderr = stderr.trim();
  }
}

function isExecFailure(error: unknown): error is NodeJS.ErrnoException & {
  stdout?: string;
  stderr?: string;
  code?: string | number;
} {
  return typeof error === "object" && error !== null && "stderr" in error;
}

function normalizeGitPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

async function runGit(
  repositoryPath: string,
  args: readonly string[],
  options?: { trim?: boolean }
): Promise<string> {
  try {
    const result = await execFileAsync("git", ["--no-pager", ...args], {
      cwd: repositoryPath,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024
    });

    return options?.trim === false ? result.stdout : result.stdout.trimEnd();
  } catch (error) {
    if (isExecFailure(error)) {
      const exitCode =
        typeof error.code === "number" ? error.code : undefined;
      throw new GitCommandError(args, error.stderr ?? "", exitCode);
    }

    throw error;
  }
}

async function runGitAllowExitCodeOne(
  repositoryPath: string,
  args: readonly string[]
): Promise<boolean> {
  try {
    await execFileAsync("git", ["--no-pager", ...args], {
      cwd: repositoryPath,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });

    return true;
  } catch (error) {
    if (isExecFailure(error)) {
      const exitCode =
        typeof error.code === "number" ? error.code : undefined;
      if (exitCode === 1) {
        return false;
      }

      throw new GitCommandError(args, error.stderr ?? "", exitCode);
    }

    throw error;
  }
}

export function toShortHash(hash: string): string {
  return hash.slice(0, 7);
}

export function getApprovedRef(reviewBranch: ReviewBranch): string {
  return `refs/approved/${reviewBranch}`;
}

export async function getRepositoryRoot(workspacePath: string): Promise<string> {
  return runGit(workspacePath, ["rev-parse", "--show-toplevel"]);
}

export async function hasRef(
  repositoryPath: string,
  ref: string
): Promise<boolean> {
  return runGitAllowExitCodeOne(repositoryPath, [
    "show-ref",
    "--verify",
    "--quiet",
    ref
  ]);
}

export async function resolveCommit(
  repositoryPath: string,
  ref: string
): Promise<string> {
  return runGit(repositoryPath, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

async function tryRunGit(
  repositoryPath: string,
  args: readonly string[]
): Promise<string | undefined> {
  try {
    return await runGit(repositoryPath, args);
  } catch (error) {
    if (error instanceof GitCommandError) {
      return undefined;
    }

    throw error;
  }
}

async function detectReviewBranch(
  repositoryPath: string
): Promise<ReviewBranch | undefined> {
  const candidates: ReviewBranch[] = [];

  const originHead = await tryRunGit(repositoryPath, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD"
  ]);
  if (originHead === "origin/main" || originHead === "origin/master") {
    candidates.push(originHead.slice("origin/".length) as ReviewBranch);
  }

  const currentBranch = await tryRunGit(repositoryPath, ["branch", "--show-current"]);
  if (currentBranch === "main" || currentBranch === "master") {
    candidates.push(currentBranch);
  }

  for (const supportedBranch of SUPPORTED_REVIEW_BRANCHES) {
    candidates.push(supportedBranch);
  }

  for (const candidate of candidates) {
    if (await hasRef(repositoryPath, `refs/heads/${candidate}`)) {
      return candidate;
    }
  }

  return undefined;
}

export async function resolveReviewTarget(
  repositoryPath: string
): Promise<ReviewTarget | undefined> {
  const reviewBranch = await detectReviewBranch(repositoryPath);
  if (!reviewBranch) {
    return undefined;
  }

  return {
    reviewBranch,
    approvedRef: getApprovedRef(reviewBranch)
  };
}

export async function getBranchCommit(
  repositoryPath: string,
  reviewBranch: ReviewBranch
): Promise<string> {
  return resolveCommit(repositoryPath, reviewBranch);
}

export async function getApprovedCommit(
  repositoryPath: string,
  approvedRef: string
): Promise<string> {
  return resolveCommit(repositoryPath, approvedRef);
}

export async function getCommitDetails(
  repositoryPath: string,
  commit: string
): Promise<PendingCommit> {
  const output = await runGit(repositoryPath, [
    "show",
    "-s",
    "--date=short",
    "--pretty=format:%H%x09%h%x09%ad%x09%an%x09%s",
    commit
  ]);

  return parseCommitLine(output);
}

export async function getParentCommit(
  repositoryPath: string,
  commit: string
): Promise<string | undefined> {
  try {
    return await runGit(repositoryPath, [
      "rev-parse",
      "--verify",
      `${commit}^1`
    ]);
  } catch (error) {
    if (
      error instanceof GitCommandError &&
      /unknown revision|needed a single revision|bad revision|ambiguous argument/i.test(
        error.stderr
      )
    ) {
      return undefined;
    }

    throw error;
  }
}

function parseCommitLine(line: string): PendingCommit {
  const [hash, shortHash, date, author, ...subjectParts] = line.split("\t");
  return {
    hash,
    shortHash,
    date,
    author,
    subject: subjectParts.join("\t")
  };
}

export async function listPendingCommits(
  repositoryPath: string,
  approvedRef: string,
  reviewBranch: ReviewBranch
): Promise<PendingCommit[]> {
  const output = await runGit(repositoryPath, [
    "log",
    "--oneline",
    "--decorate",
    "--date=short",
    "--pretty=format:%H%x09%h%x09%ad%x09%an%x09%s",
    `${approvedRef}..${reviewBranch}`
  ]);

  if (!output) {
    return [];
  }

  return output.split(/\r?\n/).map(parseCommitLine);
}

export async function listRecentBranchCommits(
  repositoryPath: string,
  reviewBranch: ReviewBranch,
  limit = INITIAL_COMMIT_PREVIEW_COUNT
): Promise<PendingCommit[]> {
  const output = await runGit(repositoryPath, [
    "log",
    "--date=short",
    `--max-count=${limit}`,
    "--pretty=format:%H%x09%h%x09%ad%x09%an%x09%s",
    reviewBranch
  ]);

  if (!output) {
    return [];
  }

  return output.split(/\r?\n/).map(parseCommitLine);
}

export async function listChangedFiles(
  repositoryPath: string,
  baseRef: string,
  selectedCommit: string
): Promise<ChangedFile[]> {
  const output = await runGit(repositoryPath, [
    "diff",
    "--name-status",
    `${baseRef}..${selectedCommit}`
  ]);

  if (!output) {
    return [];
  }

  return output.split(/\r?\n/).map((line) => {
    const parts = line.split("\t");
    const status = parts[0];
    const statusCode = status.charAt(0);

    if (statusCode === "R" || statusCode === "C") {
      const oldPath = parts[1];
      const newPath = parts[2];
      return {
        status,
        statusCode,
        path: newPath,
        oldPath,
        newPath,
        displayPath: `${oldPath} -> ${newPath}`
      };
    }

    const filePath = parts[1];
    return {
      status,
      statusCode,
      path: filePath,
      oldPath: filePath,
      newPath: filePath,
      displayPath: filePath
    };
  });
}

export async function getDiff(
  repositoryPath: string,
  baseRef: string,
  selectedCommit: string
): Promise<string> {
  return runGit(
    repositoryPath,
    ["diff", "--find-renames", `${baseRef}..${selectedCommit}`],
    { trim: false }
  );
}

export async function getCompactDiff(
  repositoryPath: string,
  baseRef: string,
  selectedCommit: string
): Promise<string> {
  return runGit(
    repositoryPath,
    [
      "diff",
      "--find-renames",
      `--unified=${DIFF_CONTEXT_LINES}`,
      `${baseRef}..${selectedCommit}`
    ],
    { trim: false }
  );
}

export async function getCompactFileDiff(
  repositoryPath: string,
  baseRef: string,
  selectedCommit: string,
  filePath: string
): Promise<string> {
  return runGit(
    repositoryPath,
    [
      "diff",
      "--find-renames",
      `--unified=${DIFF_CONTEXT_LINES}`,
      `${baseRef}..${selectedCommit}`,
      "--",
      normalizeGitPath(filePath)
    ],
    { trim: false }
  );
}

export async function updateApprovedRef(
  repositoryPath: string,
  approvedRef: string,
  selectedCommit: string
): Promise<void> {
  await runGit(repositoryPath, [
    "update-ref",
    approvedRef,
    selectedCommit
  ]);
}

export async function initializeApprovedRef(
  repositoryPath: string,
  approvedRef: string,
  reviewBranch: ReviewBranch
): Promise<void> {
  await runGit(repositoryPath, [
    "update-ref",
    approvedRef,
    reviewBranch
  ]);
}

export async function isAncestor(
  repositoryPath: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  return runGitAllowExitCodeOne(repositoryPath, [
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant
  ]);
}

export async function ensureCommitExists(
  repositoryPath: string,
  commit: string
): Promise<boolean> {
  return runGitAllowExitCodeOne(repositoryPath, [
    "rev-parse",
    "--verify",
    `${commit}^{commit}`
  ]);
}

export async function readFileAtRevision(
  repositoryPath: string,
  ref: string,
  filePath: string
): Promise<string> {
  return runGit(
    repositoryPath,
    ["show", `${ref}:${normalizeGitPath(filePath)}`],
    { trim: false }
  );
}
