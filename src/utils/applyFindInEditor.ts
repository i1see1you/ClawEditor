import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { SearchQuery, openSearchPanel, setSearchQuery } from '@codemirror/search'
import { flushSearchMatchStatus, runFindNextWithFeedback } from '../editor/searchMatchStatus'

export type FindQuerySpec = {
  search: string
  regexp: boolean
  literal: boolean
  caseSensitive: boolean
  /** Limit matches to [from, to) in UTF-16 offsets. */
  restrictTo?: { from: number; to: number }
}

export function applyFindInEditor(
  view: EditorView,
  spec: FindQuerySpec
): { ok: true; summary: string } | { ok: false; message: string } {
  const restrictTo = spec.restrictTo
  const test =
    restrictTo && restrictTo.from < restrictTo.to
      ? (_m: string, _state: EditorState, from: number, to: number) =>
          from >= restrictTo.from && to <= restrictTo.to
      : undefined

  const query = new SearchQuery({
    search: spec.search,
    regexp: spec.regexp,
    literal: spec.literal,
    caseSensitive: spec.caseSensitive,
    replace: '',
    test,
  })

  if (!query.valid) {
    return {
      ok: false,
      message: spec.regexp ? '正则表达式无效或不受支持。' : '查找内容无效。',
    }
  }

  view.dispatch({
    effects: setSearchQuery.of(query),
  })
  openSearchPanel(view)
  runFindNextWithFeedback(view)
  flushSearchMatchStatus(view)

  const mode = spec.regexp ? '正则' : '字面'
  const cs = spec.caseSensitive ? '区分大小写' : '忽略大小写'
  const scopeHint =
    restrictTo && restrictTo.from < restrictTo.to ? '；仅在当前选区内' : ''
  return {
    ok: true,
    summary: `已设置查找（${mode}，${cs}${scopeHint}）并打开搜索面板`,
  }
}
