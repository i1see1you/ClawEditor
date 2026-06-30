# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in ClawEditor, please report it privately by opening a [GitHub Security Advisory](https://github.com/i1see1you/ClawEditor/security/advisories/new).

Please do **not** report security vulnerabilities via public GitHub issues.

## What to include

- A description of the vulnerability
- Steps to reproduce
- Affected versions
- Any potential impact

You should receive a response within 7 days. If the issue is confirmed, we will work on a fix and coordinate a release.

## Scope

- The Tauri desktop application (Rust backend + React frontend)
- The `@claweditor/cli` npm package
- The Gateway plugin (`integrations/openclaw-gateway`)
- The edge DLP manifest and Virbius integration

## Out of scope

- The OpenClaw Gateway itself (report to its maintainers)
- Virbius Core (report to the VirbiusLLM project)
