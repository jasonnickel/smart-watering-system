# Claude Code Project Rules

Read `/Users/jasonnickel/.claude/CLAUDE.md` first. Use global skills from `/Users/jasonnickel/.claude/skills/` and global agents from `/Users/jasonnickel/.claude/agents/`. This file only adds project-specific guidance.

## Project Context

Node.js controller for Rachio watering automation. Hardware or live-system actions need explicit care and narrow verification.

## Model Use

- `claude-opus-4-7`: architecture, hardware/live-control behavior, security-sensitive logic, public CLI contracts, changes touching more than 3 files, unclear bugs, and final review of `claude-haiku` or `claude-sonnet-4-6` output.
- `claude-sonnet-4-6`: routine implementation, focused test fixes, docs, lint fixes, and narrow clear edits.
- `claude-haiku`: low-risk summaries, file maps, classifications, and read-only reconnaissance if available.

## Subagent Use

- `claude-haiku-scout`: read-only file discovery, reference mapping, logs/diffs, test discovery, likely change points.
- `claude-sonnet-routine-executor`: docs cleanup, test scaffolding, lint/type fixes, and narrow routine edits touching no more than 2 files.
- `claude-opus-risk-reviewer`: architecture, complex debugging, live-control, security, and public-contract review.

Main session keeps final decisions, architecture, hardware/live-control behavior, security-sensitive work, public contracts, and cross-module reasoning.

## Before Editing

Classify the task as ROUTINE, COMPLEX, ARCHITECTURAL, or SECURITY-SENSITIVE. ROUTINE means smallest correct change. COMPLEX or higher means a short plan first.

## Verification

Report exact files changed, verification command/result, and unresolved risk. Stop after 3 failed verification attempts and reframe root cause.

Known verification commands:
- `npm test`
- `npm run lint`
- `npm run check`
