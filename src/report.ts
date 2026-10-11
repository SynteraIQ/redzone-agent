import type { RedZoneAnalysis } from "./agent.ts";
import type { ReviewCoverage, ReviewEvidence } from "./github.ts";
import type { RepositorySnapshot } from "./history.ts";

type AnalysisReportInput = {
  repositoryPath: string;
  snapshot: RepositorySnapshot;
  analysis: RedZoneAnalysis;
  reviewEvidence: ReviewEvidence[];
  sourceCoverage: ReviewCoverage;
};

function compactText(value: string, maxCharacters: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxCharacters
    ? `${text.slice(0, maxCharacters - 1).trimEnd()}…`
    : text;
}

function evidenceExcerpt(body: string): string {
  const reviewerText = body
    .split(/<details>\s*<summary>🤖 Prompt for AI Agents/i)[0]
    .split("Also applies to:")[0];
  const excerpt = reviewerText
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const maxCharacters = 280;
  return excerpt.length > maxCharacters
    ? `${excerpt.slice(0, maxCharacters - 1).trimEnd()}…`
    : excerpt;
}

function reviewSourceLabel(source: ReviewEvidence["source"]): string {
  switch (source) {
    case "formal-review":
      return "formal review";
    case "inline-review":
      return "inline review";
    case "pr-conversation":
      return "PR conversation";
  }
}

function coverageLines(coverage: ReviewCoverage): string[] {
  if (!coverage.githubConfigured) {
    return ["GitHub PR history was not searched (`GH_REPO` is not configured)."];
  }

  const lines = [
    `Searched ${coverage.pullRequestsFetched} recently updated PRs in \`${coverage.repository}\` ` +
      `(limit ${coverage.pullRequestLimit}); ${coverage.overlappingPullRequests} shared changed file paths.`,
    `Collected ${coverage.evidenceCounts.formalReviews} formal reviews, ` +
      `${coverage.evidenceCounts.inlineComments} inline comments, and ` +
      `${coverage.evidenceCounts.conversationComments} PR conversation comments.`,
  ];
  if (coverage.mayHaveMorePullRequests) {
    lines.push("The search reached its configured limit; older relevant PRs may not be included.");
  }
  if (coverage.evidenceCounts.automatedConversationCommentsSkipped > 0) {
    lines.push(
      `Skipped ${coverage.evidenceCounts.automatedConversationCommentsSkipped} automated PR status comments.`,
    );
  }
  return lines;
}

export function formatAnalysisReport(input: AnalysisReportInput): string {
  const { analysis, reviewEvidence, snapshot, sourceCoverage } = input;
  const riskLabel = analysis.riskLevel === "insufficient-evidence"
    ? "Insufficient evidence"
    : `${analysis.riskLevel[0].toUpperCase()}${analysis.riskLevel.slice(1)} historical signal`;
  const citedCommits = new Set(analysis.commitEvidenceHashes);
  const commitLines = snapshot.history
    .filter((commit) => citedCommits.has(commit.hash))
    .map((commit) => `- \`${commit.hash.slice(0, 12)}\` (${commit.date}) ${commit.subject}`);
  const reviewLines = reviewEvidence.map((item) => {
    const decision = item.decision ? ` · **${item.decision}**` : "";
    const path = item.path ? ` · \`${item.path}\`` : "";
    const excerpt = item.source === "formal-review" ? "" : `\n  > ${evidenceExcerpt(item.body)}`;
    return `- [PR #${item.pullRequestNumber}: ${item.pullRequestTitle}](${item.commentUrl})` +
      ` · ${reviewSourceLabel(item.source)} · @${item.author}${path}${decision} · ${item.createdAt}${excerpt}`;
  });
  const impactLines = analysis.impactGraph.status === "skipped"
    ? [`- ${analysis.impactGraph.note}`]
    : [
        `- Parsed ${analysis.impactGraph.changedFiles.length} changed TypeScript files across ${analysis.impactGraph.filesScanned} tracked source files; found ${analysis.impactGraph.importEdges} import and re-export edges.`,
        `- **Direct dependents:** ${analysis.impactGraph.directDependents.length > 0
          ? analysis.impactGraph.directDependents.slice(0, 8).map((file) => `\`${file}\``).join(", ")
          : "none found"}${analysis.impactGraph.directDependents.length > 8 ? `, and ${analysis.impactGraph.directDependents.length - 8} more` : ""}`,
        `- **Transitive dependents:** ${analysis.impactGraph.transitiveDependents.length > 0
          ? analysis.impactGraph.transitiveDependents.slice(0, 8).map((file) => `\`${file}\``).join(", ")
          : "none found"}${analysis.impactGraph.transitiveDependents.length > 8 ? `, and ${analysis.impactGraph.transitiveDependents.length - 8} more` : ""}`,
        `- ${analysis.impactGraph.note}`,
      ];

  return [
    "# Red Zone analysis",
    "",
    `**Agent assessment:** ${riskLabel}`,
    `**Repository:** \`${input.repositoryPath}\` · **Compared with:** \`${snapshot.baseRef}\``,
    "",
    "## Current change",
    analysis.summary,
    "",
    "## TypeScript import impact",
    ...impactLines,
    "",
    "## Agent checks",
    `- **TypeScript Impact Analyzer** · ${analysis.impactGraph.status} — ${compactText(
      analysis.impactGraph.status === "analyzed"
        ? `${analysis.impactGraph.directDependents.length} direct and ${analysis.impactGraph.transitiveDependents.length} transitive dependent files found.`
        : analysis.impactGraph.note,
      220,
    )}`,
    ...(analysis.agentTrace?.map((agent) =>
      `- **${agent.name}** · ${agent.status} — ${compactText(agent.findings, 220)}`,
    ) ?? []),
    "",
    "## Historical review evidence",
    ...(reviewLines.length > 0 ? reviewLines : ["No review evidence was cited by the agent."]),
    "",
    "## Prior commits cited",
    ...(commitLines.length > 0 ? commitLines : ["No prior commits were cited by the agent."]),
    "",
    "## Search coverage",
    ...coverageLines(sourceCoverage).map((line) => `- ${line}`),
    "",
    "Historical review concerns are not evidence of a production incident.",
    ...(analysis.followUpQuestions.length > 0
      ? ["", "## Follow-up questions", ...analysis.followUpQuestions.map((question) => `- ${question}`)]
      : []),
  ].join("\n");
}
