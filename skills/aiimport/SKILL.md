---
name: aiimport
description: Import content into the editor buffer. When importing a local file, ClawEditor sends only the local file path; OpenClaw Gateway must read the file and extract visible text (PDF/Word/RTF) before emitting the four local JSON ops.
---

```help
用法：/aiimport  或  /aiimport <位置说明（可选）>

说明：
- 按 skills/aiimport/SKILL.md 将外部内容导入当前缓冲；模型仅输出 JSON（四种本地 op）。
- 默认在文末追加；仅在命令行里写明光标/选区/整篇替换等要求时才改插入位置。
- 若缺少导入源参数，将按 skill 的补全规则自动弹窗补全。
- 选择文件时只传本机路径给 Gateway；由 Gateway 读取文件并抽取可见文字（PDF/Word/RTF 等）。
- 需已连接 OpenClaw Gateway。

示例：
- /aiimport
- /aiimport 在光标处插入
```

```claweditor
{
  "version": 1,
  "instructionWrapper": {
    "prefix": "请将下面内容导入到当前缓冲区。\n\n【格式处理 — OpenClaw（B 方案：按路径读取）】\n- 若你看到 `--- import source (file: ...) ---` 块，其中包含 `path: ...`，这表示 ClawEditor 只提供了 **本机文件路径**；你必须在 Gateway 侧读取该文件并抽取人类可见正文。\n- 对 `.pdf` / `.doc` / `.docx` / `.rtf`：必须用确定性的解析器/工具抽取可见文字（不要把 PDF/Word/RTF 源码当正文导入）。\n- 对扫描版 PDF：若几乎无文本层，需提示用户（或走 OCR 能力）；禁止编造正文。\n- 安全约束：只读取用户明确提供的 `path`，不得扩展为目录扫描或读取其它路径。\n\n【插入位置】\n默认一律在文档末尾追加（JSON op `append`），不要插入到光标处或替换选区，除非「用户在斜杠命令后写的自然语言」里明确要求光标处插入、替换当前选区、或整篇替换。若用户未写明位置，只输出 `append`。"
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
    },
    "filePath": {
      "required": false,
      "detect": {
        "anyOf": [{ "regex": "--file\\s+(.+)" }]
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
      "when": { "equals": { "key": "source", "value": "file" }, "missing": ["filePath"] },
      "do": {
        "action": "pick_file",
        "ui": { "title": "选择要导入的文件" },
        "maxBytes": 20971520,
        "export": { "name": "fileName", "path": "filePath" }
      },
      "inject": {
        "into": "instruction_suffix",
        "template": "--- import source (file: {{fileName}}) ---\npath: {{filePath}}\n--- end import source ---"
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
  ]
}
```

# ClawEditor `/aiimport`（导入到本地缓冲区）

用户希望 **把外部内容导入当前文件**。**默认**在文末追加（`append`）。若用户在 `/aiimport` 后的命令行文字里明确要求（例如「在光标处插入」「替换选区」「整篇替换」），再使用 `insert` / `replace_selection` / `replace_file`。**不要**在未确认的情况下写入磁盘；以编辑器缓冲区为准。

## 文件来源与载荷形态（ClawEditor → OpenClaw）

| 情况 | 载荷 |
|------|------|
| 选择本地文件 | 仅提供 `path: ...`（由 Gateway 读取并解析） |
| 剪贴板 | 纯字符串；若看起来像 RTF（`{\\rtf`）或 PDF 魔数，仍应先抽取可见文字 |

## OpenClaw 侧职责

1. **读取**：根据 `path` 在 Gateway 侧读取文件（要求同机/同权限/受控沙箱）。  
2. **识别**：根据后缀或魔数（`%PDF`、`PK\\x03\\x04`+OOXML、`{\\rtf`、OLE 头等）选择解析器。  
3. **抽取**：得到连续可读正文；表格可扁平化为换行/制表；图片可省略或 `[image]`。  
4. **扫描版 PDF**：若几乎无文本层，简短提示或走 OCR；**不要编造正文**。  
5. **输出**：仅输出下面规定的 **一个 JSON 对象**；`text` 中只能是抽取后的**可见文字**。

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
