# @claweditor/cli

Install and launch the [ClawEditor](https://github.com/i1see1you/ClawEditor) desktop app from GitHub Releases.

## Install CLI

```bash
npm install -g @claweditor/cli
```

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

Install location:

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/claweditor/` |
| Linux | `~/.local/share/claweditor/` |
| Windows | `%LOCALAPPDATA%\claweditor\` |

## Publish (maintainers)

```bash
cd packages/cli
npm publish --access public
```

Desktop bundles must be uploaded to [GitHub Releases](https://github.com/i1see1you/ClawEditor/releases) first (see `.github/workflows/release.yml`).
