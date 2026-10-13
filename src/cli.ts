import { resolve } from "node:path";
import { analyzeSnapshot } from "./agent.ts";
import { collectRepositorySnapshot } from "./history.ts";
import { collectReviewEvidence } from "./github.ts";
import { formatAnalysisReport } from "./report.ts";

const repositoryPath = resolve(process.cwd());
const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const baseRefs = args.filter((argument) => argument !== "--json");
const unknownOptions = baseRefs.filter((argument) => argument.startsWith("--"));
const baseRef = baseRefs[0] ?? "main";

if (unknownOptions.length > 0 || baseRefs.length > 1) {
  console.error("Usage: npm run analyze -- [base-ref] [--json]");
  process.exitCode = 1;
} else if (!process.env.OPENAI_API_KEY) {
  console.error("Set OPENAI_API_KEY before running the Red Zone Agent.");
  process.exitCode = 1;
} else {
  try {
    const snapshot = collectRepositorySnapshot(repositoryPath, baseRef);
    if (snapshot.changedFiles.length === 0) {
      console.log(`No changed files found between ${baseRef} and HEAD.`);
    } else {
      const reviewCollection = await collectReviewEvidence(snapshot);
      const analysis = await analyzeSnapshot(
        snapshot,
        reviewCollection.evidence,
        reviewCollection.coverage,
      );
      const result = {
        repositoryPath,
        baseRef: snapshot.baseRef,
        headRef: snapshot.headRef,
        changedFiles: snapshot.changedFiles,
        sourceCoverage: reviewCollection.coverage,
        analysis: {
          ...analysis,
          commitEvidence: analysis.commitEvidenceHashes.map((hash) =>
            snapshot.history.find((commit) => commit.hash === hash),
          ).filter(Boolean),
          reviewEvidence: reviewCollection.evidence.filter((comment) =>
            analysis.reviewEvidenceIds.includes(comment.id),
          ),
        },
      };
      console.log(jsonOutput
        ? JSON.stringify(result, null, 2)
        : formatAnalysisReport({
            repositoryPath,
            snapshot,
            analysis,
            reviewEvidence: reviewCollection.evidence.filter((comment) =>
              analysis.reviewEvidenceIds.includes(comment.id),
            ),
            sourceCoverage: reviewCollection.coverage,
          }));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
