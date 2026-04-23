import hljs from 'highlight.js/lib/core'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import python from 'highlight.js/lib/languages/python'
import typescript from 'highlight.js/lib/languages/typescript'
import json from 'highlight.js/lib/languages/json'

/**
 * Full-buffer line count above this skips hljs in PDF (escaped plain pre only).
 * Kept in sync with PDF export line cap in App.
 */
export const MAX_PDF_SYNTAX_HIGHLIGHT_LINES = 10_000

/** Languages we ship for PDF export (keep bundle small). */
const PDF_SYNTAX_LANGS = new Set(['xml', 'css', 'python', 'typescript', 'json'])

let registered = false

function ensureHljsRegistered() {
  if (registered) return
  hljs.registerLanguage('xml', xml)
  hljs.registerLanguage('css', css)
  hljs.registerLanguage('python', python)
  hljs.registerLanguage('typescript', typescript)
  hljs.registerLanguage('json', json)
  registered = true
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function themeCss(theme: 'light' | 'dark'): string {
  if (theme === 'dark') {
    return `
.hljs-comment,.hljs-quote{color:#6a9955}
.hljs-keyword,.hljs-selector-tag,.hljs-addition{color:#c586c0}
.hljs-built_in,.hljs-section,.hljs-title,.hljs-type{color:#4ec9b0}
.hljs-string,.hljs-meta .hljs-string{color:#ce9178}
.hljs-subst,.hljs-number,.hljs-regexp,.hljs-symbol,.hljs-variable,.hljs-template-variable,.hljs-link,.hljs-selector-attr,.hljs-selector-pseudo{color:#b5cea8}
.hljs-doctag,.hljs-formula,.hljs-name,.hljs-selector-id{color:#dcdcaa}
.hljs-attr,.hljs-attribute{color:#9cdcfe}
.hljs-meta,.hljs-meta-keyword{color:#569cd6}
.hljs-emphasis{font-style:italic}
.hljs-strong{font-weight:700}
`
  }
  return `
.hljs-comment,.hljs-quote{color:#008000}
.hljs-keyword,.hljs-selector-tag,.hljs-addition{color:#00f}
.hljs-built_in,.hljs-section,.hljs-title,.hljs-type{color:#267f99}
.hljs-string,.hljs-meta .hljs-string{color:#a31515}
.hljs-subst,.hljs-number,.hljs-regexp,.hljs-symbol,.hljs-variable,.hljs-template-variable,.hljs-link,.hljs-selector-attr,.hljs-selector-pseudo{color:#098658}
.hljs-doctag,.hljs-formula,.hljs-name,.hljs-selector-id{color:#795e26}
.hljs-attr,.hljs-attribute{color:#0451a5}
.hljs-meta,.hljs-meta-keyword{color:#0000ff}
.hljs-emphasis{font-style:italic}
.hljs-strong{font-weight:700}
`
}

/**
 * HTML fragment for exporting source code to PDF: syntax highlight only when the
 * language is whitelisted and the full file line count (before PDF truncation) is small.
 */
export function buildPdfSourceHtml(options: {
  code: string
  language: string
  theme: 'light' | 'dark'
  /** Full buffer line count in the editor, not the truncated `code` length. */
  fileLineCount: number
}): string {
  const { code, language, theme, fileLineCount } = options
  const useHljs =
    PDF_SYNTAX_LANGS.has(language) && fileLineCount <= MAX_PDF_SYNTAX_HIGHLIGHT_LINES

  if (useHljs) ensureHljsRegistered()

  const bodyFg = theme === 'dark' ? '#cccccc' : '#333333'
  const blockBg = theme === 'dark' ? '#252526' : '#f6f8fa'
  const border = theme === 'dark' ? '#3c3c3c' : '#e1e4e8'

  let inner: string
  if (useHljs) {
    try {
      inner = hljs.highlight(code, { language, ignoreIllegals: true }).value
    } catch {
      inner = escapeHtml(code)
    }
  } else {
    inner = escapeHtml(code)
  }

  const preClass = useHljs ? 'hljs pdf-code-block' : 'pdf-code-block pdf-plain'

  return `
<style>
.pdf-code-wrap { margin: 0; }
.pdf-code-block {
  display: block;
  margin: 0;
  padding: 16px;
  overflow-x: auto;
  white-space: pre;
  word-break: normal;
  tab-size: 4;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 13px;
  line-height: 1.45;
  background: ${blockBg};
  color: ${bodyFg};
  border: 1px solid ${border};
  border-radius: 6px;
  box-sizing: border-box;
}
.pdf-plain { }
${themeCss(theme)}
</style>
<div class="pdf-code-wrap"><pre class="${preClass}">${inner}</pre></div>
`
}
