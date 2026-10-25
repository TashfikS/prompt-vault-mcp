import { useCallback, useEffect, useState } from 'react'
import {
  Bot,
  Check,
  Copy,
  Globe,
  KeyRound,
  LockKeyhole,
  MessageSquare,
  PlugZap,
  Plus,
  Sparkles,
  Terminal,
  Users,
} from 'lucide-react'
import { createApiKey, getApiKeys, revokeApiKey } from '../api'
import type { ApiKeyAccessLevel, ApiKeyItem, ApiKeyScopeType, CreatedApiKeyResponse, Group, User } from '../types'
import GroupSelectDropdown from './GroupSelectDropdown'
import Modal from './ui/Modal'
import { useToast } from './ui/Toast'

type ProviderId = 'desktop' | 'web' | 'cli' | 'code'

function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'Never used'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Never used'
  const diffSec = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
  if (diffSec < 60) return 'Used just now'
  if (diffSec < 3600) return `Used ${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `Used ${Math.floor(diffSec / 3600)}h ago`
  if (diffSec < 86400 * 30) return `Used ${Math.floor(diffSec / 86400)}d ago`
  return `Used ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

function ScopePill({ item }: { item: Pick<ApiKeyItem, 'scope_type' | 'group_name' | 'is_personal_group'> }) {
  if (item.scope_type === 'GLOBAL') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 dark:bg-zinc-800 dark:text-zinc-300">
        <Globe size={11} className="text-slate-500 dark:text-zinc-400" aria-hidden />
        All spaces
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-800 dark:bg-brand-950/60 dark:text-brand-300">
      {item.is_personal_group ? (
        <LockKeyhole size={11} className="text-brand-600 dark:text-brand-400" aria-hidden />
      ) : (
        <Users size={11} className="text-brand-600 dark:text-brand-400" aria-hidden />
      )}
      {item.is_personal_group ? 'Personal' : item.group_name}
    </span>
  )
}

