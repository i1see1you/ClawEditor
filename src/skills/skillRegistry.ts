import { stripSkillFrontmatter } from './resolveSkill'

export type SkillKind = 'local_intent_four_op' | 'gateway_chat'

export type SkillMeta = {
  id: string
  name?: string
  description?: string
  kind: SkillKind
}

type SkillDef = SkillMeta & {
  markdownBody: string
  helpText: string | null
}

function idFromSkillPath(p: string): string {
  // "../../skills/<id>/SKILL.md"
  const parts = p.split('/').filter(Boolean)
  const idx = parts.lastIndexOf('skills')
  if (idx !== -1 && parts[idx + 2] === 'SKILL.md') return parts[idx + 1]!
  // fallback: file name without extension
  const base = parts[parts.length - 1] ?? 'unknown'
  return base.replace(/\.md$/i, '')
}

function parseFrontmatter(raw: string): Record<string, string> {
  const t = raw.trimStart()
  if (!t.startsWith('---')) return {}
  const end = t.indexOf('\n---', 3)
  if (end === -1) return {}
  const block = t.slice(3, end).trim()
  const out: Record<string, string> = {}
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/)
    if (!m) continue
    out[m[1]!] = m[2]!
  }
  return out
}

function extractHelp(markdownBody: string): string | null {
  const m = markdownBody.match(/```help\s*\r?\n([\s\S]*?)\r?\n```/i)
  return (m?.[1] ?? '').trim() || null
}

function normalizeKind(v: string | undefined): SkillKind {
  const s = (v ?? '').trim().toLowerCase()
  if (s === 'local_intent_four_op' || s === 'local-intent-four-op') return 'local_intent_four_op'
  if (s === 'gateway_chat' || s === 'gateway-chat') return 'gateway_chat'
  // default: keep safe, local deterministic apply is only for explicitly opted-in skills
  return 'gateway_chat'
}

const rawModules = import.meta.glob('../../skills/**/SKILL.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const defs = new Map<string, SkillDef>()

for (const [path, raw] of Object.entries(rawModules)) {
  const id = idFromSkillPath(path)
  const fm = parseFrontmatter(raw)
  const markdownBody = stripSkillFrontmatter(raw)
  const kind = normalizeKind(fm.kind)
  const helpText = extractHelp(markdownBody)
  defs.set(id, {
    id,
    name: fm.name,
    description: fm.description,
    kind,
    markdownBody,
    helpText,
  })
}

export function getAllSkillMetas(): SkillMeta[] {
  return Array.from(defs.values()).map(({ markdownBody: _m, helpText: _h, ...meta }) => meta)
}

export function hasSkill(skillId: string): boolean {
  return defs.has(skillId)
}

export function getSkillDef(skillId: string): SkillDef | null {
  return defs.get(skillId) ?? null
}

export function getSkillMarkdownBodyById(skillId: string): string | null {
  return defs.get(skillId)?.markdownBody ?? null
}

export function getSkillHelpText(skillId: string): string | null {
  return defs.get(skillId)?.helpText ?? null
}

