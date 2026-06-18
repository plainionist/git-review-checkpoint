import {
  ChangedFile,
  GitCommandError,
  INITIAL_COMMIT_PREVIEW_COUNT,
  PendingCommit,
  ReviewBranch,
  getCommitDetails,
  getBranchCommit,
  getParentCommit,
  getRepositoryRoot,
  getApprovedCommit,
  hasRef,
  isAncestor,
  listChangedFiles,
  listRecentBranchCommits,
  listPendingCommits,
  resolveReviewTarget,
  toShortHash
} from "./git";

export type ReviewStateStatus = "ready" | "missing-checkpoint" | "error";

export interface ReviewState {
  status: ReviewStateStatus;
  repositoryPath?: string;
  reviewBranch?: ReviewBranch;
  approvedRef?: string;
  branchCommit?: string;
  branchShortHash?: string;
  approvedCommit?: string;
  approvedShortHash?: string;
  approvedEntry?: PendingCommit;
  comparisonBaseRef?: string;
  comparisonBaseShortHash?: string;
  pendingCommits: PendingCommit[];
  selectedCommit?: PendingCommit;
  changedFiles: ChangedFile[];
  reviewRange?: string;
  message?: string;
}

function isNotGitRepositoryError(error: unknown): boolean {
  return (
    error instanceof GitCommandError &&
    error.stderr.toLowerCase().includes("not a git repository")
  );
}

function isUnknownRevisionError(error: unknown): boolean {
  return (
    error instanceof GitCommandError &&
    /unknown revision|needed a single revision|bad revision|ambiguous argument/i.test(
      error.stderr
    )
  );
}

function buildErrorState(message: string): ReviewState {
  return {
    status: "error",
    pendingCommits: [],
    changedFiles: [],
    message
  };
}

export async function loadReviewState(
  workspacePath: string,
  selectedCommitHash?: string
): Promise<ReviewState> {
  let repositoryPath: string;

  try {
    repositoryPath = await getRepositoryRoot(workspacePath);
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      return buildErrorState("Not a Git repository.");
    }

    throw error;
  }

  const reviewTarget = await resolveReviewTarget(repositoryPath);
  if (!reviewTarget) {
    return buildErrorState("No supported mainline branch found. Expected main or master.");
  }

  const branchCommit = await getBranchCommit(
    repositoryPath,
    reviewTarget.reviewBranch
  );
  const branchShortHash = toShortHash(branchCommit);

  const approvedRefExists = await hasRef(repositoryPath, reviewTarget.approvedRef);
  if (!approvedRefExists) {
    const pendingCommits = await listRecentBranchCommits(
      repositoryPath,
      reviewTarget.reviewBranch
    );
    const selectedCommit =
      pendingCommits.find((commit) => commit.hash === selectedCommitHash) ??
      pendingCommits[0];
    const comparisonBaseRef = selectedCommit
      ? await getParentCommit(repositoryPath, selectedCommit.hash)
      : undefined;
    const changedFiles =
      selectedCommit && comparisonBaseRef
        ? await listChangedFiles(
            repositoryPath,
            comparisonBaseRef,
            selectedCommit.hash
          )
        : [];

    return {
      status: "missing-checkpoint",
      repositoryPath,
      reviewBranch: reviewTarget.reviewBranch,
      approvedRef: reviewTarget.approvedRef,
      branchCommit,
      branchShortHash,
      pendingCommits,
      selectedCommit,
      comparisonBaseRef,
      comparisonBaseShortHash: comparisonBaseRef
        ? toShortHash(comparisonBaseRef)
        : undefined,
      changedFiles,
      reviewRange:
        selectedCommit && comparisonBaseRef
          ? `${comparisonBaseRef}..${selectedCommit.hash}`
          : undefined,
      message: `No approved marker exists yet. Showing the latest ${INITIAL_COMMIT_PREVIEW_COUNT} commits reachable from ${reviewTarget.reviewBranch}.`
    };
  }

  let approvedCommit: string;
  try {
    approvedCommit = await getApprovedCommit(
      repositoryPath,
      reviewTarget.approvedRef
    );
  } catch (error) {
    if (isUnknownRevisionError(error)) {
      return {
        status: "error",
        repositoryPath,
        reviewBranch: reviewTarget.reviewBranch,
        approvedRef: reviewTarget.approvedRef,
        branchCommit,
        branchShortHash,
        pendingCommits: [],
        changedFiles: [],
        message: "The approved marker points to an unknown commit."
      };
    }

    throw error;
  }

  const approvedShortHash = toShortHash(approvedCommit);
  const approvedReachableFromReviewBranch = await isAncestor(
    repositoryPath,
    approvedCommit,
    reviewTarget.reviewBranch
  );
  if (!approvedReachableFromReviewBranch) {
    return {
      status: "error",
      repositoryPath,
      reviewBranch: reviewTarget.reviewBranch,
      approvedRef: reviewTarget.approvedRef,
      branchCommit,
      branchShortHash,
      pendingCommits: [],
      changedFiles: [],
      message: `The approved marker is not reachable from ${reviewTarget.reviewBranch}.`
    };
  }

  const approvedEntry = await getCommitDetails(repositoryPath, approvedCommit);
  const pendingCommits = await listPendingCommits(
    repositoryPath,
    reviewTarget.approvedRef,
    reviewTarget.reviewBranch
  );
  const selectedCommit =
    pendingCommits.find((commit) => commit.hash === selectedCommitHash) ??
    pendingCommits[0];
  const changedFiles = selectedCommit
    ? await listChangedFiles(repositoryPath, approvedCommit, selectedCommit.hash)
    : [];

  return {
    status: "ready",
    repositoryPath,
    reviewBranch: reviewTarget.reviewBranch,
    approvedRef: reviewTarget.approvedRef,
    branchCommit,
    branchShortHash,
    approvedCommit,
    approvedShortHash,
    approvedEntry,
    comparisonBaseRef: approvedCommit,
    comparisonBaseShortHash: approvedShortHash,
    pendingCommits,
    selectedCommit,
    changedFiles,
    reviewRange: selectedCommit ? `${approvedCommit}..${selectedCommit.hash}` : undefined,
    message:
      pendingCommits.length === 0
        ? "Everything in the timeline is approved."
        : undefined
  };
}
