/**
 * Slash-command palette data (/aiedit, /aiimport, /edit …) for AgentChatInput.
 */

export type PaletteItem = {
  id: string
  /** Shown in list, e.g. "replace …" */
  label: string
  description: string
  /** Replaces text from `/` through cursor (inclusive of `/`). */
  insertFromSlash: string
}

export const ROOT_COMMANDS: PaletteItem[] = [
  {
    id: 'aiedit',
    label: '/aiedit',
    description: '按 skills/aiedit 经 Gateway 改写（JSON op 或 diff）',
    insertFromSlash: '/aiedit ',
  },
  {
    id: 'aiimport',
    label: '/aiimport',
    description: '按 skills/aiimport 导入外部内容到当前缓冲',
    insertFromSlash: '/aiimport ',
  },
  {
    id: 'edit',
    label: '/edit',
    description: '本地子命令；无法解析时可走 Gateway',
    insertFromSlash: '/edit ',
  },
]

export const EDIT_SUBCOMMANDS: PaletteItem[] = [
  {
    id: 'edit-help',
    label: 'help',
    description: '列出 /edit 用法',
    insertFromSlash: '/edit help',
  },
  {
    id: 'edit-replace',
    label: 'replace …',
    description: 'replace A with B（或 A -> B）',
    insertFromSlash: '/edit replace ',
  },
  {
    id: 'edit-delete',
    label: 'delete …',
    description: '删除字面片段（delete/remove）',
    insertFromSlash: '/edit delete ',
  },
  {
    id: 'edit-line',
    label: 'line …',
    description: 'trim | sort | dedupe | empty | blank',
    insertFromSlash: '/edit line ',
  },
  {
    id: 'edit-case',
    label: 'case …',
    description: 'upper | lower | title',
    insertFromSlash: '/edit case ',
  },
  {
    id: 'edit-insert',
    label: 'insert …',
    description: '光标处插入（剪贴板 / 引号块）',
    insertFromSlash: '/edit insert ',
  },
  {
    id: 'edit-append',
    label: 'append …',
    description: '文末追加',
    insertFromSlash: '/edit append ',
  },
  {
    id: 'edit-replace-file',
    label: 'replace-file …',
    description: '整篇替换',
    insertFromSlash: '/edit replace-file ',
  },
  {
    id: 'edit-replace-sel',
    label: 'replace-selection …',
    description: '选区整块替换（需非空选区）',
    insertFromSlash: '/edit replace-selection ',
  },
  {
    id: 'edit-freeform',
    label: '（自然语言）',
    description: '自由描述；本地解析失败则走 Gateway',
    insertFromSlash: '/edit ',
  },
]

export type PaletteState = { open: false } | { open: true; items: PaletteItem[] }

function filterItems(items: PaletteItem[], q: string): PaletteItem[] {
  const f = q.trim().toLowerCase()
  if (!f) return items
  return items.filter(
    (it) =>
      it.label.toLowerCase().includes(f) ||
      it.id.toLowerCase().includes(f) ||
      it.description.toLowerCase().includes(f) ||
      it.insertFromSlash.toLowerCase().includes(f)
  )
}

/** True when user has moved past the palette-only prefix for aiedit/aiimport. */
function isAfterRemoteCommandBody(lineFromSlash: string): boolean {
  return /\/(aiedit|aiimport)\s+\S/.test(lineFromSlash)
}

export function getPaletteState(value: string, cursorPos: number): PaletteState {
  const lineStart = value.lastIndexOf('\n', cursorPos - 1) + 1
  const line = value.slice(lineStart, cursorPos)
  const lead = line.match(/^\s*/)
  const indent = lead ? lead[0] : ''
  const trimmed = line.slice(indent.length)
  if (!trimmed.startsWith('/')) return { open: false }

  const fromSlash = trimmed
  if (isAfterRemoteCommandBody(fromSlash)) return { open: false }

  const rest = fromSlash.slice(1)
  const tokens = rest.trim() ? rest.trim().split(/\s+/) : []

  if (tokens.length === 0) {
    return { open: true, items: ROOT_COMMANDS }
  }

  const head = (tokens[0] ?? '').toLowerCase()
  const tail = tokens.slice(1).join(' ').toLowerCase()

  if (head === 'edit' && tokens.length >= 1) {
    return { open: true, items: filterItems(EDIT_SUBCOMMANDS, tail) }
  }

  const rootFiltered = filterItems(
    ROOT_COMMANDS,
    tokens.join(' ').toLowerCase()
  )
  return { open: true, items: rootFiltered }
}

/** Hint under input when line looks like `/edit replace` without full operands (for placeholder only). */
export function getEditReplaceParamHint(line: string): string | null {
  const t = line.trim()
  const m = t.match(/^\/edit\s+replace(?:\s+([\s\S]*))?$/i)
  if (!m) return null
  const after = (m[1] ?? '').trim()
  if (!after) return '例：/edit replace foo with bar 或 foo -> bar'
  if (!/\bwith\b/i.test(after) && !/(?:->|=>)/.test(after)) {
    return '补全：… with … 或 … -> …'
  }
  return null
}
