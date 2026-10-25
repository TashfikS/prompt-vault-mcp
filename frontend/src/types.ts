export type GroupRole = 'GROUP_MANAGER' | 'MEMBER' | 'GUEST'
export type PricingPlanId = 'community' | 'pro' | 'team' | 'enterprise'
export type User = {
  id: string
  name: string
  email: string
  is_workspace_admin: boolean
  plan?: PricingPlanId
  api_key?: string
  onboarding_completed?: boolean
  groups?: Array<{ id: string; name: string; role: GroupRole; is_personal: boolean }>
}
export type PricingTier = {
  id: PricingPlanId
  name: string
  tagline: string
  badge?: string
  price_monthly: number | null
  price_annual: number | null
  price_label: string
  max_prompts: number
  max_versions_per_prompt: number
  max_groups: number
  free_guests_per_editor: number
  mcp_monthly_calls: number
  storage_type: string
  features: string[]
}
export type PricingResponse = {
  tiers: PricingTier[]
  current_plan: PricingPlanId
  usage?: {
    prompts_count: number
    max_prompts: number
  } | null
}
export type GroupMember = { user_id: string; name: string; email: string; role: GroupRole; added_at?: string }
export type Group = {
  id: string
  name: string
  description: string
  is_personal?: boolean
  required_approvals?: number
  members: GroupMember[]
}
export type PromptVersionItem = {
  id: string; prompt_id: string; version_number: number; content: string; variables: string[]
  change_note: string; source_filename?: string | null; author_id?: string | null; author_name: string; created_at: string
}
export type PromptItem = {
  id: string; group_id: string; group_name: string; title: string; description: string
  current_version_number: number; current_version_id?: string | null; updated_at: string; content: string; variables: string[]; version_count: number
}
export type PromptDuplicatePayload = {
  target_group_id: string
  title?: string
  mode?: 'copy' | 'move'
}
export type PromptDuplicateResponse = {
  id: string
  title: string
  group_id: string
  group_name: string
  current_version_number: number
  mode: 'copy' | 'move'
  message: string
}
export type SharedDiffPayload = {
  share_id: string; prompt: Pick<PromptItem, 'id' | 'title' | 'group_id' | 'group_name'>
  base_version: PromptVersionItem; target_version: PromptVersionItem
  diff_granularity: 'word' | 'sentence'; view_mode: 'split' | 'inline'
  expires_at?: string | null
}
export type ProposalApprovalItem = {
  id: string
  user_id: string
  user_name: string
  created_at: string
}
export type PromptProposalItem = {
  id: string
  prompt_id: string
  group_id: string
  proposer_id: string
  proposer_name: string
  proposer_email: string
  title: string
  description: string
  content: string
  change_note: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  created_at: string
  approvals: ProposalApprovalItem[]
  approvals_count: number
  required_approvals: number
  can_approve: boolean
  has_approved: boolean
  prompt_title?: string
  group_name?: string
  current_version_number?: number
  current_content?: string
}

export type ApiKeyScopeType = 'GLOBAL' | 'GROUP'
export type ApiKeyAccessLevel = 'READ_ONLY' | 'READ_WRITE'

export type ApiKeyItem = {
  id: string
  name: string
  description: string
  key_prefix: string
  scope_type: ApiKeyScopeType
  access_level?: ApiKeyAccessLevel
  group_id: string | null
  group_name: string
  is_personal_group: boolean
  is_active: boolean
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export type CreatedApiKeyResponse = ApiKeyItem & {
  raw_key: string
}

export type FeedbackCategory = 'COMPLAINT' | 'BUG' | 'FEATURE_REQUEST' | 'CONTACT'

export type FeedbackCreatePayload = {
  category: FeedbackCategory
  subject: string
  message: string
  contact_name?: string
  contact_email?: string
  page_url?: string
}

export type FeedbackSubmissionResponse = {
  id: string
  category: FeedbackCategory
  subject: string
  status: string
  github_issue_created: boolean
  github_issue_number?: number | null
  github_issue_url?: string | null
  created_at: string
  message: string
}
