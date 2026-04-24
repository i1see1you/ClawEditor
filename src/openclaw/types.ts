export type OpenClawAction = 'explain' | 'edit' | 'skill'

export interface OpenClawProposalPayload {
  kind: 'replace_whole_document'
  newText: string
  title?: string
  summary?: string
}
