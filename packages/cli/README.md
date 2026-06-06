# @claweditor/cli

[![npm version](https://img.shields.io/npm/v/@claweditor/cli.svg)](https://www.npmjs.com/package/@claweditor/cli)

Install and launch the [ClawEditor](https://github.com/i1see1you/ClawEditor) desktop app from [GitHub Releases](https://github.com/i1see1you/ClawEditor/releases).

## Install

```bash
npm install -g @claweditor/cli
```

Requires **Node.js ≥ 18**. The desktop binary is downloaded on first run (not bundled in this npm package).

## Usage

```bash
# Download (if needed) and launch
claw-editor

# Install only
claw-editor install

# Re-download latest release
claw-editor update

# Install a specific version
claw-editor install --tag 0.1.0

# Show versions
claw-editor version
```

## Install location

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/claweditor/` |
| Linux | `~/.local/share/claweditor/` |
| Windows | `%LOCALAPPDATA%\claweditor\` |

## Publish (maintainers)

Requires npm org **`@claweditor`**, 2FA, and `--access public`:

```bash
cd packages/cli
npm publish --access public --otp=XXXXXX
```

Upload desktop bundles to [GitHub Releases](https://github.com/i1see1you/ClawEditor/releases) first (see `.github/workflows/release.yml` in the main repo).
