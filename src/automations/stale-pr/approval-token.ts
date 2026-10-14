export function createStalePullRequestApprovalToken(approvalRequestId: string): string {
  return `stale-pr-approval:${approvalRequestId}`;
}
