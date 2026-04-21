import { BUILTIN_SKILL_MARKDOWN } from './builtinMarkdown'

const OVERRIDE_PREFIX = 'claweditor.skill.override.'

/** Strip leading YAML frontmatter (--- ... ---) and return markdown body for prompts. */
export function stripSkillFrontmatter(raw: string): string {
  const t = raw.trimStart()
  if (!t.startsWith('---')) return raw
  const end = t.indexOf('\n---', 3)
  if (end === -1) return raw
  const after = t.slice(end + 4)
  return after.replace(/^\r?\n/, '')
}

/**
 * Builtin and user override: `localStorage[claweditor.skill.override.<id>]` replaces bundled markdown.
 */
export function getSkillMarkdownBody(skillId: 'aiedit' | 'aiimport'): string {
  if (typeof localStorage !== 'undefined') {
    const o = localStorage.getItem(`${OVERRIDE_PREFIX}${skillId}`)
    if (o?.trim()) {
      return stripSkillFrontmatter(o)
    }
  }
  return stripSkillFrontmatter(BUILTIN_SKILL_MARKDOWN[skillId])
}
