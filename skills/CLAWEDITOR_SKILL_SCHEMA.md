## ` ```claweditor``` ` 配置块（version 1）

在 `skills/*.md` 中，你可以放置一个 ` ```claweditor``` ` 代码块，内容是 **JSON**，用于驱动“缺参补全”和 UI 行为。

### 顶层字段

- **`version`**: `1`（必填）
- **`requiresScopeText`**: `true|false`（可选，缺省为 `true`）
- **`allowEmptyInstruction`**: `true|false`（可选，缺省为 `false`）。为 `true` 时，用户只输入 `/skillId`（命令后无其它文字）也会执行该 skill 并发往 Gateway，而不会仅打印 ` ```help``` `。适用于主要依赖编辑器作用域正文的 skill（例如 `/aicorrect`）。
- **`args`**: 参数检测与缺参判定（可选）
- **`completions`**: 补全规则列表（可选）
- **`instructionWrapper`**: 最终 instruction 外层包装（可选）
- **`/aiimport`（按路径读取）**：ClawEditor 在选择文件后向 instruction 注入 `path: ...`；Gateway 需读取该路径并解析（PDF/Word/RTF 抽取可见文字）后再生成意图 JSON（见 `skills/aiimport/SKILL.md`）。

当 `requiresScopeText` 为 `false` 时，客户端可以不发送编辑器正文（`text` 可能为空字符串），以节省上下文预算。此时 skill 应主要依赖命令行参数、补全注入块（如导入的 `path` / 剪贴板内容）或其它显式载荷完成任务。

### `args`

```json
{
  "args": {
    "source": {
      "required": true,
      "detect": {
        "anyOf": [
          { "regex": "--source\\s+(file|clipboard)" }
        ]
      }
    }
  }
}
```

- **`required`**: 缺参判定依据
- **`detect.anyOf[].regex`**: 从当前 instruction 中提取参数（第一个捕获组为值）

### `completions[]`

```json
{
  "id": "pick-source",
  "when": { "missing": ["source"] },
  "do": {
    "action": "one_select",
    "ui": { "title": "选择导入来源" },
    "options": [{ "id": "file", "label": "文件" }],
    "export": { "id": "source" }
  },
  "inject": {
    "into": "instruction_suffix",
    "template": "--source {{source}}"
  }
}
```

- **`id`**: 规则唯一标识（必填，不能重复）
- **`when`**:
  - **`missing`**: 当变量池/检测参数中缺少这些 key 时触发
  - **`equals`**: `{key,value}` 精确匹配（用于分支，如 `source=file`）
  - **`always`**: 总是触发（慎用）
- **`do.action`**（客户端提供能力）：
  - `pick_file` / `clipboard_read` / `prompt_user` / `one_select`
- **`do.export`**: action 标准输出字段重命名（便于用户自定义变量名）
  - `pick_file` 标准输出：`name`, `content`
  - `clipboard_read` 标准输出：`content`
  - `prompt_user` 标准输出：`text`
  - `one_select` 标准输出：`id`
- **`inject`**:
  - `into`: `instruction_prefix | instruction_suffix | instruction_replace`
  - `template`: 支持 `{{var}}` 替换

### `instructionWrapper`

```json
{
  "instructionWrapper": {
    "prefix": "请将下面内容导入到当前文件："
  }
}
```

最终发送给 OpenClaw 的 instruction 会自动套上 prefix/suffix。

### 运行时自检与可观测性

- 客户端会对 `completions` 做基本校验（id 重复、缺少字段等），并把错误/警告打印到 Agent 命令输出窗口。
- 每次补全会打印“补全轨迹”（命中规则、执行 action、注入位置与字符数）和最终 instruction 预览。

