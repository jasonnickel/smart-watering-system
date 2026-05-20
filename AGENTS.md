# Codex Project Rules

This project uses the global Codex operating layer:

- `/Users/jasonnickel/.codex/AGENTS.md`
- `/Users/jasonnickel/.codex/agents/`
- `/Users/jasonnickel/.codex/skills/`

## Project Notes

Node-based watering controller. Treat irrigation activation, shadow/live mode, setup/go-live behavior, and device/service credentials as high-risk.

## Codex Workflow

Before editing, classify the task as `ROUTINE`, `COMPLEX`, `ARCHITECTURAL`, or `SECURITY-SENSITIVE`.

Use `codex-scout` for read-only mapping and test discovery. Use `codex-routine-executor` for bounded 1-2 file routine edits. Use `codex-risk-reviewer` for live watering behavior, setup/go-live, scheduler/device control, credentials, or safety risk. Use `codex-git-workflow` for git status, diff summaries, commit grouping, and PR text.

Keep final decisions, live-device behavior, credentials, go-live calls, and release-risk decisions in the main high-reasoning Codex session.

Git/GitHub safety:
- Use `codex-git-workflow` for git status, git diff review, branch hygiene, commit grouping, commit message drafting, PR summary drafting, and merge-readiness checks.
- Never merge, push, force-push, delete branches, or rebase shared branches without explicit user approval.
- Escalate to high-reasoning Codex before merge/release when schema, migrations, security, auth, data integrity, public contracts, architecture, forensic/evidence files, broad refactors, failing tests, or unclear release readiness are involved.

## Verified Commands

Verified from `package.json`:

```bash
npm test
npm run lint
npm run check
```

Operational/manual commands requiring explicit user approval; do not run by default as verification:

```bash
npm run doctor
npm run shadow
npm run enable-shadow
```

Do not invent verification commands. Do not run live watering, setup, go-live, credential, or destructive operations without explicit user approval.
