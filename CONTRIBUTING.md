# Contributing

Thanks for taking a look at the project.

## Before You Start

- Use GitHub Discussions for questions, setup help, and design ideas.
- Use GitHub Issues for concrete bugs, regressions, or well-scoped feature requests.
- For security-sensitive problems, follow the process in `SECURITY.md` instead of opening a public issue.

## Good Contributions

- Fixes that improve watering safety, observability, or operational reliability.
- Docs changes that make setup, limits, or behavior more accurate.
- Tests that cover real failure modes, especially timestamps, concurrency, integrations, and deployment behavior.
- Small, focused improvements that are easy to review and reason about.

## Development Setup

```bash
npm install
npm test
node src/cli.js run --shadow
node src/cli.js status
```

If you are changing decision logic, weather handling, MQTT behavior, or deployment files, please update the README or related docs in the same pull request when needed.

## Pull Request Expectations

- Keep changes scoped. Separate unrelated fixes into different pull requests when possible.
- Add or update tests when behavior changes.
- Be conservative with README claims. If something is scaffolded, experimental, or only partially wired, say so plainly.
- Include a short note about how you validated the change.

## Areas That Benefit Most From Help

- Integration tests against realistic SQLite, MQTT, and timer flows
- Documentation and setup validation
- Home Assistant polish
- Flow-meter and tuning features that are currently groundwork rather than fully wired
