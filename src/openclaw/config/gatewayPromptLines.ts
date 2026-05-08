/**
 * OpenClaw Gateway 出站消息的静态文案（与 wsChannel 拼装逻辑分离，便于审阅与迭代）。
 * 若希望非开发者可改文案，可再迁到 JSON 并在构建时校验；当前用 TS 避免转义与类型问题。
 */

export const GATEWAY_BRACKET_HEADER = '[ClawEditor → OpenClaw Gateway]' as const

/** `/edit` 意图解析：协议说明行（不含用户请求、file/path、选区与 context）。 */
export const EDIT_INTENT_PARSE_STATIC_LINES: readonly string[] = [
  '[ClawEditor /edit → OpenClaw 意图解析]',
  '你只输出一个 JSON 对象，不要 markdown 代码块、不要解释、不要多余文字。',
  '必须使用 version:1，且 intent 为「有序数组」：上一步输出的全文作为下一步输入（类 shell 管道）；客户端只对比原始全文与最终一步结果一次。',
  '单步示例：{"version":1,"intent":[{"op":"dedupe_lines","scope":"auto"}]}；多步示例：{"version":1,"intent":[{"op":"replace_regex","scope":"auto","pattern":"\\\\n\\\\n+","flags":"g","replacement":"\\\\n"},{"op":"dedupe_lines","scope":"auto"}]}。',
  '数组中每一步须为对象且含 op；除第一步外，后续步骤的 scope 建议用 file（或 auto 且无选区），因选区 UTF-16 偏移在文本变化后不再可靠；第一步可用 auto+选区表示仅处理选区。',
  '管道内禁止 find_*、goto_line、clarify；noop 可忽略。除 insert_at 默认 offset 外，勿依赖「原始光标」做后续步。',
  '每步 op 与单对象协议相同：replace_all、replace_regex、delete_literal、delete_matching_lines、sort_lines、dedupe_lines、case_*、insert_at、append、set_document、set_selection、replace_file、replace_selection 等（可有 scope）。',
  'delete_matching_lines：literal 用 needle；regex 用 pattern+可选 flags（逐行 .test）。若用户要删匹配行，优先用 delete_matching_lines 而非手写 replace_regex 删行。',
  'insert_at 使用 text 与可选 offset（第一步缺省 offset 为光标）；append 使用 text；set_document / set_selection / replace_file / replace_selection 规则同前。',
  '语言一致（必须）：replace_all 的 from、delete_literal 与 delete_matching_lines（literal）的 needle、replace_regex 与 delete_matching_lines（regex）的 pattern 等须与用户自然语言所用语言一致。',
  '原 remove_empty_lines / remove_blank_lines / trim_trailing 已废弃，请用 replace_regex：去除行尾空白 {"op":"replace_regex","pattern":"\\\\s+$","flags":"gm","replacement":""}；合并连续空行 {"op":"replace_regex","pattern":"\\\\u000a\\\\u000a+","flags":"g","replacement":"\\\\u000a"}；合并仅空白行 {"op":"replace_regex","pattern":"\\\\u000a\\\\s*\\\\u000a","flags":"g","replacement":"\\\\u000a"}；删数字示例 {"op":"replace_regex","pattern":"\\\\d+","flags":"g","replacement":""}。',
]

/** `/find` 意图解析：协议说明行（同上，不含动态段）。 */
export const FIND_INTENT_PARSE_STATIC_LINES: readonly string[] = [
  '[ClawEditor /find → OpenClaw 意图解析]',
  '你只输出一个 JSON 对象，不要 markdown 代码块、不要解释、不要多余文字。',
  '顶层示例（intent 内必须换成真实内容，禁止输出 TODO、PLACEHOLDER、示例、… 等占位）：{"version":1,"intent":{"op":"find_literal","scope":"auto","needle":"用户要搜的真实字面","caseSensitive":true}}',
  '仅查找、不修改文档。intent.op 可为：find_literal、find_regex、clarify、noop。',
  '可有 scope:"auto"|"file"|"selection"（auto：有选区则仅在选区内匹配）。',
  'find_literal：needle 为要在正文里搜的连续字面（非空）；可选 caseSensitive（默认 true）。',
  '语言一致（必须）：find_literal 的 needle、find_regex 的 pattern 中对用户所指事物的字面写法须与用户下方「自然语言查找请求」所用语言一致——用户用中文则用中文（如 丰田|本田），勿擅自换成英文或其它语言；用户用英文则用英文；用户明确指定某种书写时从其指定。',
  '若用户要「一类事物」且无法穷举：用 find_regex，pattern 给出「合理子集」即可，例如常见项用括号竖线枚举：(比亚迪|吉利|长城|长安)；不必追求全集。',
  '若信息不足、无法给出可靠 needle 或 pattern：输出 {"op":"clarify","message":"…"} 用一句话说明缺什么。',
  'find_regex 示例：{"op":"find_regex","pattern":"\\d+","flags":""} 匹配数字；pattern 为「JSON 解析后」的 JS 正则源码（\\d 为数字类），勿多写反斜杠。',
  '不要输出 replace_all、replace_regex 等编辑类 op；查找不得包含 replacement。',
]
