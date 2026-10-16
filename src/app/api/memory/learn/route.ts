import { getServerSession } from "next-auth";
import { NextRequest } from "next/server";
import { z } from "zod";
import { authOptions, githubOAuthConfigured } from "../../../../auth.ts";
import { knowledgeLearningAgent, LearnedPatternsSchema } from "../../../../agents/knowledge-learning/index.ts";
import { isMemoryDatabaseConfigured } from "../../../../db/index.ts";
import { collectLearningReviewHistory } from "../../../../github.ts";
import { getInstallationTokenForRequest, getSelectedRepositoryContextForRequest } from "../../../../github-app.ts";
import { recordLearningReviewEvidence, saveLearnedPatternCandidates } from "../../../../memory-store.ts";

export const runtime = "nodejs";
export const maxDuration = 60;

const LearningRequestSchema = z.object({
  minimumSupportingPullRequests: z.number().int().min(2).max(5),
});

const EvidenceInputSchema = z.object({
  id: z.string(),
  pullRequestNumber: z.number().int(),
  pullRequestTitle: z.string(),
  pullRequestUrl: z.string().url(),
  source: z.enum(["formal-review", "inline-review"]),
  author: z.string(),
  body: z.string(),
  decision: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]).optional(),
  path: z.string().optional(),
  commentUrl: z.string().url(),
  createdAt: z.string(),
  pullRequestOutcome: z.enum(["open", "merged", "closed"]),
});

export async function POST(request: NextRequest): Promise<Response> {
  let requestBody: unknown;
  try { requestBody = await request.json(); } catch {
    return Response.json({ error: "Choose the minimum PR evidence threshold." }, { status: 400 });
  }
  const requestOptions = LearningRequestSchema.safeParse(requestBody);
  if (!requestOptions.success) {
    return Response.json({ error: "The minimum supporting PR count must be between 2 and 5." }, { status: 400 });
  }
  const session = githubOAuthConfigured ? await getServerSession(authOptions) : null;
  const localDeveloperMode = process.env.NODE_ENV !== "production" && process.env.REDZONE_DEV_MODE === "true";
  if (githubOAuthConfigured && !session) {
    return Response.json({ error: "Sign in with GitHub to learn from review history." }, { status: 401 });
  }
  if (!session && !localDeveloperMode) {
    return Response.json({ error: "Learning from review history requires an authenticated GitHub session." }, { status: 401 });
  }
  if (!isMemoryDatabaseConfigured()) {
    return Response.json({ error: "Set DATABASE_URL to save learned patterns." }, { status: 503 });
  }
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "Set OPENAI_API_KEY to generate learned patterns." }, { status: 503 });
  }

  try {
    const { repository, installationId } = await getSelectedRepositoryContextForRequest(request);
    const token = await getInstallationTokenForRequest(request);
    const scan = await collectLearningReviewHistory(repository, token);
    const evidence = scan.evidence
      .filter((item) => item.body.trim().length > 0)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 60)
      .map((item) => ({ ...item, body: item.body.slice(0, 1600) }));
    const storedEvidence = evidence.map((item) => ({
      id: item.id,
      sourceUrl: item.commentUrl,
      source: item.source,
      author: item.author,
      body: item.body,
      pullRequestNumber: item.pullRequestNumber,
      pullRequestTitle: item.pullRequestTitle,
      pullRequestOutcome: item.pullRequestOutcome,
      path: item.path,
      decision: item.decision,
      createdAt: item.createdAt,
    }));
    const evidenceEventsRecorded = await recordLearningReviewEvidence({
      tenantId: String(installationId),
      repository,
      evidence: storedEvidence,
    });

    if (evidence.length < 2) {
      return Response.json({
        status: "insufficient-evidence",
        repository,
        coverage: {
          pullRequestLimit: scan.pullRequestLimit,
          pullRequestsFetched: scan.pullRequestsFetched,
          mayHaveMorePullRequests: scan.mayHaveMorePullRequests,
          reviewItemsFound: scan.evidence.length,
          reviewItemsAnalyzed: evidence.length,
          minimumSupportingPullRequests: requestOptions.data.minimumSupportingPullRequests,
        },
        evidenceEventsRecorded,
        patternsCreated: 0,
        message: "Not enough substantive human review feedback was found to infer recurring patterns.",
      });
    }

    const result = await knowledgeLearningAgent.generate(JSON.stringify({
      task: "Infer only recurring repository-specific engineering guidance from this bounded sample of review history.",
      evidence,
      outputRequirements: [
        `Each proposed pattern must be supported by feedback from at least ${requestOptions.data.minimumSupportingPullRequests} distinct pull requests.`,
        "Cite exact evidence IDs from the supplied evidence array; do not cite pull request numbers or URLs as IDs.",
        "A formal review decision and a pull request outcome are context, not proof that a concern caused a regression or was adopted as policy.",
        "Ignore one-off preferences, generic praise, and feedback that does not express reusable engineering guidance.",
        "When no recurring guidance is supported, return an empty patterns list.",
      ],
    }), { structuredOutput: { schema: LearnedPatternsSchema } });
    const parsed = LearnedPatternsSchema.parse(result.object);
    const evidenceById = new Map(evidence.map((item) => [item.id, EvidenceInputSchema.parse(item)]));
    const seenTitles = new Set<string>();
    const candidates = parsed.patterns.flatMap((pattern) => {
      const titleKey = pattern.title.toLocaleLowerCase();
      if (seenTitles.has(titleKey)) return [];
      seenTitles.add(titleKey);
      const cited = [...new Set(pattern.evidenceIds)]
        .map((id) => evidenceById.get(id))
        .filter((item): item is z.infer<typeof EvidenceInputSchema> => item !== undefined);
      if (cited.length !== new Set(pattern.evidenceIds).size ||
        new Set(cited.map((item) => item.pullRequestNumber)).size < requestOptions.data.minimumSupportingPullRequests) return [];
      return [{
        title: pattern.title,
        summary: pattern.summary,
        evidence: cited.map((item) => ({
          id: item.id,
          sourceUrl: item.commentUrl,
          source: item.source,
          author: item.author,
          body: item.body,
          pullRequestNumber: item.pullRequestNumber,
          pullRequestTitle: item.pullRequestTitle,
          pullRequestOutcome: item.pullRequestOutcome,
          path: item.path,
          decision: item.decision,
          createdAt: item.createdAt,
        })),
      }];
    });

    const saved = await saveLearnedPatternCandidates({
      tenantId: String(installationId),
      repository,
      candidates,
    });
    const response = Response.json({
      status: candidates.length > 0 ? "completed" : "no-patterns-found",
      repository,
      coverage: {
        pullRequestLimit: scan.pullRequestLimit,
        pullRequestsFetched: scan.pullRequestsFetched,
        mayHaveMorePullRequests: scan.mayHaveMorePullRequests,
        reviewItemsFound: scan.evidence.length,
        reviewItemsAnalyzed: evidence.length,
        minimumSupportingPullRequests: requestOptions.data.minimumSupportingPullRequests,
      },
      evidenceEventsRecorded,
      patternsCreated: saved.created,
      evidenceLinksAdded: saved.linked,
      message: candidates.length > 0
        ? `Generated ${saved.created} new candidate pattern${saved.created === 1 ? "" : "s"}. Review and approve them before use.`
        : "No recurring pattern met the evidence threshold in this review-history sample.",
    });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    console.error("[redzone:knowledge-learning] Could not generate patterns", {
      message: error instanceof Error ? error.message : "Unknown learning error",
    });
    return Response.json({ error: "Could not generate learned patterns from this repository's review history." }, { status: 500 });
  }
}
