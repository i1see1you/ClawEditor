ClawEditor 是一款基于 OpenClaw 与 Tauri 构建的 AI 驱动型轻量级跨平台文本编辑器。所有的编辑操作都需要用户先确认 diff，然后再应用修改。一个编辑命令就是一个 skill，支持用户自定义 skill。

# 技术栈

- **桌面框架**：Tauri 2.x（Rust 后端）
- **前端**：React 18 + TypeScript + Vite
- **编辑器**：CodeMirror 6
- **状态管理**：Zustand 5
- **通信**：WebSocket 长连接至 OpenClaw Gateway

# 架构

```
ClawEditor 桌面端（Tauri + React + CodeMirror 6）
  ├─ 上半部分：CodeMirror 编辑器（内容展示与编辑）
  └─ 下半部分：Agent 聊天面板（命令输入 + 消息输出）
            ↓
            ↓  WebSocket（充当 OpenClaw Channel 端）
            ↓
OpenClaw Gateway（插件系统）
```

Agent 面板采用聊天式 UI（非 xterm.js 终端），支持角色区分（user/assistant/system）、ANSI 颜色渲染、流式输出、diff 预览与确认。

# 安装与运行

## 环境要求

- **Node.js** ≥ 18
- **Rust** ≥ 1.70（通过 [rustup](https://rustup.rs/) 安装）
- **Tauri 2 系统依赖**：参考 [Tauri 官方指南](https://v2.tauri.app/start/prerequisites/)
  - macOS：Xcode Command Line Tools
  - Windows：Microsoft Visual Studio C++ Build Tools、WebView2
  - Linux：`libwebkit2gtk-4.1`、`libappindicator3`、`librsvg2` 等

## 安装

```bash
# 克隆仓库
git clone https://github.com/<owner>/ClawEditor.git
cd ClawEditor

# 安装前端依赖
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

# 已实现的 Skill

## 本地命令（不经过 Gateway）

- **/edit**：本地编辑命令，利用大模型解析用户自然语言为标准编辑操作（replace、delete、insert、append、行操作、大小写转换等）
- **/find**：本地查找命令，利用大模型解析用户自然语言为标准查找操作

## Gateway Skill（经由 OpenClaw 大模型处理）

- **/aiedit**：利用大模型实现复杂编辑，会将文本内容传给 OpenClaw 底层大模型
- **/aimport**：利用大模型以 markdown 格式导入文件
- **/aicorrect**：利用大模型进行拼写纠错和标点符号检查

## 远程命令

- **/confirm**：确认远程提案
- **/cancel**：拒绝远程提案

# 远程编辑（Channel 端）

已实现。OpenClaw Channel 可通过 Gateway 向 ClawEditor 发送编辑命令：

1. Channel 发送 `claweditor.command` 事件至 Gateway
2. Gateway 转发至 ClawEditor 的 WebSocket 连接
3. ClawEditor 本地执行命令，生成 diff
4. diff 结果通过 `sendCommandStatus` 回传给 Channel 供确认
5. Channel 发送 `/confirm` 或 `/cancel` 完成闭环

支持 `--file <name>` 参数指定目标文件。命令通过 `requestId` 关联请求与响应，确保多命令并发时结果不错乱。


# 架构决策与约束

## 1. Channel 传输协议

- OpenClaw Channel 与 Gateway 之间采用 WebSocket 长连接。
- ClawEditor 当前实现为简化 JSON（`type: "request"` 等），与官方 Gateway 的 `req`/`res`/`event` 不一致时，需在服务端或适配层转换。

## 2. 远程修改与保存（强约束）

- 允许远程发起修改意图；须先 diff 预览 → 用户确认 → 再落盘。

## 3. 协作与同步模型

- 以 ClawEditor 桌面端为编辑与落盘锚点；不做多用户冲突合并。

## 4. 命令行 UI

- 命令行 UI 不提供系统 shell；区分 OpenClaw 命令与本地轻量文本操作。

## 5. 本地轻量文件命令

- 查找、替换、删除、添加等在编辑器内确定性执行；若会改磁盘，仍走确认后再保存。

## 6. 安全与范围

- 文件操作限制在工作区内；关键操作带 `requestId` 便于排障。
