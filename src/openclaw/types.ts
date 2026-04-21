export type OpenClawAction = 'explain' | 'format' | 'edit' | 'aiedit' | 'aiimport'

export interface OpenClawProposalPayload {
  kind: 'replace_whole_document'
  newText: string
  title?: string
  summary?: string
}
