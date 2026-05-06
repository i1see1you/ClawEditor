import { getAllSkillMetas, type SkillMeta } from '../skills/skillRegistry'

export type BuiltinCommandId = 'edit' | 'find'

export type Command =
  | {
      kind: 'builtin'
      id: BuiltinCommandId
      label: string
      description: string
      insertFromSlash: string
    }
  | {
      kind: 'skill'
      id: string
      label: string
      description: string
      insertFromSlash: string
      skill: SkillMeta
    }

const BUILTINS: Command[] = [
  {
    kind: 'builtin',
    id: 'edit',
    label: '/edit',
    description: '本地子命令；无法解析时可走 Gateway',
    insertFromSlash: '/edit ',
  },
  {
    kind: 'builtin',
    id: 'find',
    label: '/find',
    description: '查找（字面/正则）；多词可走 Gateway',
    insertFromSlash: '/find ',
  },
]

export function getAllCommands(): Command[] {
  const skills = getAllSkillMetas().map((s) => ({
    kind: 'skill' as const,
    id: s.id,
    label: `/${s.id}`,
    description: s.description || `来自 skills/${s.id}/SKILL.md`,
    insertFromSlash: `/${s.id} `,
    skill: s,
  }))
  return [...skills, ...BUILTINS]
}

/** A short hint string suitable for the agent input placeholder. */
export function getCommandHintText(maxSkills = 2): string {
  const skills = getAllSkillMetas()
    .slice(0, Math.max(0, maxSkills))
    .map((s) => `/${s.id}`)
  const tail = skills.length ? `${skills.join('、')}、/edit …、/find …` : '/edit …、/find …'
  return `输入 / 查看命令 · 自然语言或 ${tail}`
}

