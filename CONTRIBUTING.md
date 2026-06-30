# Contributing to ClawEditor

Thanks for your interest in contributing!

## How to contribute

- **Report bugs** — open a [GitHub Issue](https://github.com/i1see1you/ClawEditor/issues) with reproduction steps.
- **Feature requests** — open an issue describing the use case.
- **Pull requests** — welcome! Please keep changes focused and rebase on latest `main`.

## Development setup

See [Build from source](README.md#build-from-source-developers) in the README.

## Code style

- TypeScript: no semicolons, single quotes, 2-space indent. Run `tsc` before committing.
- Rust: `cargo fmt` and `cargo clippy`.
- Skill files: see `skills/CLAWEDITOR_SKILL_SCHEMA.md` for the `claweditor` config block schema.
- No commented-out code. Keep diffs minimal.

## Before submitting a PR

1. Make sure `npm run build` (or `npm run tauri build`) succeeds.
2. Update README if your change adds or modifies a user-facing feature.
3. Keep the commit history clean — squash if needed.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
