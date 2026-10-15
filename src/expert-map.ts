import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ExpertMapActivity, ExpertMapScan } from "./github.ts";

export type CodeOwnerRule = {
  pattern: string;
  owners: string[];
};

export type ExpertContributorSummary = {
  author: string;
  profileUrl: string;
  submittedPullRequestCount: number;
  reviewedPullRequestCount: number;
  reviewCount: number;
  writtenFeedbackCount: number;
  approvals: number;
  changesRequested: number;
  mergedPullRequestCount: number;
  latestActivityAt: string;
  evidence: Array<Pick<ExpertMapActivity, "pullRequestNumber" | "pullRequestTitle" | "pullRequestUrl" | "pullRequestOutcome" | "reviewUrl" | "createdAt" | "source" | "decision" | "hasWrittenFeedback">>;
};

export type ExpertArea = {
  path: string;
  codeOwners: string[];
  contributors: ExpertContributorSummary[];
};

export type ExpertMap = {
  repository: string;
  scannedPullRequests: number;
  pullRequestLimit: number;
  mayHaveMorePullRequests: boolean;
  pullRequestsWithReviewEvidence: number;
  codeownersFile: string | null;
  ownershipRules: CodeOwnerRule[];
  areas: ExpertArea[];
};

const codeownersLocations = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

function parseCodeowners(contents: string): CodeOwnerRule[] {
  return contents.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .flatMap((line) => {
      const [pattern, ...owners] = line.split(/\s+/);
      return pattern ? [{ pattern, owners }] : [];
    });
}

function globPatternMatches(pattern: string, filePath: string): boolean {
  const anchored = pattern.startsWith("/");
  let source = pattern.replace(/^\//, "");
  const matchAtAnyDepth = !anchored && !source.replace(/\/$/, "").includes("/");
  if (source.endsWith("/")) source += "**";
  let expression = "";
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    const nextCharacter = source[index + 1];
    if (character === "*" && nextCharacter === "*") {
      if (source[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index++;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += "|\\{}()[]^$+.".includes(character) ? `\\${character}` : character;
    }
  }
  const sourceExpression = matchAtAnyDepth
    ? `(?:^|/)${expression}(?:/.*)?$`
    : `^${expression}$`;
  return new RegExp(sourceExpression).test(filePath.replace(/^\//, ""));
}

function ownersForPath(filePath: string, rules: CodeOwnerRule[]): string[] {
  let owners: string[] = [];
  for (const rule of rules) {
    if (globPatternMatches(rule.pattern, filePath)) owners = rule.owners;
  }
  return owners;
}

function readCodeowners(
  repositoryPath: string,
  remoteCodeowners?: { file: string; contents: string } | null,
): { file: string | null; rules: CodeOwnerRule[] } {
  if (remoteCodeowners !== undefined) {
    return remoteCodeowners
      ? { file: remoteCodeowners.file, rules: parseCodeowners(remoteCodeowners.contents) }
      : { file: null, rules: [] };
  }
  for (const location of codeownersLocations) {
    const filePath = path.join(/*turbopackIgnore: true*/ repositoryPath, location);
    if (!existsSync(filePath)) continue;
    try {
      return { file: location, rules: parseCodeowners(readFileSync(filePath, "utf8")) };
    } catch {
      return { file: location, rules: [] };
    }
  }
  return { file: null, rules: [] };
}

function summarizeContributors(records: ExpertMapActivity[]): ExpertContributorSummary[] {
  const byAuthor = new Map<string, ExpertMapActivity[]>();
  for (const record of records) {
    const current = byAuthor.get(record.author) ?? [];
    current.push(record);
    byAuthor.set(record.author, current);
  }
  return [...byAuthor.entries()].map(([author, authorRecords]) => {
    const reviewRecords = authorRecords.filter((record) => record.source !== "submission");
    const submittedPullRequests = new Set(authorRecords
      .filter((record) => record.source === "submission")
      .map((record) => record.pullRequestNumber));
    const reviewedPullRequests = new Set(reviewRecords.map((record) => record.pullRequestNumber));
    const uniqueEvidence = new Map(authorRecords.map((record) => [record.reviewId, record]));
    const evidence = [...uniqueEvidence.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return {
      author,
      profileUrl: `https://github.com/${author}`,
      submittedPullRequestCount: submittedPullRequests.size,
      reviewedPullRequestCount: reviewedPullRequests.size,
      reviewCount: reviewRecords.length,
      writtenFeedbackCount: reviewRecords.filter((record) => record.hasWrittenFeedback).length,
      approvals: reviewRecords.filter((record) => record.decision === "APPROVED").length,
      changesRequested: reviewRecords.filter((record) => record.decision === "CHANGES_REQUESTED").length,
      mergedPullRequestCount: new Set(evidence
        .filter((record) => record.pullRequestOutcome === "merged")
        .map((record) => record.pullRequestNumber)).size,
      latestActivityAt: evidence[0]?.createdAt ?? "",
      evidence: evidence.slice(0, 5).map(({ pullRequestNumber, pullRequestTitle, pullRequestUrl, pullRequestOutcome, reviewUrl, createdAt, source, decision, hasWrittenFeedback }) => ({
        pullRequestNumber,
        pullRequestTitle,
        pullRequestUrl,
        pullRequestOutcome,
        reviewUrl,
        createdAt,
        source,
        decision,
        hasWrittenFeedback,
      })),
    };
  }).sort((left, right) => right.latestActivityAt.localeCompare(left.latestActivityAt));
}

export function buildExpertMap(
  scan: ExpertMapScan,
  repositoryPath: string,
  remoteCodeowners?: { file: string; contents: string } | null,
): ExpertMap {
  const codeowners = readCodeowners(repositoryPath, remoteCodeowners);
  const recordsByPath = new Map<string, ExpertMapActivity[]>();
  for (const record of scan.records) {
    const current = recordsByPath.get(record.filePath) ?? [];
    current.push(record);
    recordsByPath.set(record.filePath, current);
  }
  const allPaths = new Set([...recordsByPath.keys(), ...codeowners.rules.map((rule) => rule.pattern)]);
  const areas = [...allPaths].map((filePath) => ({
    path: filePath,
    codeOwners: ownersForPath(filePath, codeowners.rules),
    contributors: summarizeContributors(recordsByPath.get(filePath) ?? []),
  })).sort((left, right) => left.path.localeCompare(right.path));

  return {
    repository: scan.repository,
    scannedPullRequests: scan.pullRequestsFetched,
    pullRequestLimit: scan.pullRequestLimit,
    mayHaveMorePullRequests: scan.mayHaveMorePullRequests,
    pullRequestsWithReviewEvidence: scan.pullRequestsWithReviewEvidence,
    codeownersFile: codeowners.file,
    ownershipRules: codeowners.rules,
    areas,
  };
}
