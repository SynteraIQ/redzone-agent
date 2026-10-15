import type { RedZoneAnalysis } from "./agent.ts";
import type { ReviewCoverage, ReviewEvidence } from "./github.ts";
import type { AppliedMemory } from "./memory-store.ts";
import type { RepositorySnapshot } from "./history.ts";
import type { EvidenceReference } from "./analysis-evidence.ts";

type AnalysisReportInput = {
  repositoryPath: string;
  repository?: string;
  snapshot: RepositorySnapshot;
  analysis: RedZoneAnalysis;
  reviewEvidence: ReviewEvidence[];
  sourceCoverage: ReviewCoverage;
  appliedMemories?: AppliedMemory[];
};

function compactText(value: string, maxCharacters: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxCharacters
    ? `${text.slice(0, maxCharacters - 1).trimEnd()}…`
    : text;
}

function formatEvidenceReference(
  reference: Omit<EvidenceReference, "provenance"> & { provenance?: EvidenceReference["provenance"] },
): string {
  const revision = reference.provenance?.revision
    ? ` · ${reference.provenance.revision.slice(0, 12)}`
    : "";
  const baseRef = reference.provenance?.baseRef ? ` · base ${reference.provenance.baseRef}` : "";
  const baseRevision = reference.provenance?.baseRevision
    ? ` (${reference.provenance.baseRevision.slice(0, 12)})`
    : "";
  const date = reference.provenance?.date ? ` · ${reference.provenance.date}` : "";
  const workingTree = reference.provenance?.includesWorkingTree ? " · includes working tree" : "";
  const provenance = reference.provenance
    ? ` (${reference.provenance.source}${revision}${baseRef}${baseRevision}${date}${workingTree})`
    : "";
  const labelBudget = Math.max(0, 260 - provenance.length);
  const label = `${labelBudget > 0 ? compactText(reference.label, labelBudget) : ""}${provenance}`
    .replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
  if (!reference.url) return label;
  try {
    const url = new URL(reference.url);
    if (url.protocol !== "https:") return label;
    return `[${label}](${url.toString()})`;
  } catch {
    return label;
  }
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
  return compactText(excerpt, 180);
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

function suggestedReviewers(analysis: RedZoneAnalysis, reviewEvidence: ReviewEvidence[]): string[] {
  const reviewContext = analysis.agentTrace?.find((agent) => agent.name.toLowerCase().includes("review context"));
  const relevantIds = new Set(
    (reviewContext?.evidence ?? [])
      .filter((reference) => reference.kind === "review")
      .map((reference) => reference.id.slice("review:".length)),
  );
  const candidates = new Map<string, { pullRequests: Set<number>; latestReview: string; evidence: ReviewEvidence[] }>();

  for (const item of reviewEvidence) {
    if (!relevantIds.has(item.id) || !/^[A-Za-z0-9-]{1,39}$/.test(item.author) || item.author === "unknown") continue;
    const candidate = candidates.get(item.author) ?? {
      pullRequests: new Set<number>(),
      latestReview: "",
      evidence: [],
    };
    candidate.pullRequests.add(item.pullRequestNumber);
    candidate.evidence.push(item);
    if (item.createdAt > candidate.latestReview) candidate.latestReview = item.createdAt;
    candidates.set(item.author, candidate);
  }

  return [...candidates.entries()].flatMap(([author, candidate]) => {
    const profileUrl = `https://github.com/${author}`;
    const prCount = candidate.pullRequests.size;
    const latestDate = candidate.latestReview.slice(0, 10);
    const supportingEvidence = candidate.evidence.map((item) => formatEvidenceReference({
      id: `review:${item.id}`,
      kind: "review",
      label: `PR #${item.pullRequestNumber} ${reviewSourceLabel(item.source)}${item.decision ? ` · ${item.decision}` : ""}${item.path ? ` · ${item.path}` : ""}`,
      url: item.commentUrl,
    }));
    return [
      `- [@${author}](${profileUrl}) · cited in ${candidate.evidence.length} relevant review record${candidate.evidence.length === 1 ? "" : "s"} across ${prCount} PR${prCount === 1 ? "" : "s"} · latest ${latestDate}`,
      `  - Basis: ${supportingEvidence.join("; ")}`,
    ];
  });
}

function coverageLines(coverage: ReviewCoverage): string[] {
  if (!coverage.githubConfigured) {
    return ["GitHub PR history was not searched (no repository was selected)."];
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

function pathHistoryCoverageLine(snapshot: RepositorySnapshot): string | undefined {
  if (!snapshot.historyCoverage) return undefined;
  const coverage = snapshot.historyCoverage;
  const failure = coverage.pathsFailed > 0 ? `; ${coverage.pathsFailed} path queries failed` : "";
  const suffix = coverage.mayHaveMore ? "; older or additional path history may be missing" : "";
  return `Rollback history inspected up to ${coverage.commitsPerPath} commits for ${coverage.pathsSearched} of ${coverage.pathsTotal} changed paths${failure}${suffix}.`;
}

export function formatAnalysisReport(input: AnalysisReportInput): string {
  const { analysis, reviewEvidence, snapshot, sourceCoverage } = input;
  const riskLabel = analysis.riskLevel === "insufficient-evidence"
    ? "Insufficient evidence"
    : `${analysis.riskLevel[0].toUpperCase()}${analysis.riskLevel.slice(1)} historical signal`;
  const citedCommits = new Set(analysis.commitEvidenceHashes);
  const citedEvidenceById = new Map(analysis.synthesisEvidence.map((reference) => [reference.id, reference]));
  const citedReviewIds = new Set([
    ...analysis.reviewEvidenceIds,
    ...(analysis.agentTrace ?? [])
      .filter((agent) => agent.name.toLowerCase().includes("review context"))
      .flatMap((agent) => agent.evidence)
      .filter((reference) => reference.kind === "review")
      .map((reference) => reference.id.slice("review:".length)),
  ]);
  const workingTreeLine = snapshot.source === "github-pull-request"
    ? input.repository && snapshot.pullRequestNumber
      ? `**Pull request:** [#${snapshot.pullRequestNumber}](https://github.com/${input.repository}/pull/${snapshot.pullRequestNumber})`
      : "**Change source:** GitHub pull request snapshot"
    : snapshot.workingTreeFiles.length > 0
      ? `**Uncommitted tracked files:** ${snapshot.workingTreeFiles.slice(0, 5).map((path) => `\`${path}\``).join(", ")}` +
        (snapshot.workingTreeFiles.length > 5 ? `, and ${snapshot.workingTreeFiles.length - 5} more` : "")
      : "**Uncommitted tracked files:** none";
  const commitLines = snapshot.history
    .filter((commit) => citedCommits.has(commit.hash))
    .map((commit) => {
      const reference = citedEvidenceById.get(`commit:${commit.hash}`);
      const hashLabel = `\`${commit.hash.slice(0, 12)}\``;
      const linkedHash = reference?.url
        ? `[${hashLabel}](${reference.url})`
        : hashLabel;
      return `- ${linkedHash} · ${commit.date} · ${compactText(commit.subject, 140)}`;
    });
  const citedReviewEvidence = reviewEvidence.filter((item) => citedReviewIds.has(item.id));
  const reviewLines = citedReviewEvidence.slice(0, 5).map((item) => {
    const decision = item.decision ? ` · **${item.decision}**` : "";
    const path = item.path ? ` · \`${item.path}\`` : "";
    const excerpt = evidenceExcerpt(item.body);
    return `- [PR #${item.pullRequestNumber}](${item.commentUrl}) · ${reviewSourceLabel(item.source)}${path}${decision}` +
      (excerpt ? ` — ${excerpt}` : "");
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
  const maintainerReviewReasons = [
    ...(analysis.riskLevel === "insufficient-evidence"
      ? ["No relevant historical evidence supported a risk assessment."]
      : []),
    ...(sourceCoverage.mayHaveMorePullRequests
      ? ["The GitHub search reached its configured limit; older relevant PRs may be missing."]
      : []),
    ...(!sourceCoverage.githubConfigured
      ? ["GitHub review history was not searched for this run."]
      : []),
  ];
  const reviewerSuggestions = suggestedReviewers(analysis, reviewEvidence);
  const appliedMemories = input.appliedMemories ?? [];

  return [
    "# Red Zone result",
    "",
    `**Risk:** ${riskLabel}  `,
    `**Repository:** \`${input.repository ?? sourceCoverage.repository ?? input.repositoryPath}\` · **Base:** \`${snapshot.baseRef}\``,
    workingTreeLine,
    ...(snapshot.source === "github-pull-request" ? [] : ["Untracked files are not included in this analysis."]),
    "",
    "## Change",
    compactText(analysis.summary, 360),
    "",
    "## Agent checks",
    ...(analysis.agentTrace?.flatMap((agent) => [
      `- **${agent.name}** · ${agent.status} — ${compactText(agent.findings, 220)}`,
      ...(agent.evidence.length > 0
        ? [`  - Evidence: ${agent.evidence.map(formatEvidenceReference).join("; ")}`]
        : []),
      ...(agent.limitations.length > 0
        ? [`  - Limits: ${agent.limitations.map((limitation) => compactText(limitation, 180)).join("; ")}`]
        : []),
    ]) ?? ["Specialist delegation activity was not available for this run."]),
    "",
    "## Planner synthesis",
    compactText(analysis.rationale, 900),
    ...(analysis.synthesisEvidence.length > 0
      ? [`Evidence: ${analysis.synthesisEvidence.map(formatEvidenceReference).join("; ")}`]
      : ["Evidence: no historical sources were cited."]),
    "",
    "## Repository memory",
    ...(appliedMemories.length > 0
      ? ["Human-approved memory was included as contextual guidance (not incident evidence):",
        ...appliedMemories.map((memory) => `- **${compactText(memory.title, 180)}** · ${memory.kind} v${memory.version}: ${compactText(memory.summary, 240)}`)]
      : ["No active repository memory was applied to this run."]),
    "",
    "## Maintainer review",
    ...(maintainerReviewReasons.length > 0
      ? ["**Recommended** — validate the change with a maintainer before relying on this assessment.",
        ...maintainerReviewReasons.map((reason) => `- ${compactText(reason, 220)}`)]
      : ["Historical evidence was available for this assessment. Confirm that the cited sources still apply to the current behavior."]),
    ...(reviewerSuggestions.length > 0
      ? ["", "**Potential maintainers to consult** (based on relevant prior review history):", ...reviewerSuggestions,
        "Current team role and availability are not verified; treat these as reviewer suggestions, not confirmed maintainers."]
      : []),
    "",
    "## Evidence",
    ...commitLines.slice(0, 5),
    ...reviewLines,
    ...(commitLines.length > 5 ? [`- ${commitLines.length - 5} more cited commits omitted.`] : []),
    ...(citedReviewEvidence.length > 5 ? [`- ${citedReviewEvidence.length - 5} more cited reviews omitted.`] : []),
    ...(commitLines.length === 0 && reviewLines.length === 0 ? ["No historical evidence was cited."] : []),
    "",
    "## Coverage",
    ...coverageLines(sourceCoverage).map((line) => `- ${compactText(line, 220)}`),
    ...(snapshot.limitations ?? []).map((limitation) => `- ${compactText(limitation, 220)}`),
    ...(pathHistoryCoverageLine(snapshot) ? [`- ${compactText(pathHistoryCoverageLine(snapshot) ?? "", 220)}`] : []),
    "",
    ...(analysis.followUpQuestions.length > 0
      ? ["## Follow-up", ...analysis.followUpQuestions.slice(0, 3).map((question) => `- ${compactText(question, 180)}`)]
      : []),
    "",
    "Review concerns are signals, not proof of a production incident.",
  ].join("\n");
}
