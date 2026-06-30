# smart-watering-system - Codex
Globals: `/Users/jasonnickel/.codex/AGENTS.md`, agents, skills.
Project: Node Rachio watering controller. Irrigation activation, shadow/live mode, setup/go-live, and device/service creds are high-risk.
Workflow: classify before edit. Scout for read-only mapping/tests; routine executor for <=2-file edits; risk reviewer for live watering, scheduler/device control, credentials, safety; git-workflow for local git mechanics.
Main keeps live-device behavior, creds, go-live, release-risk decisions.
Verified:
```bash
npm test
npm run lint
npm run check
```
Approval required: `npm run doctor`, `npm run shadow`, `npm run enable-shadow`, live watering, setup/go-live, credential/destructive operations. Do not invent verification.
