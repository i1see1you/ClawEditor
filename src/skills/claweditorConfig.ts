import { getSkillMarkdownBody } from './resolveSkill'

export type CompletionAction =
  | {
      action: 'pick_file'
      ui?: { title?: string }
      export?: Record<string, string>
      acceptExt?: string[]
      maxBytes?: number
    }
  | {
      action: 'clipboard_read'
      ui?: { title?: string }
      export?: Record<string, string>
      maxChars?: number
    }
  | {
      action: 'prompt_user'
      ui?: { title?: string; placeholder?: string }
      export?: Record<string, string>
    }
  | {
      action: 'one_select'
      ui?: { title?: string }
      export?: Record<string, string>
      options?: { id: string; label: string }[]
    }

export type CompletionRule = {
  id: string
  when?: {
    missing?: string[]
    always?: boolean
    equals?: { key: string; value: string }
  }
  do: CompletionAction
  inject?: {
    into: 'instruction_prefix' | 'instruction_suffix' | 'instruction_replace'
    template: string
  }
}

export type ArgsSpec = Record<
  string,
  {
    required?: boolean
    detect?: { anyOf?: { regex: string }[] }
  }
>

type ClawEditorConfig = {
  version: 1
  args?: ArgsSpec
  completions?: CompletionRule[]
  instructionWrapper?: {
    prefix?: string
    suffix?: string
  }
}

function extractClaweditorConfigBlock(markdown: string): string | null {
  // ```claweditor\n{...}\n```
  const m = markdown.match(/```claweditor\s*\r?\n([\s\S]*?)\r?\n```/i)
  return m?.[1]?.trim() ?? null
}

export function getClaweditorConfigForSkill(
  skillId: 'aiedit' | 'aiimport'
): ClawEditorConfig | null {
  const body = getSkillMarkdownBody(skillId)
  const raw = extractClaweditorConfigBlock(body)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const cfg = parsed as Partial<ClawEditorConfig>
    if (cfg.version !== 1) return null
    return cfg as ClawEditorConfig
  } catch {
    return null
  }
}

export function validateClaweditorConfig(cfg: ClawEditorConfig): {
  ok: true
  warnings: string[]
} | { ok: false; errors: string[]; warnings: string[] } {
  const warnings: string[] = []
  const errors: string[] = []
  if (cfg.version !== 1) errors.push(`version 必须为 1（当前为 ${String(cfg.version)}）`)
  if (cfg.completions) {
    const seen = new Set<string>()
    for (const [i, r] of cfg.completions.entries()) {
      if (!r.id) errors.push(`completions[${i}].id 不能为空`)
      else if (seen.has(r.id)) errors.push(`completions[${i}].id 重复: ${r.id}`)
      else seen.add(r.id)
      if (!r.do || typeof (r.do as any).action !== 'string') {
        errors.push(`completions[${i}] 缺少 do.action`)
      }
      if (r.inject) {
        const into = r.inject.into
        if (!['instruction_prefix', 'instruction_suffix', 'instruction_replace'].includes(into)) {
          errors.push(`completions[${i}].inject.into 无效: ${String(into)}`)
        }
        if (typeof r.inject.template !== 'string' || !r.inject.template.trim()) {
          errors.push(`completions[${i}].inject.template 不能为空`)
        }
      }
      if (r.when?.missing && !Array.isArray(r.when.missing)) {
        errors.push(`completions[${i}].when.missing 必须是数组`)
      }
      if (r.when?.equals) {
        if (!r.when.equals.key || !r.when.equals.value) {
          errors.push(`completions[${i}].when.equals 需要 key/value`)
        }
      }
    }
  } else {
    warnings.push('未配置 completions（不会触发参数补全）。')
  }
  if (errors.length) return { ok: false, errors, warnings }
  return { ok: true, warnings }
}

