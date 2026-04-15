/**
 * 从模型回复中取出 JSON 对象（支持裸 JSON 或 ```json 围栏）。
 */
export function extractJsonObject(raw: string): unknown {
  const s = raw.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fence ? fence[1].trim() : s
  const brace = candidate.indexOf('{')
  if (brace === -1) throw new Error('回复中未找到 JSON 对象')
  const tail = candidate.slice(brace)
  let depth = 0
  let end = -1
  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end === -1) throw new Error('JSON 对象括号不匹配')
  return JSON.parse(tail.slice(0, end)) as unknown
}

export function parseIntentEnvelope(raw: unknown): { version: number; intent: unknown } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('JSON 根类型无效')
  }
  const o = raw as Record<string, unknown>
  if (typeof o.version === 'number' && o.intent !== undefined && typeof o.intent === 'object' && o.intent !== null) {
    return { version: o.version, intent: o.intent }
  }
  if (typeof o.op === 'string') {
    return { version: 1, intent: o }
  }
  throw new Error('JSON 缺少 version+intent 或可识别的 op 字段')
}
