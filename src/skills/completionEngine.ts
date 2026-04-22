import type { ArgsSpec, CompletionRule, CompletionAction } from './claweditorConfig'

export type CompletionContext = {
  /** Raw user rest after slash command, e.g. everything after "/aiimport". */
  rest: string
  /** Suggested instruction seed (may equal rest). */
  instruction: string
}

export type CompletionActionResult = Record<string, string>

export type CompletionActionRunner = (a: CompletionAction) => Promise<CompletionActionResult | null>

export type CompletionTraceStep = {
  ruleId: string
  action: string
  injected?: { into: 'instruction_prefix' | 'instruction_suffix' | 'instruction_replace'; chars: number }
}

function detectArgs(rest: string, args?: ArgsSpec): Record<string, string> {
  if (!args) return {}
  const found: Record<string, string> = {}
  for (const [name, spec] of Object.entries(args)) {
    const anyOf = spec.detect?.anyOf ?? []
    for (const d of anyOf) {
      try {
        const re = new RegExp(d.regex, 'i')
        const m = rest.match(re)
        if (m && typeof m[1] === 'string' && m[1].length > 0) {
          found[name] = m[1]
          break
        }
      } catch {
        // ignore invalid regex
      }
    }
  }
  return found
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => vars[key] ?? '')
}

function applyExportMap(
  result: Record<string, string>,
  exportMap: Record<string, string> | undefined
): Record<string, string> {
  if (!exportMap) return result
  const out: Record<string, string> = {}
  for (const [srcKey, value] of Object.entries(result)) {
    const dstKey = exportMap[srcKey] ?? srcKey
    out[dstKey] = value
  }
  return out
}

function shouldRun(rule: CompletionRule, missing: string[]): boolean {
  if (rule.when?.always) return true
  const req = rule.when?.missing ?? []
  if (!req.length) return false
  return req.every((k) => missing.includes(k))
}

function computeMissingForRule(
  rule: CompletionRule,
  available: Record<string, string>
): string[] {
  const req = rule.when?.missing ?? []
  return req.filter((k) => !available[k])
}

export async function runSkillCompletions(params: {
  args?: ArgsSpec
  completions?: CompletionRule[]
  instructionWrapper?: { prefix?: string; suffix?: string }
  ctx: CompletionContext
  runAction: CompletionActionRunner
  maxPasses?: number
}): Promise<
  | { ok: true; instruction: string; trace: CompletionTraceStep[] }
  | { ok: false; cancelled: true; trace: CompletionTraceStep[] }
  | { ok: false; error: string; trace: CompletionTraceStep[] }
> {
  const rules = params.completions ?? []
  const maxPasses = params.maxPasses ?? 6

  let instruction = params.ctx.instruction
  let rest = params.ctx.rest
  let vars: Record<string, string> = {}
  const executed = new Set<string>()
  const trace: CompletionTraceStep[] = []

  for (let pass = 0; pass < maxPasses; pass++) {
    const detected = detectArgs(rest, params.args)
    const available = { ...vars, ...detected }

    const rule = rules.find((r) => {
      if (executed.has(r.id)) return false
      if (r.when?.equals) {
        const v = available[r.when.equals.key]
        if (v !== r.when.equals.value) return false
      }
      const miss = computeMissingForRule(r, available)
      if (r.when?.always) return true
      if (!r.when?.missing?.length) return false
      return shouldRun(r, miss)
    })
    if (!rule) {
      const prefix = params.instructionWrapper?.prefix
      const suffix = params.instructionWrapper?.suffix
      const wrapped =
        (prefix ? prefix + '\n' : '') + instruction + (suffix ? '\n' + suffix : '')
      return { ok: true, instruction: wrapped.trim(), trace }
    }

    const result = await params.runAction(rule.do)
    if (result === null) return { ok: false, cancelled: true, trace }
    const exported = applyExportMap(result, (rule.do as any).export)
    vars = { ...vars, ...detected, ...exported }
    executed.add(rule.id)

    if (rule.inject) {
      const payload = renderTemplate(rule.inject.template, vars)
      if (rule.inject.into === 'instruction_prefix') instruction = payload + '\n' + instruction
      else if (rule.inject.into === 'instruction_suffix') instruction = instruction + '\n' + payload
      else instruction = payload
      trace.push({
        ruleId: rule.id,
        action: (rule.do as any).action ?? 'unknown',
        injected: { into: rule.inject.into, chars: payload.length },
      })
    } else {
      trace.push({
        ruleId: rule.id,
        action: (rule.do as any).action ?? 'unknown',
      })
    }

    // Update rest too, so subsequent detect/missing can see injected flags
    rest = instruction
  }

  return { ok: false, error: '参数补全循环次数过多（可能是规则配置导致）。', trace }
}

