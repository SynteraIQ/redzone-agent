# RedZone Review Board — Product Requirements Document

**Status:** Draft for discussion and Linear breakdown  
**Product:** RedZone Agent  
**Working feature name:** Review Board  
**Audience:** Open-source contributors, engineering teams, and maintainers

## 1. Product summary

RedZone helps reviewers assess risky code changes by gathering repository evidence, reconstructing relevant historical context, and organizing a focused review discussion. Its Review Board coordinates AI analysis and human input: it can surface current maintainers and relevant former subject-matter experts (SMEs), explain why their perspective may help, and wait for human feedback when important context is missing.

The system does not impersonate engineers, claim that simulated perspectives are actual reviews, or make approval and merge decisions. AI output is an evidence-backed brief for people to inspect and act on.

## 2. Problem

In a large or long-lived codebase, important design context can be hard to recover. The engineers who built a subsystem may have moved to another area, while current maintainers may not know why a constraint exists. Reviewers then reconstruct intent from source, commits, prior reviews, and ownership files. A plausible AI explanation is not enough: teams need to see what supports a claim, what remains uncertain, and who can resolve the uncertainty.

Existing ownership and reviewer recommendation mechanisms help identify people. RedZone's product question is broader: can an orchestrated review board assemble relevant evidence and perspectives, make disagreement and uncertainty visible, and request human judgment at the right time?

## 3. Product vision and principles

**Vision:** Preserve and retrieve useful engineering context as code, systems, and teams evolve, while keeping accountable humans in control of review decisions.

Principles:

1. **Ground claims in inspectable evidence.** Link findings to changed code, commits, review comments, ownership metadata, or other configured sources.
2. **Separate evidence from inference.** Label observed facts, model interpretations, and unanswered questions distinctly.
3. **Expose disagreement and uncertainty.** Do not force consensus or invent confidence when evidence is weak.
4. **Recommend people with reasons.** Use ownership, relevant substantive review history, recency, outcomes, and configured signals such as +2 reviews. A +2 is not proof of expertise by itself.
5. **Respect changing expertise.** Distinguish active maintainers from people with historical expertise in an area. Do not infer that someone is available merely because they contributed in the past.
6. **Keep people in control.** Humans decide whether to request input, accept findings, approve, or merge.
7. **Minimize data and permissions.** Request only the repository and provider access needed for the selected workflow; make data sources and retention configurable.
8. **Evaluate quality, not activity.** Measure evidence quality, recommendation usefulness, precision, false positives, and human correction—not agent count or volume of comments.

## 4. Users and jobs to be done

### Primary user: PR reviewer / current maintainer

- Understand what changed and why the change may be risky.
- Find relevant prior decisions and related changes without manually searching the whole repository.
- See which parts of the assessment are supported, uncertain, or contested.
- Ask a current maintainer or historical expert a targeted question when needed.

### Secondary user: author

- Receive a concise explanation of material risks and missing context.
- Respond to specific questions and provide evidence or intent.
- See how feedback affected the final review brief.

### Team administrator / repository owner

- Configure evidence sources, reviewer eligibility, escalation rules, and data handling.
- Correct stale ownership or expertise signals.
- Audit why a person or signal was included in a review.

## 5. Core workflow

1. **Start a review.** A user selects a PR or supplies a local diff and base revision.
2. **Build an evidence packet.** Collect changed files and symbols where available, relevant dependency relationships, prior commits, prior review discussions, ownership metadata, and configured project guidance. Record provenance for every item.
3. **Plan the review.** The orchestrator identifies the questions that need answering and selects analysis steps based on available evidence. It should skip unavailable sources explicitly rather than imply they were checked.
4. **Run focused analysis.** Separate responsibilities such as change scope, historical risk signals, dependency impact, and review context. Agents return concise structured findings with evidence references and uncertainty.
5. **Convene the board.** Summarize perspectives, agreements, disagreements, evidence gaps, and questions. A simulated perspective is a role-based analysis grounded in artifacts; it is never presented as a named person's actual opinion.
6. **Recommend human input when warranted.** Explain why a current maintainer or historical expert may help. A configured user can choose whether to send a request. RedZone does not contact people without an explicit action or configured policy.
7. **Wait for and incorporate feedback.** Record the human response as attributed evidence, preserve the prior AI assessment, and update the synthesis with a clear account of what changed.
8. **Present the result.** Show a concise review brief with risk assessment, supporting evidence, unresolved questions, and suggested next steps. Approval and merge remain in the source-control provider and under human authority.

