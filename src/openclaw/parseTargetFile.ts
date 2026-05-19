/**
 * Parse `--file <basename>` from editor / Channel edit commands.
 * Keep in sync with `integrations/openclaw-gateway/index.js` (`parseTargetFile`).
 */
export function parseTargetFile(line: string): { line: string; targetFile?: string } {
  const m = line.match(/\s--file\s+(\S+)/)
  if (!m) return { line }
  return {
    line: line.replace(m[0], '').replace(/\s+/g, ' ').trim(),
    targetFile: m[1],
  }
}

export type OpenFileLike = {
  id: string
  name: string
  path?: string
  isPdf?: boolean
  content?: string | Uint8Array
}

export function findOpenFileByBasename(
  files: OpenFileLike[],
  targetFile: string
): OpenFileLike | undefined {
  const target = targetFile.trim().toLowerCase()
  if (!target) return undefined
  return files.find((f) => f.name.toLowerCase() === target)
}

export function isAgentEditableFile(file: OpenFileLike | undefined): file is OpenFileLike & {
  path: string
  content: string
} {
  return Boolean(
    file && !file.isPdf && typeof file.content === 'string' && typeof file.path === 'string' && file.path
  )
}
