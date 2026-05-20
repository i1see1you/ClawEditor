ClawEditor 是一款基于 OpenClaw 与 Tauri 构建的 AI 驱动型轻量级跨平台文本编辑器。所有的编辑操作都需要用户先确认 diff，然后再应用修改。一个编辑命令就是一个 skill，支持用户自定义 skill。

# 本地和channel端效果预览图

<img width="2934" height="1860" alt="image" src="https://github.com/user-attachments/assets/7b315424-c924-4b1f-9711-85a85ae61867" />

<img width="1088" height="2400" alt="image" src="https://github.com/user-attachments/assets/ee9619d9-511b-4c41-9ed6-34a388893cd2" />


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
git clone https://github.com/i1see1you/ClawEditor.git
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

# 安装openclaw插件
安装openclaw插件后再启动编辑器的“开启远程编辑”选项就可以支持所有openclaw channel端进行远程文件编辑，安装插件命令如下：<br/>
```bash
openclaw plugins install integrations/openclaw-gateway
```

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

已实现。OpenClaw Channel 通过 **claweditor-gateway** 插件与编辑器以 **`claw_editor.v1.*`** 协议协作：

1. Channel 用户发送 `/edit`、`/aiedit` 等业务命令
2. 插件 `before_dispatch` 转为 `claw_editor.v1.request`（含 `req_*` 流水号与 `context`）并转发给持有远程编辑租约的 ClawEditor
3. 编辑器执行命令并生成提案；通过 `emitV1Event` 回传 `claw_editor.v1.diff_response`（统一 diff 文本）至 IM
4. Channel 用户发送 `/confirm req_xxx` 或 `/cancel req_xxx`；插件转为 `claw_editor.v1.commit`，编辑器应用或忽略并回传 `commit_response`

支持 `--file <basename>` 指定已打开文件。每条命令以 `request_id` 关联请求、diff 与确认，支持同文件多 pipeline 并发。


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