## 6. Review Board output

Each review should contain:

- **Change summary:** affected behavior, files, symbols, and dependencies when known.
- **Risk assessment:** a qualitative level with a short rationale. Risk is an assessment, not a merge verdict.
- **Evidence:** source, identifier/link, date or revision, relevant excerpt or location, and the claim it supports.
- **Signals and limits:** what was searched, what was unavailable, and what the system did not establish.
- **Board perspectives:** focused findings grouped by concern, not fictional named-person dialogue.
- **Disagreements:** meaningful differences between analyses, each linked to evidence.
- **Human input request:** optional targeted question, proposed recipient(s), recommendation rationale, and response status.
- **Synthesis:** what the evidence supports, what remains uncertain, and practical review actions.

Do not expose private model chain-of-thought. Show concise conclusions, evidence, and reviewable decision summaries instead.

## 7. Expertise and reviewer recommendation model

The expertise map is supporting infrastructure for human routing, not an AI persona system.

Candidate recommendation signals may include:

- Explicit ownership from CODEOWNERS or configured provider teams.
- Relevant and substantive prior reviews in the affected area.
- Recency and repeated involvement over time.
- Review outcomes and subsequent corrections, where available and attributable.
- Explicit team configuration, availability, or user-provided role metadata.
- +2 / approval signals as one input, weighted alongside review substance and context.

For every recommendation, show the contributing evidence and its date. Separate **current owner/maintainer** from **historical expert**. Historical contribution alone does not mean the person is still an SME, active, available, or willing to be contacted. Allow authorized maintainers to mark expertise as active, historical, or obsolete and to correct routing data through an application workflow.

Initial prototype behavior should be advisory: recommend a person and explain why. Any external request must be a deliberate user action in the first release.

## 8. Scope

### MVP: local, evidence-grounded review board

- Analyze a selected PR or local candidate diff, including supported tracked uncommitted changes.
- Gather bounded Git history and GitHub review evidence using the existing prototype collectors.
- Add ownership metadata as an explicitly sourced signal.
- Produce structured, evidence-linked findings and a concise board synthesis.
- Show agent/task status, evidence provenance, missing sources, uncertainty, and disagreements in the UI.
- Recommend current maintainers or historical experts only when supported by available evidence; show reasons.
- Let the user add human feedback to the review and regenerate the synthesis.
- Keep all write actions disabled by default; no automatic reviewer requests, PR comments, approvals, or merges.
- Add a small evaluation corpus using public repositories and manually checked scenarios; report precision and false-positive examples.

### Later, after MVP evaluation

- GitHub App integration and permission-scoped installation.
- Optional reviewer request workflow with explicit user confirmation and configurable rules.
- Persistent repository-specific expertise records with correction, recency, and lifecycle handling.
- Additional evidence sources such as linked issues, CI, deployments, incidents, or observability—only with explicit connectors and provenance.
- Organization controls, audit logs, data retention controls, and self-hosted deployment options.
- Evaluation dashboards and configurable quality thresholds.

### Out of scope for MVP

- Simulating named engineers, imitating their style, or asserting what they would think.
- Autonomous approval, merge, code modification, or reviewer outreach.
- Treating a revert, +2, ownership entry, or past comment alone as proof of correctness, expertise, or incident causality.
- Claiming production incidents or runtime impact without corresponding evidence.
- Building a generalized multi-agent platform unrelated to code review.
- Enterprise claims before security, privacy, and reliability work is complete.

## 9. Trust, security, and privacy requirements

- Treat repository contents, PR comments, commit messages, and linked documents as untrusted input; they cannot override system policy.
- Scope provider credentials to the minimum repositories and operations needed.
- Never expose secrets found in diffs or history in prompts, UI, logs, or generated comments.
- Keep read-only analysis as the default. Gate write operations behind explicit user actions and provider permissions.
- Attribute every evidence item to its source and preserve enough metadata to audit its use.
- Make unavailable evidence sources visible; do not silently substitute guessed information.
- Provide configurable retention and deletion before broader hosted use.
- Keep private reasoning hidden while making findings and their factual support inspectable.

