import type { ApiKeyAccessLevel, ApiKeyItem, ApiKeyScopeType, BillingConfigResponse, BillingInterval, CheckoutSessionResponse, CreatedApiKeyResponse, CustomerPortalResponse, FeedbackCreatePayload, FeedbackSubmissionResponse, Group, PricingPlanId, PricingResponse, PromptDuplicatePayload, PromptDuplicateResponse, PromptItem, PromptProposalItem, ProposalCommentItem, PromptVersionItem, SharedDiffPayload, User } from './types'

const TOKEN_KEY = 'prompt-vault-session'

// Public API gateway (Cloudflare Worker on the promptfolders.com zone).
export const GATEWAY_URL = 'https://api.promptfolders.com'

export function getBackendBaseUrl(): string {
  if (import.meta.env.VITE_API_BASE) return import.meta.env.VITE_API_BASE
  if (import.meta.env.VITE_API_BASE_URL) return import.meta.env.VITE_API_BASE_URL
  if (typeof window !== 'undefined') {
    if (window.location.hostname.includes('pages.dev')) {
      return GATEWAY_URL
    }
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    if (isLocalhost) {
      const port = import.meta.env.VITE_BACKEND_PORT || import.meta.env.BACKEND_PORT || '8002'
      return `${window.location.protocol}//${window.location.hostname}:${port}`
    }
    if (!window.location.hostname.includes('onrender.com') && !window.location.hostname.includes('workers.dev')) {
      return GATEWAY_URL
    }
    return window.location.origin
  }
  return GATEWAY_URL
}

export function getMcpUrl(): string {
  return `${getBackendBaseUrl()}/mcp`
}

export function getSseUrl(): string {
  return `${getBackendBaseUrl()}/sse/sse`
}

const API_BASE =
  import.meta.env.VITE_API_BASE ||
  import.meta.env.VITE_API_BASE_URL ||
  (typeof window !== 'undefined' && window.location.hostname.includes('pages.dev')
    ? GATEWAY_URL
    : '')
export const AUTH_EXPIRED_EVENT = 'prompt-vault-auth-expired'

export function getSessionToken() { return localStorage.getItem(TOKEN_KEY) ?? '' }
export function setSessionToken(token: string) { localStorage.setItem(TOKEN_KEY, token) }
export function clearSessionToken() { localStorage.removeItem(TOKEN_KEY) }

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const token = getSessionToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: init.credentials ?? 'include',
  })
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const body = await response.json() as { detail?: string | { msg?: string }[] }
      if (typeof body.detail === 'string') message = body.detail
      // Pydantic prefixes custom validator messages with "Value error, "; users don't need that.
      else if (Array.isArray(body.detail) && body.detail[0]?.msg) message = body.detail[0].msg.replace(/^Value error, /, '')
    } catch { /* response was not JSON */ }
    if (response.status === 401 && token && !path.startsWith('/api/auth/')) { clearSessionToken(); window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT)) }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

export type AuthResponse = { token: string; user: User }
export const login = (email: string, password: string) => api<AuthResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
export const register = (name: string, email: string, password: string, acceptTerms: boolean, marketingOptIn: boolean) =>
  api<AuthResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name, email, password, accept_terms: acceptTerms, marketing_opt_in: marketingOptIn }),
  })
