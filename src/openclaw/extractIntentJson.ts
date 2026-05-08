/**
 * 从模型回复中取出 JSON 对象（支持裸 JSON 或 ```json 围栏）。
 *
 * 对象边界用「字符串感知」的括号匹配：`"text"` 值里的 `{` `}` 不参与 depth，
 * 避免 `/aiimport` 等大段正文中含花括号时被过早截断。
 */
function isHexChar(c: string): boolean {
  return /^[0-9a-fA-F]$/.test(c)
}

/** `tail` 须以 `{` 开头；返回根对象结束位置（exclusive），失败为 -1。 */
function findRootObjectEnd(tail: string): number {
  if (tail[0] !== '{') return -1
  let depth = 0
  let inString = false
  let escape = false
  let i = 0
  while (i < tail.length) {
    const ch = tail[i]
    if (inString) {
      if (escape) {
        if (ch === 'u') {
          if (i + 4 >= tail.length) return -1
          for (let j = 1; j <= 4; j++) {
            if (!isHexChar(tail[i + j]!)) return -1
          }
          i += 5
          escape = false
          continue
        }
        escape = false
        i += 1
        continue
      }
      if (ch === '\\') {
        escape = true
        i += 1
        continue
      }
      if (ch === '"') {
        inString = false
        i += 1
        continue
      }
      i += 1
      continue
    }

    if (ch === '"') {
      inString = true
      i += 1
      continue
    }
    if (ch === '{') {
      depth += 1
      i += 1
      continue
    }
    if (ch === '}') {
      depth -= 1
      if (depth === 0) return i + 1
      i += 1
      continue
    }
    i += 1
  }
  return -1
}

export function extractJsonObject(raw: string): unknown {
  const s = raw.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fence ? fence[1].trim() : s
  const brace = candidate.indexOf('{')
  if (brace === -1) throw new Error('回复中未找到 JSON 对象')
  const tail = candidate.slice(brace)
  const end = findRootObjectEnd(tail)
  if (end === -1) throw new Error('JSON 对象括号不匹配')
  return JSON.parse(tail.slice(0, end)) as unknown
}

export function parseIntentEnvelope(raw: unknown): { version: number; intent: unknown } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('JSON 根类型无效')
  }
  const o = raw as Record<string, unknown>
  if (typeof o.version === 'number' && o.intent !== undefined) {
    if (Array.isArray(o.intent)) {
      if (o.version !== 2) {
        throw new Error('intent 为数组时 version 必须为 2')
      }
      return { version: o.version, intent: o.intent }
    }
    if (typeof o.intent === 'object' && o.intent !== null) {
      return { version: o.version, intent: o.intent }
    }
  }
  if (typeof o.op === 'string') {
    return { version: 1, intent: o }
  }
  throw new Error('JSON 缺少 version+intent 或可识别的 op 字段')
}