## 10. Evaluation and success measures

The prototype succeeds if reviewers can answer: “Why did the system say this, what evidence supports it, and what should I verify next?”

Track:

- **Evidence support rate:** proportion of claims whose citations directly support them, measured by human audit.
- **Finding precision:** proportion of material findings accepted as valid by reviewers.
- **False-positive rate:** proportion of findings rejected as unsupported or irrelevant.
- **Evidence coverage:** proportion of key claims with a valid source reference.
- **Recommendation usefulness:** whether reviewers judge the suggested person relevant and whether the rationale is accurate.
- **Human correction rate:** frequency and type of corrections to evidence, role status, and synthesis.
- **Review latency and reviewer effort:** exploratory measures, not optimization targets until quality is established.
- **Calibration:** whether uncertainty and abstention increase when evidence is missing or conflicting.

Establish a small manually reviewed baseline before tuning agent prompts or adding more agents. Track failure examples, not just aggregate scores.

## 11. Open-core direction

The project should be useful as an open-source local tool first. Keep the evidence model, agent contracts, orchestration flow, evaluation fixtures, CLI, and basic UI inspectable and extensible.

Potential future hosted/commercial capabilities may include multi-repository administration, managed provider integrations, policy and access controls, audit and retention management, team-level expertise lifecycle workflows, and enterprise deployment/support. This is a hypothesis, not a finalized business model. Avoid artificial limits in the open-source version; define the boundary only after user feedback and security requirements are clearer.

## 12. Initial Linear project breakdown

### Epic A — Review session and evidence model

- Define review session, evidence item, finding, perspective, uncertainty, and human feedback schemas.
- Add provenance and stable evidence identifiers across Git and GitHub collectors.
- Surface source coverage and collector limitations in the report.

### Epic B — Orchestrator and review plan

- Convert the current analysis entry point into an explicit plan/run/synthesize lifecycle.
- Keep specialist responsibilities bounded and return structured results.
- Record which steps ran, were skipped, failed, or need human input.

### Epic C — Review Board synthesis

- Synthesize evidence-backed perspectives, agreements, conflicts, and questions.
- Enforce concise outputs and validate citations against collected evidence.
- Abstain on claims that lack adequate support.

### Epic D — Expertise recommendations

- Ingest CODEOWNERS or equivalent ownership sources.
- Identify relevant reviewers from bounded substantive review history.
- Include recency and +2/approval as labeled signals, not ground truth.
- Separate current maintainers from historical experts and explain each recommendation.

### Epic E — Human feedback loop

- Add a UI state for questions awaiting a person, without sending messages automatically.
- Let the user record feedback and its attribution/source.
- Re-synthesize while preserving the original analysis and showing what changed.

### Epic F — Review Board UI

- Present the review plan, progress, findings, evidence, uncertainty, and human requests.
- Make claims navigable to changed code or historical source.
- Distinguish AI analysis from actual human feedback.

### Epic G — Evaluation and trust controls

- Create a small evaluation set outside repository root, based on public-repo examples and hand-labeled expected evidence.
- Score citation validity, finding precision, false positives, recommendation usefulness, and abstention.
- Add adversarial fixtures for prompt injection in repository text and review comments.

### Epic H — Open-source contributor experience

- Document local setup, supported evidence sources, limitations, and safe credential setup.
- Clarify license and contribution process before public launch.
- Keep secrets and generated local data out of version control.

## 13. Decisions to validate before implementation expands

1. Is “Review Board” the feature name and “RedZone” the project name?
2. Should the first user experience analyze local diffs, GitHub PRs, or both?
3. Which role types are useful in the first board: change scope, historical risk, dependency impact, review context, security, or another set?
4. What counts as a substantive review for reviewer recommendations, and how should the project label +2 or approval?
5. When is a historical expert eligible for an optional human request, and how will availability/consent be represented?
6. Which public repository and labeled PR scenarios will be the initial evaluation baseline?
7. Which license and future open-core boundary fit the project's goals?

## 14. Initial product statement

> RedZone Review Board helps teams review risky code changes by connecting the diff to repository history, impact signals, and relevant engineering expertise. It presents evidence, uncertainty, and unresolved questions, then brings a human into the loop when the system cannot justify a confident conclusion. People remain responsible for review and merge decisions.
