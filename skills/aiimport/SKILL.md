---
name: aiimport
description: Import external text into the editor buffer using only the four local JSON edit commands.
---

# ClawEditor `/aiimport`（导入到本地缓冲区）

用户希望 **把外部内容导入当前文件**（例如在光标处插入、文末追加、替换选区或整文）。**不要**在未确认的情况下写入磁盘；以编辑器缓冲区为准。

## 输出形式

仅输出 **一个 JSON 对象**（无其它文字、无 markdown 围栏），并且 **字段必须放在顶层**：

```json
{ "version": 1, "op": "insert", "at": 0, "text": "…" }
```

## 允许的 `op`（与 `/aiedit` 相同，仅此四种）

| op | 用途 |
|----|------|
| `replace_file` | 用导入内容替换整篇 |
| `replace_selection` | 替换 `[selFrom, selTo)` |
| `append` | 追在文末 |
| `insert` | 在 `at` 处插入 |

导入多段时，优先一条 JSON 内用 `insert`/`append` 表达；必要时使用 `replace_selection` 覆盖明确区间。
