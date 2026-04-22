---
name: aiimport
description: Import external text into the editor buffer using only the four local JSON edit commands.
---

```claweditor
{
  "version": 1,
  "instructionWrapper": {
    "prefix": "请将下面内容导入到当前缓冲区。\n默认一律在文档末尾追加（使用 JSON op `append`），不要插入到光标处或替换选区，除非下面「用户在斜杠命令后写的自然语言」里明确要求光标处插入、替换当前选区、或整篇替换等。若用户未写明位置，只输出 `append`。"
  },
  "args": {
    "source": {
      "required": true,
      "detect": {
        "anyOf": [
          { "regex": "--source\\s+(file|clipboard)" },
          { "regex": "--file\\s+(.+)" },
          { "regex": "--clipboard\\b" }
        ]
      }
    }
  },
  "completions": [
    {
      "id": "pick-source",
      "when": { "missing": ["source"] },
      "do": {
        "action": "one_select",
        "ui": { "title": "选择导入来源" },
        "export": { "id": "source" },
        "options": [
          { "id": "file", "label": "选择文件" },
          { "id": "clipboard", "label": "剪贴板" }
        ]
      },
      "inject": {
        "into": "instruction_suffix",
        "template": "--source {{source}}"
      }
    },
    {
      "id": "pick-file",
      "when": { "equals": { "key": "source", "value": "file" }, "missing": ["fileContent"] },
      "do": {
        "action": "pick_file",
        "ui": { "title": "选择要导入的文件" },
        "maxBytes": 1048576,
        "export": { "name": "fileName", "content": "fileContent" }
      },
      "inject": {
        "into": "instruction_suffix",
        "template": "--- import content ({{fileName}}) ---\n{{fileContent}}\n--- end import content ---"
      }
    },
    {
      "id": "read-clipboard",
      "when": { "equals": { "key": "source", "value": "clipboard" }, "missing": ["clipboardContent"] },
      "do": {
        "action": "clipboard_read",
        "ui": { "title": "读取剪贴板" },
        "maxChars": 200000,
        "export": { "content": "clipboardContent" }
      },
      "inject": {
        "into": "instruction_suffix",
        "template": "--- import content (clipboard) ---\n{{clipboardContent}}\n--- end import content ---"
      }
    }
  ],
  "viimport": {}
}
```

# ClawEditor `/aiimport`（导入到本地缓冲区）

用户希望 **把外部内容导入当前文件**。**默认**在文末追加（`append`）。若用户在 `/aiimport` 后的命令行文字里明确要求（例如「在光标处插入」「替换选区」「整篇替换」），再使用 `insert` / `replace_selection` / `replace_file`。**不要**在未确认的情况下写入磁盘；以编辑器缓冲区为准。

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
