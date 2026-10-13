# Red Zone Agent

Red Zone looks for historical risk signals related to the code being changed. It compares a candidate diff with prior commits and GitHub review evidence, then produces a concise assessment with links to the supporting evidence.

## Architecture

```mermaid
flowchart TD
    UI[Next.js dashboard] --> API[POST /api/analyze]
    CLI[Command line] --> Snapshot
    API --> Snapshot[Repository snapshot]
    Snapshot --> Git[Git diff and path-overlapping commit history]
    Snapshot --> Reviews[GitHub PR reviews via gh CLI]
    Git --> Scope[Change Scope Agent]
    Scope --> RollbackGate{Explicit rollback signal?}
    RollbackGate -->|Yes| Rollback[Rollback History Agent]
    RollbackGate -->|No| Skip[Record skipped with reason]
    Scope --> Review[Review Context Agent]
    Reviews --> Review
    Scope --> Planner[Red Zone Planner]
    Rollback --> Planner
    Skip --> Planner
    Review --> Planner
    Git --> Planner
    Reviews --> Planner
    Planner --> Schema[Zod-validated assessment]
    Schema --> Report[Concise evidence report]
    Report --> UI
    Report --> CLI
```

### Request and evidence flow

1. The dashboard API or CLI calls `collectRepositorySnapshot` in `src/history.ts`.
2. The snapshot compares the selected base with the merge base and `HEAD`, and includes staged and unstaged changes to tracked files. Untracked files are currently excluded.
3. The collector gathers up to 40 earlier commits that touched the changed paths. It supplies commit hashes, dates, subjects, and paths, not commit bodies.
4. `collectReviewEvidence` in `src/github.ts` uses GitHub App installation access in the web app, or the local `origin` remote and GitHub CLI in command-line analysis, to find prior PR reviews and comments for overlapping changed paths.
5. `analyzeSnapshot` runs the specialist agents and passes their findings, the candidate diff, and the original evidence to the planner.
6. The planner returns a structured assessment. The application filters cited commit hashes and review IDs against the evidence it actually received, then `src/report.ts` renders a concise report.

### Agents

- **Change Scope Agent** reads the candidate diff and describes the affected behavior, files, and functions. It does not decide risk.
- **Rollback History Agent** runs only when a changed-path commit subject explicitly begins with a supported signal such as `Revert`, `rollback`, `roll back`, `feature flag`, or `kill switch`. If no signal is present, the report records that it was skipped. The current collector does not inspect source history for feature-flag code changes.
- **Review Context Agent** checks supplied GitHub comments and review decisions, treating them as review evidence rather than proof of a production incident.
- **Red Zone Planner** synthesizes the specialist findings with the original evidence and produces the final risk level, rationale, citations, and follow-up questions.

The dashboard shows each specialist’s status and a short finding. It does not display private model chain-of-thought.

## Stack

- Next.js dashboard and API routes
- Mastra agents for the planner and specialists
- OpenAI models through the Mastra OpenAI model integration; defaults to `gpt-4o-mini`
- Zod structured output for the final assessment
- Git for candidate diffs and history; GitHub App API for web review evidence; GitHub CLI for local CLI analysis

## Run locally

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`. For sign-in, configure a GitHub OAuth App with callback URL `http://localhost:3000/api/auth/callback/github`, then set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. To connect repositories, separately create a GitHub App with callback URL `http://localhost:3000/api/github/install/authorize/callback` and setup URL `http://localhost:3000/api/github/install/callback`. Leave “Request user authorization (OAuth) during installation” unchecked and enable “Redirect on update.” Grant read-only `Pull requests` and `Issues` permissions; repository metadata read access is automatic. Set `GITHUB_APP_SLUG`, `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, and `GITHUB_APP_PRIVATE_KEY`, plus `NEXTAUTH_SECRET` and `NEXTAUTH_URL`. The app opens on `/login` by default. Set `REDZONE_DEV_MODE=true` only when you intentionally want to use the unauthenticated local dashboard.
3. Run RedZone from the local repository checkout you want it to analyze. Sign in with GitHub and choose **Connect GitHub App** in the sidebar. Install it on the account and repository you want RedZone to access. Open **Repositories** in the sidebar; RedZone selects the installed repository matching the current checkout's `origin`. The selection is stored in a signed, user-bound browser cookie. Web analysis uses a short-lived GitHub App installation token scoped to the selected repository. Local CLI analysis uses the current repository's `origin` remote and `gh` authentication. Posting a PR summary still uses `GITHUB_TOKEN` or `GH_TOKEN`.
4. Start the dashboard with `npm run dev` and open `http://localhost:3000`.
5. Choose a base branch such as `main` and run an analysis. Tracked local edits are included alongside committed branch changes.

The **Expert map** page scans up to `REDZONE_EXPERT_MAP_PR_LIMIT` recently updated pull requests (default 30, maximum 100) on demand. It maps review activity and formal decisions to changed paths, applies the local checkout's CODEOWNERS rules, and links to the source reviews. Results are not persisted. Review activity is historical evidence; the map does not claim a person's current role or availability.

To run from the terminal, use `npm run analyze -- main`. Add `--json` to print the structured analysis and its evidence.

## Current limits

- The rollback gate uses commit subjects and paths. It does not inspect commit bodies, code-level feature-flag changes, incident records, telemetry, or deployment history.
- Commit history is limited to 40 commits that touch the candidate paths; GitHub search is limited by `REDZONE_PR_LIMIT` and may not include older relevant PRs.
- Untracked files are excluded from model input.
- File overlap is a candidate signal, not proof that two changes affect the same function or behavior.
- Historical review concerns and a revert are not, by themselves, proof of a production incident or its cause.
- The analyzer reports evidence and risk; it does not modify source code or make merge decisions.
