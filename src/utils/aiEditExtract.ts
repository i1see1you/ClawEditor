import { mergeRange } from './documentOps'

function countTripleBackticks(s: string): number {
  return (s.match(/```/g) ?? []).length
}

function extractFencedBlockAfterMarker(markdown: string, markerRe: RegExp): string | null {
  const m = [...markdown.matchAll(markerRe)]
  if (m.length === 0) return null
  const last = m[m.length - 1]
  const startIdx = (last.index ?? 0) + last[0].length
  const rest = markdown.slice(startIdx)
  const fenceRe = /```(?:[a-zA-Z0-9_.+-]+)?\n?([\s\S]*?)```/
  const fm = fenceRe.exec(rest)
  if (!fm) return null
  const inner = fm[1].trim()
  return inner.length >= 1 ? inner : null
}

function extractYamlBlockAfterKey(markdown: string, keyRe: RegExp): string | null {
  const m = [...markdown.matchAll(keyRe)]
  if (m.length === 0) return null
  const last = m[m.length - 1]
  const startIdx = (last.index ?? 0) + last[0].length
  const rest = markdown.slice(startIdx)
  const lines = rest.split('\n')
  const out: string[] = []
  for (const line of lines) {
    // Accept indented YAML literal block lines, stop at first non-indented non-empty line.
    if (/^\s{2,}/.test(line)) {
      out.push(line.replace(/^\s+/, ''))
      continue
    }
    if (out.length === 0) {
      // Skip initial empty lines right after the key.
      if (line.trim().length === 0) continue
      // If the first non-empty line isn't indented, this isn't a literal block.
      return null
    }
    if (line.trim().length === 0) {
      out.push('')
      continue
    }
    break
  }
  const inner = out.join('\n').trim()
  return inner.length >= 1 ? inner : null
}

/**
 * Extract full file content from assistant markdown.
 * - Requires **closed** ``` fences (odd count means streaming/partial → do not extract).
 * - Does not treat the whole message as file text (avoids "I'll help…" becoming the document).
 */
export function extractDocumentFromAssistantMarkdown(markdown: string): string | null {
  const t = markdown.trim()
  if (!t) return null
  if (t.startsWith('{') && t.endsWith('}')) return null

  const ticks = countTripleBackticks(t)
  if (ticks > 0 && ticks % 2 !== 0) {
    return null
  }

  // Prefer YAML literal output commonly used by some Gateways:
  //   newText: |
  //     <content>
  const fromYaml = extractYamlBlockAfterKey(t, /\bnewText:\s*\|\s*\n/g)
  if (fromYaml) return fromYaml

  // Prefer extracting the fenced block that follows a "NewText:" marker, which is the common
  // Gateway/plaintext fallback format. This avoids accidentally extracting unrelated metadata
  // blocks such as "Sender (untrusted metadata)".
  const fromNewText = extractFencedBlockAfterMarker(t, /\bNewText:\s*/g)
  if (fromNewText) return fromNewText

  const fenceRe = /```(?:[a-zA-Z0-9_.+-]+)?\n?([\s\S]*?)```/g
  let best: string | null = null
  let bestLen = 0
  let m: RegExpExecArray | null
  while ((m = fenceRe.exec(t)) !== null) {
    const inner = m[1].trim()
    if (inner.length > bestLen) {
      bestLen = inner.length
      best = inner
    }
  }
  if (best !== null && best.length >= 1) return best

  return null
}

export function mergeAiEditExtractWithSnapshot(
  snapshot: string,
  ctx: { diffMode: 'full' | 'selection'; selFrom: number; selTo: number },
  extracted: string
): string {
  if (ctx.diffMode === 'full') return extracted

  const from = ctx.selFrom
  const to = ctx.selTo
  if (from >= to) return extracted

  const prefix = snapshot.slice(0, from)
  const suffix = snapshot.slice(to)

  const looksLikeFullMerged =
    extracted.length >= snapshot.length - (to - from) - 1 &&
    extracted.slice(0, from) === prefix &&
    extracted.slice(extracted.length - suffix.length) === suffix

  if (looksLikeFullMerged) return extracted

  return mergeRange(snapshot, from, to, extracted)
}
