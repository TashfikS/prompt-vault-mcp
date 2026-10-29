/// <reference types="vite/client" />
import type { ApiKeyAccessLevel, ApiKeyItem, ApiKeyScopeType, CreatedApiKeyResponse, FeedbackCreatePayload, FeedbackSubmissionResponse, Group, PricingPlanId, PricingResponse, PromptDuplicatePayload, PromptDuplicateResponse, PromptItem, PromptProposalItem, PromptVersionItem, SharedDiffPayload, User } from './types'

const TOKEN_KEY = 'prompt-vault-session'
const API_BASE =
  import.meta.env.VITE_API_BASE ||
  import.meta.env.VITE_API_BASE_URL ||
  (typeof window !== 'undefined' && window.location.hostname.includes('pages.dev')
    ? 'https://prompt-vault-gateway.tashfiks.workers.dev'
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
      else if (Array.isArray(body.detail) && body.detail[0]?.msg) message = body.detail[0].msg
    } catch { /* response was not JSON */ }
    if (response.status === 401 && token && !path.startsWith('/api/auth/')) { clearSessionToken(); window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT)) }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

export type AuthResponse = { token: string; user: User }
export const login = (email: string, password: string) => api<AuthResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
export const register = (name: string, email: string, password: string, plan: PricingPlanId = 'community') => api<AuthResponse>('/api/auth/register', { method: 'POST', body: JSON.stringify({ name, email, password, plan }) })
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
export const approveProposal = (proposalId: string) =>
  api<{ status: string; merged: boolean; approvals_count: number; required_approvals: number; version_number?: number }>(`/api/proposals/${proposalId}/approve`, { method: 'POST' })
export const rejectProposal = (proposalId: string) =>
  api<{ status: string }>(`/api/proposals/${proposalId}/reject`, { method: 'POST' })
export const updateGroupSettings = (groupId: string, data: { required_approvals: number }) =>
  api<{ group_id: string; required_approvals: number }>(`/api/groups/${groupId}/settings`, { method: 'PUT', body: JSON.stringify(data) })

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
