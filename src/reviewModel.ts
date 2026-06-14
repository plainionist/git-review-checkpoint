import {
  APPROVED_REF,
  ChangedFile,
  GitCommandError,
  INITIAL_COMMIT_PREVIEW_COUNT,
  PendingCommit,
  getParentCommit,
  getMasterCommit,
  getRepositoryRoot,
  getApprovedCommit,
  hasRef,
  listChangedFiles,
  listRecentMasterCommits,
  listPendingCommits,
  toShortHash
} from "./git";

export type ReviewStateStatus = "ready" | "missing-checkpoint" | "error";

export interface ReviewState {
  status: ReviewStateStatus;
  repositoryPath?: string;
  masterCommit?: string;
  masterShortHash?: string;
  approvedCommit?: string;
  approvedShortHash?: string;
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

  const hasMaster = await hasRef(repositoryPath, "refs/heads/master");
  if (!hasMaster) {
    return buildErrorState("No master branch found.");
  }

  const masterCommit = await getMasterCommit(repositoryPath);
  const masterShortHash = toShortHash(masterCommit);

  const approvedRefExists = await hasRef(repositoryPath, APPROVED_REF);
  if (!approvedRefExists) {
    const pendingCommits = await listRecentMasterCommits(repositoryPath);
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
      masterCommit,
      masterShortHash,
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
      message: `No approved marker exists yet. Showing the latest ${INITIAL_COMMIT_PREVIEW_COUNT} commits on master.`
    };
  }

  let approvedCommit: string;
  try {
    approvedCommit = await getApprovedCommit(repositoryPath);
  } catch (error) {
    if (isUnknownRevisionError(error)) {
      return {
        status: "error",
        repositoryPath,
        masterCommit,
        masterShortHash,
        pendingCommits: [],
        changedFiles: [],
        message: "The approved marker points to an unknown commit."
      };
    }

    throw error;
  }

  const approvedShortHash = toShortHash(approvedCommit);
  const pendingCommits = await listPendingCommits(repositoryPath);
  const selectedCommit =
    pendingCommits.find((commit) => commit.hash === selectedCommitHash) ??
    pendingCommits[0];
  const changedFiles = selectedCommit
    ? await listChangedFiles(repositoryPath, approvedCommit, selectedCommit.hash)
    : [];

  return {
    status: "ready",
    repositoryPath,
    masterCommit,
    masterShortHash,
    approvedCommit,
    approvedShortHash,
    comparisonBaseRef: approvedCommit,
    comparisonBaseShortHash: approvedShortHash,
    pendingCommits,
    selectedCommit,
    changedFiles,
    reviewRange: selectedCommit ? `${approvedCommit}..${selectedCommit.hash}` : undefined,
    message:
      pendingCommits.length === 0
        ? "Everything up to master is approved."
        : undefined
  };
}