export const verifyEmail = (token: string) =>
  api<{ verified: boolean; email: string }>('/api/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) })
export const resendVerification = () =>
  api<{ sent: boolean; already_verified?: boolean }>('/api/auth/resend-verification', { method: 'POST' })
export const forgotPassword = (email: string) =>
  api<{ sent: boolean; message: string }>('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) })
export const resetPassword = (token: string, newPassword: string) =>
  api<{ reset: boolean }>('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, new_password: newPassword }) })
export const updateMarketingPreference = (optIn: boolean) =>
  api<{ marketing_opt_in: boolean }>('/api/me/marketing', { method: 'PUT', body: JSON.stringify({ marketing_opt_in: optIn }) })
export const firebaseLogin = (id_token: string, display_name?: string) =>
  api<AuthResponse>('/api/auth/firebase', { method: 'POST', body: JSON.stringify({ id_token, display_name }) })
export async function logout() { try { await api('/api/auth/logout', { method: 'POST' }) } finally { clearSessionToken() } }
export async function logoutAllSessions() { try { await api('/api/auth/sessions', { method: 'DELETE' }) } finally { clearSessionToken() } }
export const getMe = () => api<User>('/api/me')
export const completeOnboarding = () => api<{ onboarding_completed: boolean }>('/api/me/onboarding', { method: 'POST' })
export const getUsers = () => api<User[]>('/api/users')
export const getGroups = () => api<Group[]>('/api/groups')
export const createGroup = (data: { name: string; description?: string; manager_user_id?: string | null }) =>
  api<{ id: string; name: string; description: string }>('/api/groups', { method: 'POST', body: JSON.stringify(data) })
export const getPrompts = async (search = ''): Promise<PromptItem[]> => {
  const items = await api<any[]>(`/api/prompts${search ? `?search=${encodeURIComponent(search)}` : ''}`)
  return (items || []).map((p): PromptItem => ({
    ...p,
    content: p.content ?? p.latest_version?.content ?? '',
    variables: Array.isArray(p.variables) ? p.variables : (p.latest_version?.variables ?? []),
  }))
}
export const createPrompt = (data: { group_id: string; title: string; description?: string; content: string; change_note?: string }) =>
  api<{ id: string; title: string; group_id: string; current_version_number: number; current_version_id?: string }>('/api/prompts', { method: 'POST', body: JSON.stringify(data) })
export const duplicatePrompt = (promptId: string, data: PromptDuplicatePayload) =>
  api<PromptDuplicateResponse>(`/api/prompts/${promptId}/duplicate`, { method: 'POST', body: JSON.stringify(data) })
export const getVersions = (id: string) => api<PromptVersionItem[]>(`/api/prompts/${id}/versions`)
export const getSharedDiff = (id: string) => api<SharedDiffPayload>(`/api/diff-shares/${id}`)

export const getAllProposals = (params?: { group_id?: string; status?: string }) => {
  const query = new URLSearchParams()
  if (params?.group_id) query.set('group_id', params.group_id)
  if (params?.status) query.set('status', params.status)
  const qs = query.toString()
  return api<PromptProposalItem[]>(`/api/proposals${qs ? `?${qs}` : ''}`)
}
export const getProposals = (promptId: string) => api<PromptProposalItem[]>(`/api/prompts/${promptId}/proposals`)
export const createProposal = (promptId: string, data: { title: string; description?: string; content: string; change_note: string }) =>
  api<{ id: string; status: string; message: string }>(`/api/prompts/${promptId}/proposals`, { method: 'POST', body: JSON.stringify(data) })
export const approveProposal = (proposalId: string, comment?: string) =>
  api<{ status: string; merged: boolean; approvals_count: number; required_approvals: number; version_number?: number }>(
    `/api/proposals/${proposalId}/approve`,
    { method: 'POST', body: comment !== undefined ? JSON.stringify({ comment }) : undefined }
  )
export const rejectProposal = (proposalId: string, comment?: string) =>
  api<{ status: string }>(
    `/api/proposals/${proposalId}/reject`,
    { method: 'POST', body: comment !== undefined ? JSON.stringify({ comment }) : undefined }
  )
export const addProposalComment = (proposalId: string, comment: string) =>
  api<ProposalCommentItem>(
    `/api/proposals/${proposalId}/comments`,
    { method: 'POST', body: JSON.stringify({ comment }) }
  )
export const updateGroupSettings = (groupId: string, data: { required_approvals?: number; allow_self_approval?: boolean }) =>
  api<{ group_id: string; required_approvals: number; allow_self_approval: boolean }>(
    `/api/groups/${groupId}/settings`,
    { method: 'PUT', body: JSON.stringify(data) }
  )

export const getApiKeys = () => api<ApiKeyItem[]>('/api/api-keys')
export const createApiKey = (data: { name: string; description: string; scope_type: ApiKeyScopeType; access_level?: ApiKeyAccessLevel; group_id?: string | null }) =>
  api<CreatedApiKeyResponse>('/api/api-keys', { method: 'POST', body: JSON.stringify(data) })
export const revokeApiKey = (keyId: string) =>
  api<{ revoked: boolean; id: string; name?: string }>(`/api/api-keys/${keyId}/revoke`, { method: 'POST' })
export const deleteApiKey = (keyId: string) =>
  api<{ deleted: boolean; id: string }>(`/api/api-keys/${keyId}`, { method: 'DELETE' })

export const submitFeedback = (data: FeedbackCreatePayload) =>
  api<FeedbackSubmissionResponse>('/api/feedback', { method: 'POST', body: JSON.stringify(data) })

export const getPricing = () => api<PricingResponse>('/api/pricing')
export const updatePlan = (plan: PricingPlanId) =>
  api<{ message: string; plan: PricingPlanId; user: User }>('/api/me/plan', { method: 'PATCH', body: JSON.stringify({ plan }) })

export const updateProfile = (data: { name: string }) =>
  api<{ id: string; name: string; email: string; is_workspace_admin: boolean; plan?: PricingPlanId }>('/api/me/profile', { method: 'PUT', body: JSON.stringify(data) })

export const changePassword = (data: { current_password: string; new_password: string }) =>
  api<{ message: string }>('/api/me/change-password', { method: 'POST', body: JSON.stringify(data) })

export const getBillingConfig = () => api<BillingConfigResponse>('/api/billing/config')
export const createBillingCheckout = (plan: PricingPlanId, interval: BillingInterval = 'month', seats = 1, successUrl?: string) =>
  api<CheckoutSessionResponse>('/api/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({ plan, billing_interval: interval, seats, success_url: successUrl }),
  })
export const openBillingPortal = () =>
  api<CustomerPortalResponse>('/api/billing/portal', { method: 'POST' })
