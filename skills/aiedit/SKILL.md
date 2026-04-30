---
name: aiedit
description: AI-assisted local edit for ClawEditor — model output must be JSON only (four local edit ops).
kind: local_intent_four_op
---

```help
用法：/aiedit <自然语言指令>

说明：
- 由 OpenClaw 按 skills/aiedit/SKILL.md 协议生成本地 JSON 意图（四种本地 op）。
- 无选区：附带全文，确认时为全文 diff。
- 有选区：仅发送选区（作用域文本），确认时可仅 diff 选区。
- 需已连接 OpenClaw Gateway。

示例：
- /aiedit 把语气改得更正式
```

# ClawEditor `/aiedit`（本地编辑意图）

ClawEditor 会把「当前作用域文本（无选区则为全文；有选区则为选区文本） + 用户指令」发给 OpenClaw Gateway。**不要**直接写入磁盘；**不要**把磁盘上的文件当作真实来源（缓冲区可能有未保存修改）。

## 你必须输出的形式

回复中 **只包含一个 JSON 对象**（不要有其它解释性文字，不要用 markdown 代码块包裹），并且 **字段必须放在顶层**，形如：

```json
{ "version": 1, "op": "replace_file", "text": "…" }
```

## 允许的 `op`（仅此四种）

| op | 含义 | 必填字段 |
|----|------|----------|
| `replace_file` | 用 `text` 替换整个缓冲区 | `text` |
| `replace_selection` | 用 `text` 替换 UTF-16 区间 `[selFrom, selTo)` | `selFrom`, `selTo`, `text` |
| `append` | 在文末追加 `text` | `text` |
| `insert` | 在 UTF-16 偏移 `at` 处插入 `text` | `at`, `text` |

- 偏移均为 **UTF-16 代码单元**，与请求里给出的选区/全文的约定一致。
- `replace_selection` 的区间必须与请求里给出的 `from`/`to` 一致（它们指向原始全文中的 UTF-16 偏移）；不要臆测选区外内容。

## 禁止使用 Gateway 写盘工具

仅通过 **上述 JSON** 表达编辑结果；不要使用会写入、覆盖、保存、打补丁到磁盘路径的工具。