export default function ConnectAiModal({
  groups,
  onClose,
}: {
  activeUser?: User | null
  groups: Group[]
  onClose: () => void
}) {
  const toast = useToast()
  const [provider, setProvider] = useState<ProviderId>('desktop')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Keys state
  const [keys, setKeys] = useState<ApiKeyItem[]>([])
  const [loadingKeys, setLoadingKeys] = useState(true)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [creatingKey, setCreatingKey] = useState(false)

  // Create key form state
  const [keyName, setKeyName] = useState('')
  const [scopeType, setScopeType] = useState<ApiKeyScopeType>('GLOBAL')
  const [accessLevel, setAccessLevel] = useState<ApiKeyAccessLevel>('READ_WRITE')
  const [selectedGroupId, setSelectedGroupId] = useState<string>(() => groups[0]?.id ?? '')
  const [formError, setFormError] = useState('')

  // Newly created key (shown once)
  const [newKey, setNewKey] = useState<CreatedApiKeyResponse | null>(null)

  // Inline confirmation state
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null)
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null)

  const baseOrigin = window.location.origin.replace(':5173', `:${import.meta.env.VITE_BACKEND_PORT || '8002'}`)
  const mcpUrl = `${baseOrigin}/mcp`
  const restUrl = `${baseOrigin}/api`
  const snippetKey = newKey?.raw_key ?? 'YOUR_API_KEY'

  const loadKeys = useCallback(async () => {
    setLoadingKeys(true)
    try {
      const list = await getApiKeys()
      setKeys(list)
      if (list.filter(k => k.is_active).length === 0) {
        setShowCreateForm(true)
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load API keys', { tone: 'error' })
    } finally {
      setLoadingKeys(false)
    }
  }, [toast])

  useEffect(() => {
    void loadKeys()
  }, [loadKeys])

  useEffect(() => {
    if (!selectedGroupId && groups.length > 0) {
      setSelectedGroupId(groups[0].id)
    }
  }, [groups, selectedGroupId])

  async function copy(value: string, id: string, label?: string) {
    await navigator.clipboard.writeText(value)
    setCopiedId(id)
    if (label) toast(label, { tone: 'success' })
    window.setTimeout(() => setCopiedId(prev => (prev === id ? null : prev)), 2000)
  }

  async function handleGenerateKey(e: React.FormEvent) {
    e.preventDefault()
    setFormError('')
    const trimmedName = keyName.trim()
    if (!trimmedName) {
      setFormError('Give this key a short name (for example, Desktop Assistant).')
      return
    }
    if (scopeType === 'GROUP' && !selectedGroupId) {
      setFormError('Choose which space this key can access.')
      return
    }
    setCreatingKey(true)
    try {
      const created = await createApiKey({
        name: trimmedName,
        description: '',
        scope_type: scopeType,
        access_level: accessLevel,
        group_id: scopeType === 'GROUP' ? selectedGroupId : null,
      })
      setNewKey(created)
      setKeys(prev => [created, ...prev])
      setKeyName('')
      setScopeType('GLOBAL')
      setAccessLevel('READ_WRITE')
      setShowCreateForm(false)
      toast('API key created — copy it now', { tone: 'success' })
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not create API key.')
    } finally {
      setCreatingKey(false)
    }
  }

  async function handleRevoke(id: string) {
    setBusyKeyId(id)
    try {
      const target = keys.find(item => item.id === id)
      await revokeApiKey(id)
      setKeys(prev => prev.filter(item => item.id !== id))
      if (newKey?.id === id) setNewKey(null)
      setConfirmRevokeId(null)
      toast(`Revoked "${target?.name ?? 'API key'}"`, { tone: 'info' })
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not revoke key.', { tone: 'error' })
    } finally {
      setBusyKeyId(null)
    }
  }

  const activeKeys = keys.filter(k => k.is_active)

  const snippets: Record<ProviderId, { title: string; steps: string[]; label: string; code: string }> = {
    desktop: {
      title: 'Desktop MCP Client',
      steps: [
        'In your desktop MCP client, open Settings → Integrations or add the server configuration below to your config file.',
        'Provide your personal API key when asking your assistant to find, fill in, or save a prompt.',
      ],
      label: 'mcp_servers_config.json',
      code: JSON.stringify({ mcpServers: { 'prompthold': { url: mcpUrl } } }, null, 2),
    },
    web: {
      title: 'Web Chat Connectors',
      steps: [
        'In your AI chat workspace settings, add a custom connector or external tool.',
        'Paste the MCP Server URL below and provide your API key when using PromptHold in chat.',
      ],
      label: 'MCP Server URL',
      code: mcpUrl,
    },
    cli: {
      title: 'CLI & Terminal Tools',
      steps: [
        'Add the configuration snippet below to your terminal tool or client settings file.',
        'Pass your API key when listing, interpolating, or updating your prompts.',
      ],
      label: 'mcp_config.json',
      code: JSON.stringify({ mcpServers: { 'prompthold': { httpUrl: mcpUrl } } }, null, 2),
    },
    code: {
      title: 'REST API & Custom Agents',
      steps: [
        'Pass your API key in the Authorization: Bearer header.',
        'Fetch or update prompts from any script, autonomous agent, or pipeline.',
      ],
      label: 'Example request (cURL)',
      code: `curl "${restUrl}/prompts" \\\n  -H "Authorization: Bearer ${snippetKey}"`,
    },
  }

  const activeGuide = snippets[provider]

  return (
    <Modal
      title="Connect to AI"
      description="Connect your prompts directly to your AI assistants, MCP clients, or automated workflows."
      icon={<PlugZap size={18} />}
      size="lg"
      onClose={onClose}
      footer={
        <button type="button" onClick={onClose} className="btn-primary" data-autofocus>
          Done
        </button>
      }
    >
      <div className="max-h-[72vh] space-y-6 overflow-y-auto pr-1 custom-scrollbar">
        {/* STEP 1: API KEYS */}
        <section aria-labelledby="connect-keys-heading" className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 id="connect-keys-heading" className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
                1. Your API keys
              </h3>
              <p className="text-xs text-slate-500 dark:text-zinc-400">
                Create a key for all your spaces or limit it to a single group.
              </p>
            </div>
            {!showCreateForm && (
              <button
                type="button"
                onClick={() => {
                  setFormError('')
                  setShowCreateForm(true)
                }}
                className="btn-secondary btn-sm"
              >
                <Plus size={14} />
                <span>New key</span>
              </button>
            )}
          </div>

          {/* One-time reveal banner when a key is just created */}
          {newKey && (
            <div
              role="region"
              aria-label="New API key"
              className="animate-pop-in rounded-xl border border-brand-300 bg-brand-50/70 p-3.5 dark:border-brand-900/60 dark:bg-brand-950/30"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-medium text-brand-900 dark:text-brand-200">
                  <KeyRound size={14} className="text-brand-700 dark:text-brand-400" aria-hidden />
                  <span>
                    Save your key for <strong>{newKey.name}</strong> — it’s only shown once.
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setNewKey(null)}
                  className="text-xs font-medium text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                >
                  Dismiss
                </button>
              </div>
              <div className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-center">
                <code
                  className="min-w-0 flex-1 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 font-mono text-xs text-emerald-300 select-all dark:border-zinc-800 dark:bg-black dark:text-emerald-400"
                  style={{ overflowWrap: 'anywhere' }}
                >
                  {newKey.raw_key}
                </code>
                <button
                  type="button"
                  onClick={() => void copy(newKey.raw_key, 'new-key', 'API key copied')}
                  className="btn-primary btn-sm shrink-0"
                >
                  {copiedId === 'new-key' ? <Check size={14} /> : <Copy size={14} />}
                  <span>{copiedId === 'new-key' ? 'Copied' : 'Copy key'}</span>
                </button>
              </div>
            </div>
          )}

          {/* Compact Create Key Form */}
          {showCreateForm && (
            <form
              onSubmit={e => void handleGenerateKey(e)}
              className="animate-pop-in space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 dark:border-zinc-800 dark:bg-zinc-950/40"
            >
              <div className="grid gap-3 sm:grid-cols-[1fr,auto,auto]">
                <div>
                  <label htmlFor="api-key-name" className="field-label text-xs">
                    Key name
                  </label>
                  <input
                    id="api-key-name"
                    value={keyName}
                    onChange={e => setKeyName(e.target.value)}
                    placeholder="e.g. Desktop Assistant, Marketing Bot"
                    maxLength={120}
                    className="field bg-white dark:bg-zinc-900"
                  />
                </div>

                <div>
                  <span className="field-label text-xs">Access</span>
                  <div className="segmented h-[38px] bg-white dark:bg-zinc-900">
                    <button
                      type="button"
                      onClick={() => setScopeType('GLOBAL')}
                      className={`segmented-item text-xs ${scopeType === 'GLOBAL' ? 'segmented-item-active' : ''}`}
                    >
                      All spaces
                    </button>
                    <button
                      type="button"
                      onClick={() => setScopeType('GROUP')}
                      className={`segmented-item text-xs ${scopeType === 'GROUP' ? 'segmented-item-active' : ''}`}
                    >
                      One space
                    </button>
                  </div>
                </div>

                <div>
                  <span className="field-label text-xs">Permissions</span>
                  <div className="segmented h-[38px] bg-white dark:bg-zinc-900">
                    <button
                      type="button"
                      onClick={() => setAccessLevel('READ_WRITE')}
                      className={`segmented-item text-xs ${accessLevel === 'READ_WRITE' ? 'segmented-item-active' : ''}`}
                    >
                      Read &amp; write
                    </button>
                    <button
                      type="button"
                      onClick={() => setAccessLevel('READ_ONLY')}
                      className={`segmented-item text-xs ${accessLevel === 'READ_ONLY' ? 'segmented-item-active' : ''}`}
                    >
                      Read-only
                    </button>
                  </div>
                </div>
              </div>

              {scopeType === 'GROUP' && (
                <div>
                  <label className="field-label text-xs">Space</label>
                  <GroupSelectDropdown
                    groups={groups}
                    value={selectedGroupId}
                    onChange={setSelectedGroupId}
                  />
                </div>
              )}

              {formError && (
                <p role="alert" className="text-xs font-medium text-rose-700 dark:text-rose-400">
                  {formError}
                </p>
              )}

              <div className="flex items-center justify-end gap-2">
                {keys.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowCreateForm(false)}
                    disabled={creatingKey}
                    className="btn-ghost btn-sm"
                  >
                    Cancel
                  </button>
                )}
                <button type="submit" disabled={creatingKey} className="btn-primary btn-sm">
                  <KeyRound size={14} />
                  <span>{creatingKey ? 'Creating…' : 'Create key'}</span>
                </button>
              </div>
            </form>
          )}

          {/* Active Keys List */}
          {loadingKeys ? (
            <p className="py-3 text-xs text-slate-400 dark:text-zinc-500">Loading keys…</p>
          ) : activeKeys.length === 0 ? (
            !showCreateForm && (
              <p className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-500 dark:border-zinc-800 dark:text-zinc-400">
                No active keys yet. Create one above to connect an AI tool.
              </p>
            )
          ) : (
            <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
              {activeKeys.map(item => {
                const isConfirming = confirmRevokeId === item.id
                const isBusy = busyKeyId === item.id
                const isReadOnly = item.access_level === 'READ_ONLY'
                return (
                  <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-sm">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-900 dark:text-zinc-100">{item.name}</span>
                      <ScopePill item={item} />
                      <span
                        className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ${
                          isReadOnly
                            ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
                            : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                        }`}
                      >
                        {isReadOnly ? 'Read-only' : 'Read & write'}
                      </span>
                      <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-500 dark:bg-zinc-800 dark:text-zinc-400">
                        {item.key_prefix}
                      </code>
                      <span className="text-xs text-slate-400 dark:text-zinc-500">· {formatRelativeTime(item.last_used_at)}</span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      {isConfirming ? (
                        <>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleRevoke(item.id)}
                            className="rounded-md bg-rose-600 px-2 py-1 text-xs font-medium text-white hover:bg-rose-700"
                          >
                            {isBusy ? 'Revoking…' : 'Confirm'}
                          </button>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => setConfirmRevokeId(null)}
                            className="rounded-md px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmRevokeId(item.id)}
                          className="text-xs font-medium text-slate-400 transition hover:text-rose-600 dark:text-zinc-500 dark:hover:text-rose-400"
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        {/* STEP 2: SETUP GUIDE */}
        <section aria-labelledby="connect-setup-heading" className="space-y-3 border-t border-slate-100 pt-5 dark:border-zinc-800">
          <div>
            <h3 id="connect-setup-heading" className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
              2. Connect your AI tool
            </h3>
            <p className="text-xs text-slate-500 dark:text-zinc-400">
              Pick the tool you use to get the connection URL or config.
            </p>
          </div>

          <div role="tablist" aria-label="AI tools" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(
              [
                { id: 'desktop', label: 'Desktop App', icon: Sparkles },
                { id: 'web', label: 'Web Connector', icon: MessageSquare },
                { id: 'cli', label: 'CLI Tools', icon: Bot },
                { id: 'code', label: 'API / Code', icon: Terminal },
              ] as const
            ).map(item => {
              const Icon = item.icon
              const active = provider === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setProvider(item.id)}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-xs font-medium transition ${
                    active
                      ? 'border-brand-600 bg-brand-50/50 text-slate-900 ring-2 ring-brand-600/15 dark:border-brand-500 dark:bg-brand-950/40 dark:text-zinc-100'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-200'
                  }`}
                >
                  <Icon size={15} className={active ? 'text-brand-700 dark:text-brand-400' : 'text-slate-400 dark:text-zinc-500'} aria-hidden />
                  <span>{item.label}</span>
                </button>
              )
            })}
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 space-y-3 dark:border-zinc-800 dark:bg-zinc-950/40">
            <ol className="space-y-1.5 text-xs leading-5 text-slate-600 dark:text-zinc-300">
              {activeGuide.steps.map((step, idx) => (
                <li key={idx} className="flex gap-2">
                  <span className="font-semibold text-slate-800 dark:text-zinc-200">{idx + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-medium text-slate-600 dark:text-zinc-300">{activeGuide.label}</span>
                <button
                  type="button"
                  onClick={() => void copy(activeGuide.code, `guide-${provider}`, 'Copied to clipboard')}
                  className="btn-ghost btn-sm h-7 px-2 text-xs"
                >
                  {copiedId === `guide-${provider}` ? <Check size={13} className="text-brand-600 dark:text-brand-400" /> : <Copy size={13} />}
                  <span>{copiedId === `guide-${provider}` ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              <pre className="overflow-x-auto rounded-lg bg-slate-900 px-3.5 py-2.5 font-mono text-xs leading-relaxed text-slate-100 custom-scrollbar dark:border dark:border-zinc-800 dark:bg-black dark:text-zinc-200">
                <code>{activeGuide.code}</code>
              </pre>
            </div>
          </div>
        </section>
      </div>
    </Modal>
  )
}
