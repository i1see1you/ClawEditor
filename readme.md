ClawEditor 是一款基于 OpenClaw 与 Tauri 构建的 AI 驱动型轻量级跨平台文本编辑器。所有的编辑操作都需要用户先确认diff，然后再应用修改，一个编辑命令就是一个skill，支持用户自定义skill。

目前已实现的skill功能如下：
/edit：本地编辑命令，用户直接输入编辑请求，利用大模型解析命令为标准的本地编辑命令
/find：本地查找命令，用户输入查找请求，利用大模型解析命令为标准的本地查找命令
/aiedit：利用大模型实现复杂的编辑命令，该命令会将文本内容传给openclaw底层的大模型，需要确保文件内容不明感或使用的大模型基本安全可控。
/aiimport：利用大模型实现以markdown格式导入文件
/aicorrect：利用大模型能力进行拼写纠错和标点符号检查

TODO：
openclaw的channel端远程编辑

# 最终最简架构
## **本地桌面 GUI = 编辑器界面 + 内置 OpenClaw Channel 终端**
也就是说：

### **本地 GUI 里下方的 xterm.js 命令窗口
= 直接就是 OpenClaw Channel 端的命令入口**

不用两套系统、不用重复开发、不用通信桥接。

---

# 一、最终统一架构（最精简、最真实）
```
ClawEditor 桌面端（Tauri + React + CodeMirror 6）
  ├─ 上半部分：CodeMirror 编辑器（内容展示与编辑）
  └─ 下半部分：xterm.js 终端
            ↓
            ↓ **直接充当 OpenClaw Channel 端**
            ↓
OpenClaw Gateway（插件系统）
```

## 一句话定义：
### **xterm 终端 = 本地 GUI 的命令控制台
同时 = OpenClaw Channel 的命令交互端**

---

# 二、这样做的巨大优势
- **不用开发两套 Channel**
- **命令逻辑完全复用**（你之前写的 /edit /replace /diff /yes /no 全部通用）
- **本地体验 = 远程体验一致**
- **架构极度干净**
- **可直接对接 OpenClaw 插件体系**
- **AI、Skill、Tool 全部共用**

---

# 三、两个端的功能最终合并说明（正式版）

## 1. 本地桌面 GUI（主端）
**功能：**
- 完整文本编辑（CodeMirror 6）
- 本地文件打开/保存
- PDF 导入/导出
- 语法高亮、行号、多光标
- 暗色界面
- **内置 xterm.js 命令行**

## 2. 内置 xterm 命令窗口（同时 = OpenClaw Channel 端）
**功能：**
- 执行所有 OpenClaw 编辑器命令：
  - `/edit` `/replace` `/content` `/ai` `/yes` `/no`
- 显示 diff 预览
- 显示状态与消息
- **修改直接反映到上方编辑器**
- **


**

---

# 四、最终架构图（可直接放 PPT）
```
┌─────────────────────────────────────────┐
          ClawEditor 桌面应用
├─────────────────────────────────────────┤
│  [ CodeMirror 6 编辑器 ]                 │
│                                          │
│  [ xterm.js 命令终端 ]                   │
│       ↑                                  │
│       │（直接充当 OpenClaw Channel）      │
└──────────┬───────────────────────────────┘
           │
┌──────────▼───────────────────────────────┐
           OpenClaw Gateway
├─────────────────────────────────────────┤
  └─ ClawEditor 插件（命令逻辑 + diff + 状态）
```

---

# 五、最终一句话总结（可直接写文档）
### **ClawEditor 本地桌面端内置的 xterm.js 命令窗口，
可以直接作为 OpenClaw Channel 端使用，
命令逻辑、状态、diff 确认、AI 能力完全共用，
无需额外开发，架构统一、体验一致。**

---

# 六、架构决策与约束（规范）

以下条款用于多端 Channel 与 ClawEditor 桌面端对齐（实现时可按需调整）。

## 1. Channel 传输协议

- **OpenClaw Channel 与 Gateway 之间采用 WebSocket** 长连接（由 Gateway / 适配服务决定具体帧格式）。
- **ClawEditor 当前实现**为 **简化 JSON**（`type: "request"` 等），与官方 Gateway 的 `req`/`res`/`event` 不一致时，需在 **服务端或适配层** 转换。

## 2. 远程修改与保存（强约束）

- **允许**远程发起修改意图；**须**先 **diff 预览 → 用户确认 → 再落盘**。

## 3. 协作与同步模型

- **以 ClawEditor 桌面端为编辑与落盘锚点**；不做多用户冲突合并。

## 4. 终端：不跑真实 shell

- 命令行 UI **不**提供系统 shell；区分 **OpenClaw 命令** 与 **本地轻量文本操作**。

## 5. 本地轻量文件命令

- 查找、替换、删除、添加等 **在编辑器内确定性执行**；若会改磁盘，仍走 **确认后再保存**。

## 6. 安全与范围（建议）

- 文件操作限制在 **工作区** 内；关键操作可带 `requestId` 便于排障。

---

## 7. Agent 面板路由（ClawEditor 当前实现）

1. **先**用本地轻量规则解析整行输入（`simpleCommands`）。**命中则仅本地**，不发 WebSocket。
2. **未命中**则发往 OpenClaw；`action` 规则：
   - **`/edit`**、**`/explain`**、**`/format`** 前缀优先；
   - 以 **`格式化` / `format`** 开头 → `format`；
   - 以 **`解释` / `explain` / `说明` / `讲解`** 开头 → `explain`；
   - **其余默认 `explain`**。
3. 需要 **改文件且走模型** 时使用 **`/edit …`**。

**协议说明**：编辑器与 OpenClaw 的 **WebSocket 消息体** 以 `src/openclaw/wsClient.ts`、`types.ts` 为准；对接 **官方 Gateway** 时请使用 **适配服务**。

---
