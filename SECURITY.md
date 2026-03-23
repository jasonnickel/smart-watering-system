# Security Policy

## Reporting a Vulnerability

Please do not open a public GitHub issue for security-sensitive problems.

Instead:

- Email `jason@jasonnickel.com` with the subject line `taproot security report`, or
- Open a private GitHub security advisory if that option is enabled for the repository.

Useful details include:

- What component is affected
- What the impact is
- Clear reproduction steps or proof of concept
- Any suggested mitigation or workaround

I will try to acknowledge reports promptly and coordinate a fix before public disclosure when appropriate.

## Scope

This project is a self-hosted irrigation controller. Security issues worth reporting include:

- Credential handling or leakage
- Unsafe webhook or notification behavior
- Command execution or injection risks
- MQTT exposure or unsafe default topics
- Database corruption or integrity risks caused by malformed input
