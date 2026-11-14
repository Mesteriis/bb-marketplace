# Security Policy

These plugins handle personal mail and the credentials that reach it, and they
run inside BB with full trust. Please report security issues privately.

## Supported Versions

The project is pre-release. Security fixes land on the default branch and in
the next release tag of the affected plugin.

## Reporting a Vulnerability

Do not open a public issue for a security-sensitive report.

Use GitHub's private vulnerability reporting on this repository (the
**Report a vulnerability** button under the Security tab). Include:

- the affected plugin and its version or commit;
- the impact, and which data or capability is affected;
- reproduction steps;
- whether credentials, message contents, or attachments may have been exposed.

## Security Expectations

- Never commit secrets, provider tokens, app passwords, private keys, or local
  `.env` files.
- Never publish real addresses, message bodies, or attachments in issues,
  fixtures, or screenshots.
- Keep credentials in BB's secret storage on the server. They must not reach
  the front end, logs, CLI output, or agent-visible text.
- Treat every message as untrusted input: for rendering (HTML, remote content,
  links) and for agents. Text inside a message is data and never an
  instruction to an agent.
- Keep sending, deleting, and other writes behind an explicit user action or
  an explicit, scoped permission for an agent.
