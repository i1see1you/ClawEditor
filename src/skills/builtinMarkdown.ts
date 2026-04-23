const rawModules = import.meta.glob('../../skills/**/SKILL.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function idFromSkillPath(p: string): string {
  const parts = p.split('/').filter(Boolean)
  const idx = parts.lastIndexOf('skills')
  if (idx !== -1 && parts[idx + 2] === 'SKILL.md') return parts[idx + 1]!
  const base = parts[parts.length - 1] ?? 'unknown'
  return base.replace(/\.md$/i, '')
}

export const BUILTIN_SKILL_MARKDOWN: Record<string, string> = Object.fromEntries(
  Object.entries(rawModules).map(([path, raw]) => [idFromSkillPath(path), raw])
)
