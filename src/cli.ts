import { resolve } from "node:path";
import { analyzeSnapshot } from "./agent.ts";
import { collectRepositorySnapshot } from "./history.ts";
import { collectReviewEvidence } from "./github.ts";

const repositoryPath = resolve(process.cwd());
const baseRef = process.argv[2] ?? "main";

if (!process.env.OPENAI_API_KEY) {
  console.error("Set OPENAI_API_KEY before running the Red Zone Agent.");
  process.exitCode = 1;
} else {
  try {
    const snapshot = collectRepositorySnapshot(repositoryPath, baseRef);
    if (snapshot.changedFiles.length === 0) {
      console.log(`No changed files found between ${baseRef} and HEAD.`);
    } else {
      const reviewEvidence = collectReviewEvidence(snapshot);
      const analysis = await analyzeSnapshot(snapshot, reviewEvidence);
      console.log(JSON.stringify({
        repositoryPath,
        baseRef: snapshot.baseRef,
        headRef: snapshot.headRef,
        changedFiles: snapshot.changedFiles,
        analysis: {
          ...analysis,
          commitEvidence: analysis.commitEvidenceHashes.map((hash) =>
            snapshot.history.find((commit) => commit.hash === hash),
          ).filter(Boolean),
          reviewEvidence: reviewEvidence.filter((comment) =>
            analysis.reviewEvidenceIds.includes(comment.id),
          ),
        },
      }, null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
