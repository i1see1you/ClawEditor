ClawEditor is a lightweight, cross-platform, AI-assisted text editor built with OpenClaw and Tauri. Every edit goes through a diff preview; the user must confirm before changes are applied. Each edit command is a skill; custom skills are supported.

**Languages:** English (this page) · [中文](README.zh-CN.md)

[![npm @claweditor/cli](https://img.shields.io/npm/v/@claweditor/cli?label=%40claweditor%2Fcli)](https://www.npmjs.com/package/@claweditor/cli)
[![Release](https://github.com/i1see1you/ClawEditor/actions/workflows/release.yml/badge.svg)](https://github.com/i1see1you/ClawEditor/actions/workflows/release.yml)

**Quick install:** `npm install -g @claweditor/cli && claw-editor`

# Features

- **AI-powered editing** — `/aiedit`, `/aicorrect`, `/aiimport` with diff preview & confirm
- **Remote editing via IM** — Feishu / WeChat / any OpenClaw Channel
- **Edge DLP** — sensitive data masked before cloud upload (Virbius Core)
- **Multi-language syntax highlighting** — JavaScript, Python, CSS, HTML, XML, JSON, Markdown
- **PDF viewer** — open & preview PDF files in-app
- **Markdown / HTML preview panel**
- **Quick file navigation** — Goto Anything (Cmd+P), Goto Line (Cmd+G)
- **Custom skill system** — write your own commands via `SKILL.md` files
- **Cross-platform** — macOS (ARM + Intel), Linux, Windows

# Preview (desktop & Channel)

<img width="2934" height="1860" alt="Desktop preview" src="https://github.com/user-attachments/assets/7b315424-c924-4b1f-9711-85a85ae61867" />

<img width="1088" height="2400" alt="Channel preview" src="https://github.com/user-attachments/assets/ee9619d9-511b-4c41-9ed6-34a388893cd2" />

# Tech stack

- **Desktop**: Tauri 2.x (Rust backend)
- **Frontend**: React 18 + TypeScript + Vite
- **Editor**: CodeMirror 6
- **State**: Zustand 5
- **Transport**: WebSocket to OpenClaw Gateway
- **PDF**: pdfjs-dist + jsPDF (view & export)
- **Edge DLP**: Virbius Core (scan + desensitize before cloud upload for `/aiedit`, etc.)

# Architecture

```
ClawEditor (Tauri + React + CodeMirror 6)
  ├─ Top: CodeMirror editor
  └─ Bottom: Agent chat panel (commands + messages)
            ↓ WebSocket
OpenClaw Gateway (claweditor-gateway plugin)
            ↕
OpenClaw Channel (IM / Feishu / WeChat, …)
```

The Agent panel is a chat UI (not xterm.js): user/assistant/system roles, ANSI colors, streaming, diff preview and confirm.

# Install (end users)

## Desktop app — [`@claweditor/cli`](https://www.npmjs.com/package/@claweditor/cli) (npm)

Install the launcher globally, then run ClawEditor. On first launch the CLI downloads the matching platform bundle from [GitHub Releases](https://github.com/i1see1you/ClawEditor/releases).

**Requirements:** Node.js ≥ 18 · a published GitHub Release for your OS/arch

```bash
npm install -g @claweditor/cli
claw-editor
```

Other commands:

```bash
claw-editor install          # install only (no launch)
claw-editor update           # re-download latest release
claw-editor install --tag 0.1.0
claw-editor version
```

| Platform | CLI auto-install | Notes |
|----------|------------------|-------|
| macOS (Apple Silicon / Intel) | `.app.tar.gz` | Fully automated |
| Linux x64 | `.AppImage` | Fully automated |
| Windows x64 | `*-setup.exe` | Runs the installer UI once, then `claw-editor` |

Prefer a manual installer? Download directly from [GitHub Releases](https://github.com/i1see1you/ClawEditor/releases).

## npm packages

| Package | Status | Purpose |
|---------|--------|---------|
| [`@claweditor/cli`](https://www.npmjs.com/package/@claweditor/cli) | **Published** (v0.1.0) | Install & launch desktop app |
| `@claweditor/openclaw-gateway-bridge` | Not on npm yet | OpenClaw Gateway plugin — use repo path below |

# Build from source (developers)

## Requirements

- **Node.js** ≥ 18
- **Rust** ≥ 1.70 ([rustup](https://rustup.rs/))
- **VirbiusLLM** as a sibling repo: `../VirbiusLLM/virbius-core` (required for Tauri build / edge DLP)
- **Tauri 2 system deps**: [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
  - macOS: Xcode Command Line Tools
  - Windows: MSVC Build Tools, WebView2
  - Linux: `libwebkit2gtk-4.1`, `libappindicator3`, `librsvg2`, etc.

## Setup

```bash
git clone https://github.com/i1see1you/ClawEditor.git
cd ClawEditor
npm install
```

## Development

```bash
npm run tauri dev
```

Starts Vite on `localhost:1420` and the Tauri window with hot reload.

## Release build

```bash
npm run tauri build
```

Artifacts: `src-tauri/target/release/bundle/`.

# OpenClaw Gateway plugin

Install the plugin, connect ClawEditor to your Gateway, and enable **「开启远程编辑」 / Remote edit receive** in the Agent panel.

```bash
# From this repo (current)
openclaw plugins install integrations/openclaw-gateway

# From npm (when @claweditor/openclaw-gateway-bridge is published)
# openclaw plugins install @claweditor/openclaw-gateway-bridge
```

Restart Gateway after install. Only one ClawEditor instance may hold the remote-edit lease per Gateway.

# Skills & commands

Custom skills are defined as `SKILL.md` files in [`skills/`](skills/). See the [skill schema reference](skills/CLAWEDITOR_SKILL_SCHEMA.md) to write your own.

## Local (no Gateway)

- **/edit** — local edits; falls back to Gateway for complex natural language
- **/find** — local find; Gateway fallback for complex queries

## Gateway skills

- **/aiedit** — AI-assisted edits (scope text sent to Gateway; masked by Virbius first)
- **/aiimport** — import from clipboard / files into the buffer
- **/aicorrect** — spelling & punctuation (interactive side-by-side diff)

## Remote (Channel)

Same business commands as above; diff is delivered to the Channel. Confirm/cancel:

- **/confirm req_xxx**
- **/cancel req_xxx**

### Target file

For an **already open** tab, use `--file` with the file basename:

```text
--file bbb.js
--file=bbb.js
--file:bbb.js
```

# Remote edit (`claw_editor.v1.*`)

1. Channel user sends a command (e.g. `/edit remove blank lines --file=foo.js`)
2. Plugin emits `claw_editor.v1.request` (`req_*` + `context`) to the ClawEditor lease holder
3. Editor builds a proposal; local diff UI or `claw_editor.v1.diff_response` to IM
4. `/confirm req_xxx` or `/cancel req_xxx` → `claw_editor.v1.commit` → `commit_response`

Each command is correlated by `request_id`.

# Custom DLP rules

`/aiedit`, `/aicorrect`, and `/aiimport` mask sensitive data before upload using [`data/virbius/edge/default/ClawEditor/edge-manifest.json`](data/virbius/edge/default/ClawEditor/edge-manifest.json). Edit this file, then **restart ClawEditor**.

**Block keywords** — add to `rules[]`:

```json
{
  "rule_id": "my_deny",
  "rule_revision": 1,
  "reason_code": "EDGE_CUSTOM",
  "risk_score": 90,
  "intent_action": "deny",
  "enforce_mode": "full",
  "rollout_state": "full",
  "body": { "list_type": "deny", "keywords": ["internal-only"] }
}
```

**Mask PII** — add to `dlp_rules[]`. Built-in types: `phone_cn`, `idcard_cn`, `email`, `bank_card_cn`. Custom pattern:

```json
{
  "rule_id": "my_dlp_emp",
  "rule_revision": 1,
  "reason_code": "DLP_EMP",
  "risk_score": 0,
  "intent_action": "allow",
  "enforce_mode": "full",
  "rollout_state": "full",
  "body": {
    "entity_type": "custom_regex",
    "pattern": "EMP[0-9]{6}",
    "mask_template": "{{VIRBIUS_EMP_{seq}}}"
  }
}
```

Copy an existing rule in the manifest and change `rule_id` / `body`. See the bundled file for full examples.

# Design constraints

- Remote edits require diff → confirm → save
- ClawEditor desktop is the single source of truth for on-disk content
- Agent input is not a system shell
- Operations stay within the workspace; `requestId` aids troubleshooting

# License

[MIT License](LICENSE)
