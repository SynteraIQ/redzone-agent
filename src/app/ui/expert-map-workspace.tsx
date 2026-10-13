"use client";

import { useMemo, useState } from "react";
import type { ExpertContributorSummary, ExpertMap } from "../../expert-map.ts";

type ExpertMapWorkspaceProps = {
  repository: string;
  connected: boolean;
  configured: boolean;
};

type ExpertMapResponse = ExpertMap & { error?: string };

function ContributorCard({ contributor }: { contributor: ExpertContributorSummary }) {
  const role = contributor.submittedPullRequestCount > 0 && contributor.reviewedPullRequestCount > 0
    ? "Historical submitter and reviewer"
    : contributor.submittedPullRequestCount > 0
      ? "Historical PR submitter"
      : "Historical reviewer";

  return (
    <article className="expert-reviewer">
      <div className="expert-reviewer-heading">
        <a href={contributor.profileUrl} target="_blank" rel="noreferrer">@{contributor.author}</a>
        <span>{role} · current role unverified</span>
      </div>
      <div className="expert-signals">
        <span><strong>{contributor.submittedPullRequestCount}</strong> PRs submitted</span>
        <span><strong>{contributor.reviewedPullRequestCount}</strong> PRs reviewed</span>
        <span><strong>{contributor.reviewCount}</strong> review records</span>
        <span><strong>{contributor.writtenFeedbackCount}</strong> with written feedback</span>
        <span><strong>{contributor.approvals}</strong> approved</span>
        <span><strong>{contributor.changesRequested}</strong> changes requested</span>
        <span><strong>{contributor.mergedPullRequestCount}</strong> on merged PRs</span>
        <span>Latest {contributor.latestActivityAt.slice(0, 10) || "unknown"}</span>
      </div>
      <ul className="expert-evidence">
        {contributor.evidence.map((evidence) => (
          <li key={`${evidence.source}-${evidence.reviewUrl}`}>
            <a href={evidence.reviewUrl} target="_blank" rel="noreferrer" title={evidence.pullRequestTitle}>PR #{evidence.pullRequestNumber}</a>
            <span>{evidence.source === "submission" ? "submitted" : evidence.decision ?? evidence.source.replaceAll("-", " ")} · {evidence.pullRequestOutcome} · {evidence.createdAt.slice(0, 10)}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

function codeOwnerLink(owner: string) {
  if (!owner.startsWith("@")) return null;
  const account = owner.slice(1);
  const [organization, team] = account.split("/");
  const href = team
    ? `https://github.com/orgs/${organization}/teams/${team}`
    : `https://github.com/${organization}`;
  return <a href={href} target="_blank" rel="noreferrer" key={owner}>{owner}</a>;
}

export function ExpertMapWorkspace({ repository, connected, configured }: ExpertMapWorkspaceProps) {
  const [expertMap, setExpertMap] = useState<ExpertMap | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visibleAreas = useMemo(() => {
    if (!expertMap) return [];
    const query = search.trim().toLowerCase();
    if (!query) return expertMap.areas;
    return expertMap.areas.filter((area) =>
      area.path.toLowerCase().includes(query) ||
      area.codeOwners.some((owner) => owner.toLowerCase().includes(query)) ||
      area.contributors.some((contributor) => contributor.author.toLowerCase().includes(query)),
    );
  }, [expertMap, search]);

  async function buildMap() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/expert-map", { method: "POST" });
      const result = await response.json() as ExpertMapResponse;
      if (!response.ok) throw new Error(result.error ?? "Could not build the expert map.");
      setExpertMap(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not build the expert map.");
    } finally {
      setLoading(false);
    }
  }

  if (!configured) {
    return <div className="expert-map-empty"><h2>GitHub App setup needed</h2><p>Configure the GitHub App before scanning repository review history.</p></div>;
  }
  if (!connected) {
    return <div className="expert-map-empty"><h2>Connect GitHub to continue</h2><p>Install the RedZone GitHub App on the repository to build its expert map.</p><a className="plan-button" href="/api/github/install">Connect GitHub App <span>↗</span></a></div>;
  }
  if (repository === "Select a repository") {
    return <div className="expert-map-empty"><h2>Select a repository</h2><p>Choose the repository matching the current local checkout before building its expert map.</p><a className="plan-button" href="/repositories">Open Repositories <span>↗</span></a></div>;
  }

  return (
    <section className="expert-map-workspace">
      <div className="expert-map-toolbar">
        <div><span className="section-kicker">REVIEW HISTORY + CODE OWNERS</span><h2>{repository}</h2></div>
        <button className="plan-button" type="button" onClick={buildMap} disabled={loading}>
          {loading ? <><span className="spinner" /> Scanning history</> : <>{expertMap ? "Rescan repository" : "Build expert map"} <span>↗</span></>}
        </button>
      </div>
      <p className="expert-map-description">Maps CODEOWNERS rules alongside people who submitted or reviewed recent pull requests. It shows each contribution and outcome without assigning an opaque expertise score.</p>
      {error && <div className="plan-error" role="alert">{error}</div>}
      {!expertMap ? (
        <div className="expert-map-empty"><h2>Build a repository expert map</h2><p>RedZone will inspect recent pull requests, changed paths, formal review decisions, and inline feedback. This is an on-demand scan; results are not persisted.</p></div>
      ) : (
        <>
          <div className="expert-map-coverage">
            <span><strong>{expertMap.scannedPullRequests}</strong> PRs scanned</span>
            <span><strong>{expertMap.pullRequestsWithReviewEvidence}</strong> with review evidence</span>
            <span><strong>{expertMap.areas.length}</strong> paths mapped</span>
            <span><strong>{expertMap.ownershipRules.length}</strong> CODEOWNERS rules</span>
          </div>
          {expertMap.mayHaveMorePullRequests && <p className="expert-map-note">The scan reached its configured limit of {expertMap.pullRequestLimit} PRs; older review history may be missing.</p>}
          {!expertMap.codeownersFile && <p className="expert-map-note">No CODEOWNERS file was found in the local checkout. Review history can still suggest prior reviewers, but code ownership is not configured here.</p>}
          {expertMap.codeownersFile && <p className="expert-map-note">Ownership rules read from <code>{expertMap.codeownersFile}</code>. GitHub membership and current availability are not inferred from review history.</p>}
          <label className="expert-map-search"><span>FILTER PATH OR CONTRIBUTOR</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="src/ or username" /></label>
          <div className="expert-map-areas">
            {visibleAreas.length === 0 ? <div className="expert-map-empty">No paths or contributors match this filter.</div> : visibleAreas.map((area) => (
              <article className="expert-area" key={area.path}>
                <header><code>{area.path}</code><div className="expert-owners">{area.codeOwners.length > 0 ? area.codeOwners.map(codeOwnerLink) : <span>No CODEOWNERS rule</span>}</div></header>
                {area.contributors.length > 0 ? <div className="expert-reviewers">{area.contributors.map((contributor) => <ContributorCard key={contributor.author} contributor={contributor} />)}</div> : <p className="expert-map-note">No submitter or review activity was found for this path in the scanned PRs.</p>}
              </article>
            ))}
          </div>
          <p className="expert-map-disclaimer">Review activity and approval decisions are historical signals, not proof of expertise, current ownership, or availability. A merged PR does not prove that a reviewer caused the merge.</p>
        </>
      )}
    </section>
  );
}
