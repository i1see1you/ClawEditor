/** Supported protocol version for parsed_intent payloads (client + server). */
export const SUPPORTED_INTENT_PROTOCOL_VERSION = 1

export type IntentScope = 'auto' | 'file' | 'selection' | 'lines'

export type IntentOp =
  | 'replace_all'
  | 'replace_regex'
  | 'delete_literal'
  | 'remove_empty_lines'
  | 'remove_blank_lines'
  | 'trim_trailing'
  | 'sort_lines'
  | 'dedupe_lines'
  | 'case_upper'
  | 'case_lower'
  | 'case_title'
  | 'insert_at'
  | 'append'
  | 'set_document'
  | 'set_selection'
  | 'goto_line'
  | 'clarify'
  | 'noop'

export interface EditorIntentV1 {
  op: IntentOp
  scope?: IntentScope
  from?: string
  to?: string
  pattern?: string
  flags?: string
  replacement?: string
  needle?: string
  line?: number
  message?: string
  /** UTF-16 offset for insert_at; defaults to selection/cursor when omitted. */
  offset?: number
  /** Text to insert (insert_at / append). */
  text?: string
}
