ClawEditor 是一款基于 OpenClaw 与 Tauri 构建的 AI 驱动型轻量级跨平台文本编辑器。所有的编辑操作都需要用户先确认 diff，然后再应用修改。一个编辑命令就是一个 skill，支持用户自定义 skill。

**Languages:** [English](README.md) · 中文（当前）

# 本地和 Channel 端效果预览

<img width="2934" height="1860" alt="image" src="https://github.com/user-attachments/assets/7b315424-c924-4b1f-9711-85a85ae61867" />

<img width="1088" height="2400" alt="image" src="https://github.com/user-attachments/assets/ee9619d9-511b-4c41-9ed6-34a388893cd2" />

# 技术栈

- **桌面框架**：Tauri 2.x（Rust 后端）
- **前端**：React 18 + TypeScript + Vite
- **编辑器**：CodeMirror 6
- **状态管理**：Zustand 5
- **通信**：WebSocket 长连接至 OpenClaw Gateway
- **端侧 DLP**：Virbius Core（`/aiedit` 等上云前 scan + 脱敏）

# 架构

```
ClawEditor 桌面端（Tauri + React + CodeMirror 6）
  ├─ 上半部分：CodeMirror 编辑器（内容展示与编辑）
  └─ 下半部分：Agent 聊天面板（命令输入 + 消息输出）
            ↓
            ↓  WebSocket
            ↓
OpenClaw Gateway（claweditor-gateway 插件）
            ↕
OpenClaw Channel（IM / 飞书 / 微信等）
```

Agent 面板采用聊天式 UI（非 xterm.js 终端），支持角色区分（user/assistant/system）、ANSI 颜色渲染、流式输出、diff 预览与确认。

# 安装（普通用户）

推荐使用安装器 CLI，首次运行会自动从 GitHub Releases 下载对应平台的安装包：

```bash
npm install -g @claweditor/cli
claw-editor
```

其他命令：

```bash
claw-editor install          # 仅安装
claw-editor update           # 重新下载最新版
claw-editor install --tag 0.1.0
claw-editor version
```

也可手动下载：[GitHub Releases](https://github.com/i1see1you/ClawEditor/releases)

# 从源码构建（开发者）

## 环境要求

- **Node.js** ≥ 18
- **Rust** ≥ 1.70（通过 [rustup](https://rustup.rs/) 安装）
- **VirbiusLLM**（与 ClawEditor 同级目录）：`../VirbiusLLM/virbius-core`（Tauri 构建依赖，用于端侧 DLP）
- **Tauri 2 系统依赖**：参考 [Tauri 官方指南](https://v2.tauri.app/start/prerequisites/)
  - macOS：Xcode Command Line Tools
  - Windows：Microsoft Visual Studio C++ Build Tools、WebView2
  - Linux：`libwebkit2gtk-4.1`、`libappindicator3`、`librsvg2` 等

## 安装

```bash
git clone https://github.com/i1see1you/ClawEditor.git
cd ClawEditor
npm install
```

## 开发模式

```bash
npm run tauri dev
```

启动后会同时运行 Vite 开发服务器（`localhost:1420`）和 Tauri 桌面窗口，支持热重载。

## 构建发行版

```bash
npm run tauri build
```

产物位于 `src-tauri/target/release/bundle/`，包含对应平台的安装包。

# 安装 OpenClaw 插件

安装插件后，在 ClawEditor Agent 面板勾选 **「开启远程编辑」** 并连接 Gateway，即可接收 Channel 远程命令。

```bash
# 从本仓库路径安装（开发）
openclaw plugins install integrations/openclaw-gateway

# 或从 npm 安装（发布后）
# openclaw plugins install @claweditor/openclaw-gateway-bridge
```

安装后需将插件同步到 OpenClaw 扩展目录（若 CLI 未自动完成），并重启 Gateway。

# 已实现的 Skill

## 本地命令（不经过 Gateway）

- **/edit**：本地编辑；复杂自然语言可回退 Gateway 解析意图 JSON
- **/find**：本地查找；复杂描述可回退 Gateway

## Gateway Skill（经由 OpenClaw 大模型）

- **/aiedit**：复杂 AI 编辑（会将作用域文本发给 Gateway；经 Virbius 脱敏后上云）
- **/aiimport**：从剪贴板/文件等导入内容到缓冲区
- **/aicorrect**：拼写与标点纠错（side-by-side diff）

## 远程命令（Channel）

- **/edit**、**/aiedit**、**/aicorrect**、**/aiimport**：与本地同类，diff 发回 Channel
- **/confirm req_xxx**：确认并应用提案
- **/cancel req_xxx**：忽略提案

### 指定目标文件

已打开的文件可用 `--file` 指定（basename），支持：

```text
--file bbb.js
--file=bbb.js
--file:bbb.js
```

# 远程编辑（Channel，`claw_editor.v1.*`）

1. Channel 用户发送业务命令（如 `/edit 去除空行 --file=foo.js`）
2. 插件转为 `claw_editor.v1.request`（含 `req_*` 与 `context`），转发给持有远程编辑租约的 ClawEditor
3. 编辑器生成提案；本地弹 diff 或经 `emitV1Event` 回传 `claw_editor.v1.diff_response` 至 IM
4. 用户 `/confirm req_xxx` 或 `/cancel req_xxx` → `claw_editor.v1.commit` → `commit_response`

同一 Gateway 仅一台 ClawEditor 可持有远程编辑租约。每条命令以 `request_id` 关联请求、diff 与确认。

# Virbius 端侧 DLP（数据安全）

`/aiedit`、`/aicorrect`、`/aiimport` 等向 Gateway 发送正文前，经 **Virbius Core** 做关键词 scan 与 PII 脱敏；模型返回 JSON 后在本地 **回填** 明文。

- **规则配置**（可编辑）：[`data/virbius/edge/default/ClawEditor/edge-manifest.json`](data/virbius/edge/default/ClawEditor/edge-manifest.json)
- **默认 App ID**：`ClawEditor`
- **内置 DLP 实体**：手机号、身份证、邮箱、银行卡（`phone_cn` / `idcard_cn` / `email` / `bank_card_cn`）
- 修改 manifest 后需 **重启 ClawEditor** 生效

# 架构决策与约束

## 1. Channel 传输协议

ClawEditor 与 Gateway 使用 WebSocket（`req` / `res` / `event` 帧）。

## 2. 远程修改与保存

远程可发起修改意图；须先 diff 预览 → 用户确认 → 再落盘。

## 3. 协作模型

以 ClawEditor 桌面端为编辑与落盘锚点；不做多用户冲突合并。

## 4. 命令行 UI

非系统 shell；区分 OpenClaw 命令与本地轻量文本操作。

## 5. 安全与范围

文件操作限制在工作区内；关键操作带 `requestId` 便于排障。

# 许可证

[MIT License](LICENSE)
