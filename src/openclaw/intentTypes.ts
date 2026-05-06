/** Supported protocol version for parsed_intent payloads (client + server). */
export const SUPPORTED_INTENT_PROTOCOL_VERSION = 1

export type IntentScope = 'auto' | 'file' | 'selection' | 'lines'

export type IntentOp =
  | 'replace_all'
  | 'replace_regex'
  | 'delete_literal'
  | 'sort_lines'
  | 'dedupe_lines'
  | 'case_upper'
  | 'case_lower'
  | 'case_title'
  | 'insert_at'
  | 'append'
  | 'set_document'
  | 'set_selection'
  /** Skill `/aiedit` / `/aiimport` four-op JSON (whole buffer). */
  | 'replace_file'
  /** UTF-16 [selFrom, selTo) + text. */
  | 'replace_selection'
  /** Same as insert_at; skill alias using `at`. */
  | 'insert'
  | 'goto_line'
  /** Set editor search query + panel; scope limits matches when selection. */
  | 'find_literal'
  | 'find_regex'
  | 'clarify'
  | 'noop'

export interface EditorIntentV1 {
  op: IntentOp
  scope?: IntentScope
  from?: string
  to?: string
  /** replace_selection: UTF-16 start (inclusive). */
  selFrom?: number
  /** replace_selection: UTF-16 end (exclusive). */
  selTo?: number
  /** insert: UTF-16 offset (alias of offset). */
  at?: number
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
  /** find_literal: default true when omitted. */
  caseSensitive?: boolean
}
