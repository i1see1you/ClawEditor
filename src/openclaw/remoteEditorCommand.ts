/**
 * Remote `claweditor.command` payloads must match the Gateway bridge whitelist
 * (`integrations/openclaw-gateway` OpenClaw plugin, id `claweditor-gateway`).
 */
export const REMOTE_EDITOR_COMMAND_LINE_RE =
  /^\/(edit|aiedit|aicorrect|aiimport)\b/i

export function isRemoteEditorCommandLine(line: string): boolean {
  const t = line.trim()
  return t.length > 0 && REMOTE_EDITOR_COMMAND_LINE_RE.test(t)
}
