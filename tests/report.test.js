import assert from "node:assert/strict";
import test from "node:test";
import { formatAnalysisReport } from "../src/report.ts";

function reportForReference(reference, reviewEvidence = []) {
  return formatAnalysisReport({
    repositoryPath: "/repo",
    snapshot: { baseRef: "main", workingTreeFiles: [], history: [] },
    reviewEvidence,
    sourceCoverage: { githubConfigured: false },
    analysis: {
      summary: "Summary", riskLevel: "low", rationale: "Rationale",
      commitEvidenceHashes: [], reviewEvidenceIds: [], followUpQuestions: [],
      impactGraph: { status: "skipped", note: "No impact analysis" },
      synthesisEvidence: [reference],
      agentTrace: [{
        name: "Review Context Agent", status: "completed", findings: "Finding",
        evidence: [reference], limitations: [],
      }],
    },
  });
}

function reportReferenceLabels(reference) {
  const report = reportForReference(reference);
  return report.split("\n")
    .filter((line) => /^(?:  - )?Evidence: /.test(line))
    .map((line) => {
      const evidence = line.slice(line.indexOf("Evidence: ") + "Evidence: ".length);
      if (reference.url) {
        assert.ok(evidence.startsWith("["));
        assert.ok(evidence.endsWith(`](${reference.url})`));
      }
      const label = reference.url
        ? evidence.slice(1, -`](${reference.url})`.length)
        : evidence;
      return label.replace(/\\([\\`*_{}\[\]()#+\-.!|>])/g, "$1");
    });
}

test("reserves provenance space when compacting report reference labels", () => {
  const provenance = {
    source: "git-diff", revision: "1234567890abcdef1234567890abcdef12345678",
    baseRef: "feature/review", baseRevision: "abcdef1234567890abcdef1234567890abcdef12",
    date: "2026-10-12", includesWorkingTree: true,
  };
  const suffix = " (git-diff · 1234567890ab · base feature/review (abcdef123456) · 2026-10-12 · includes working tree)";
  const budget = 260 - suffix.length;
  for (const url of [undefined, "https://example.invalid/commit/123"]) {
    for (const length of [10, budget, budget + 1, 500]) {
      const reference = { label: "x".repeat(length), provenance, url };
      const labels = reportReferenceLabels(reference);
      assert.equal(labels.length, 2);
      for (const label of labels) {
        assert.ok(label.endsWith(suffix));
        assert.equal(label.length, Math.min(length, budget) + suffix.length);
        assert.equal(label.includes("…"), length > budget);
      }
    }
  }
});

test("preserves provenance when it consumes the entire reference label budget", () => {
  const source = "static-analysis";
  const baseRef = "b".repeat(260 - ` (${source} · base )`.length);
  const suffix = ` (${source} · base ${baseRef})`;
  const labels = reportReferenceLabels({ label: "Description", provenance: { source, baseRef } });
  assert.deepEqual(labels, [suffix, suffix]);
});

test("formats change and impact references without provenance", () => {
  for (const kind of ["change", "impact"]) {
    for (const url of [undefined, "https://example.invalid/file"]) {
      const label = `${kind}: src/[file].ts ` + "x".repeat(300);
      const labels = reportReferenceLabels({ id: `${kind}:file`, kind, label, url });
      assert.deepEqual(labels, [label.slice(0, 259) + "…", label.slice(0, 259) + "…"]);
    }
  }
});

test("formats reviewer suggestion references without provenance", () => {
  const review = {
    id: "review-1", source: "inline-review", author: "reviewer", body: "Feedback",
    pullRequestNumber: 42, path: "src/file.ts", createdAt: "2026-10-13",
    commentUrl: "https://example.invalid/review/1",
  };
  const report = reportForReference({
    id: "review:review-1", kind: "review", label: "Relevant review",
    provenance: { source: "github-review", date: review.createdAt },
  }, [review]);
  assert.ok(report.includes("- [@reviewer](https://github.com/reviewer)"));
  assert.ok(report.includes("  - Basis: [PR \\#42 inline review · src/file\\.ts](https://example.invalid/review/1)"));
  assert.ok(!report.includes("undefined"));
});
