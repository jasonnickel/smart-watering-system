# smart-watering-system - Claude
Read global `/Users/jasonnickel/.claude/CLAUDE.md`; use global skills/agents. Local-only notes below.
Project: Node.js Rachio watering controller. Hardware/live-system behavior needs explicit care and narrow verification.
Classify before edit. Opus: architecture, live-control/hardware, security, public CLI, >3 files, unclear bugs, final review. Sonnet: routine/test/docs/lint/narrow edits. Haiku: recon.
Delegation: scout for read-only mapping/tests; routine executor for <=2-file routine edits; risk reviewer for architecture/live-control/security/public contracts. Main keeps final decisions and live-control/security contracts.
Verify/report: run relevant `npm test`, `npm run lint`, `npm run check`; report files, exact command/result, unresolved risk. Stop after 3 failed attempts and reframe.
