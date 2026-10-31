import { useCallback, useEffect, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  LockKeyhole,
  PlugZap,
  Plus,
  ShieldCheck,
  Sparkles,
  Terminal,
  Users,
} from 'lucide-react'
import { createApiKey, getApiKeys, getBackendBaseUrl, getMcpUrl, getSseUrl, revokeApiKey } from '../api'
import type { ApiKeyAccessLevel, ApiKeyItem, ApiKeyScopeType, CreatedApiKeyResponse, Group, User } from '../types'
import GroupSelectDropdown from './GroupSelectDropdown'
import Modal from './ui/Modal'
import { useToast } from './ui/Toast'

export type ProviderId = 'claude' | 'chatgpt' | 'gemini' | 'cursor' | 'api'

function ClaudeIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 2c.69 0 1.25.56 1.25 1.25v4.06l2.87-2.87a1.25 1.25 0 0 1 1.77 1.77l-2.87 2.87h4.06c.69 0 1.25.56 1.25 1.25s-.56 1.25-1.25 1.25h-4.06l2.87 2.87a1.25 1.25 0 0 1-1.77 1.77l-2.87-2.87v4.06c0 .69-.56 1.25-1.25 1.25s-1.25-.56-1.25-1.25v-4.06l-2.87 2.87a1.25 1.25 0 0 1-1.77-1.77l2.87-2.87H3.92c-.69 0-1.25-.56-1.25-1.25s.56-1.25 1.25-1.25h4.06l-2.87-2.87a1.25 1.25 0 0 1 1.77-1.77l2.87 2.87V3.25C10.75 2.56 11.31 2 12 2z" />
    </svg>
  )
}

function ChatGptIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M22.28 9.82a5.98 5.98 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9 6.07 6.07 0 0 0-4.27 2.17 5.98 5.98 0 0 0-4 2.9 6.05 6.05 0 0 0 .74 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.51 2.9 5.98 5.98 0 0 0 4.27-2.17 6.06 6.06 0 0 0 4-2.9 6.06 6.06 0 0 0-.73-7.1zm-9.02 12.61a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76c.24-.14.39-.4.39-.68v-6.74l2.02 1.17c.02.01.04.03.04.05v5.59a4.5 4.5 0 0 1-4.49 4.49zm-9.66-4.13a4.47 4.47 0 0 1-.53-3.01l.14.08 4.78 2.76c.24.14.54.14.78 0l5.84-3.37v2.33c0 .03-.01.05-.03.06l-4.84 2.79a4.5 4.5 0 0 1-6.14-1.64zM2.34 7.9a4.49 4.49 0 0 1 2.37-1.98v5.68c0 .28.15.54.39.68l5.81 3.35-2.02 1.17c-.02.01-.05.01-.07 0l-4.83-2.79A4.5 4.5 0 0 1 2.34 7.9zm16.1 3.85-5.84-3.37 2.02-1.16c.02-.01.05-.01.07 0l4.83 2.79a4.49 4.49 0 0 1-.68 8.1v-5.68a.8.8 0 0 0-.4-.68zm2.01-3.02-.14-.09-4.77-2.78a.78.78 0 0 0-.79 0L9.41 9.23V6.9a.07.07 0 0 1 .03-.06l4.83-2.79a4.5 4.5 0 0 1 6.68 4.66zM8.31 12.86l-2.02-1.16a.08.08 0 0 1-.04-.06V6.07a4.5 4.5 0 0 1 7.38-3.45l-.14.08-4.78 2.76a.8.8 0 0 0-.4.68zm1.1-2.36 2.6-1.5 2.61 1.5v3l-2.61 1.5-2.6-1.5z" />
    </svg>
  )
}

function GeminiIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 24c0-6.627-5.373-12-12-12 6.627 0 12-5.373 12-12 0 6.627 5.373 12 12 12-6.627 0-12 5.373-12 12z" />
    </svg>
  )
}

function CursorIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M11.23 2.12a1.5 1.5 0 0 1 1.54 0l8.25 4.76a1.5 1.5 0 0 1 .75 1.3v9.52a1.5 1.5 0 0 1-.75 1.3l-8.25 4.76a1.5 1.5 0 0 1-1.54 0l-8.25-4.76a1.5 1.5 0 0 1-.75-1.3V8.18a1.5 1.5 0 0 1 .75-1.3l8.25-4.76zM12 3.86L4.5 8.19l7.5 4.33 7.5-4.33L12 3.86zM3.75 9.7v7.58l7.5 4.33v-7.58L3.75 9.7zm16.5 0l-7.5 4.33v7.58l7.5-4.33V9.7z" />
    </svg>
  )
}

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
        <Globe size={11} className="text-slate-500 dark:text-zinc-400" aria-hidden="true" />
        All spaces
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-800 dark:bg-brand-950/60 dark:text-brand-300">
      {item.is_personal_group ? (
        <LockKeyhole size={11} className="text-brand-600 dark:text-brand-400" aria-hidden="true" />
      ) : (
        <Users size={11} className="text-brand-600 dark:text-brand-400" aria-hidden="true" />
      )}
      {item.is_personal_group ? 'Personal' : item.group_name}
    </span>
  )
}

interface ProviderTab {
  id: ProviderId
  name: string
  subtitle: string
  authBadge: string
  Icon: (props: { className?: string }) => JSX.Element
  iconColor: string
  activeRing: string
  activeBg: string
}

const PROVIDERS: ProviderTab[] = [
  {
    id: 'claude',
    name: 'Claude',
    subtitle: 'Desktop & Web',
    authBadge: '⚡ OAuth sign-in',
    Icon: ClaudeIcon,
    iconColor: 'text-amber-600 dark:text-amber-400',
    activeRing: 'border-amber-500 ring-2 ring-amber-500/20 dark:border-amber-400',
    activeBg: 'bg-amber-50/80 dark:bg-amber-950/40 text-slate-900 dark:text-zinc-100',
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    subtitle: 'Web, Mobile & Desktop',
    authBadge: '⚡ OAuth sign-in',
    Icon: ChatGptIcon,
    iconColor: 'text-emerald-600 dark:text-emerald-400',
    activeRing: 'border-emerald-500 ring-2 ring-emerald-500/20 dark:border-emerald-400',
    activeBg: 'bg-emerald-50/80 dark:bg-emerald-950/40 text-slate-900 dark:text-zinc-100',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    subtitle: 'Web, Mobile App & SDK',
    authBadge: '⚡ OAuth sign-in',
    Icon: GeminiIcon,
    iconColor: 'text-indigo-600 dark:text-indigo-400',
    activeRing: 'border-indigo-500 ring-2 ring-indigo-500/20 dark:border-indigo-400',
    activeBg: 'bg-indigo-50/80 dark:bg-indigo-950/40 text-slate-900 dark:text-zinc-100',
  },
  {
    id: 'cursor',
    name: 'Cursor & IDEs',
    subtitle: 'Cursor, Cline & VS Code',
    authBadge: '🔑 Config Key',
    Icon: CursorIcon,
    iconColor: 'text-cyan-600 dark:text-cyan-400',
    activeRing: 'border-cyan-500 ring-2 ring-cyan-500/20 dark:border-cyan-400',
    activeBg: 'bg-cyan-50/80 dark:bg-cyan-950/40 text-slate-900 dark:text-zinc-100',
  },
  {
    id: 'api',
    name: 'API & Scripts',
    subtitle: 'Python & cURL',
    authBadge: '🔑 Bearer Token',
    Icon: props => <Terminal className={props.className} />,
    iconColor: 'text-slate-700 dark:text-zinc-300',
    activeRing: 'border-slate-500 ring-2 ring-slate-500/20 dark:border-zinc-400',
    activeBg: 'bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-zinc-100',
  },
]

export default function ConnectAiModal({
  activeUser: _activeUser,
  groups,
  onClose,
}: {
  activeUser?: User | null
  groups: Group[]
  onClose: () => void
}) {
  const toast = useToast()
  const [provider, setProvider] = useState<ProviderId>('claude')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Sub-mode options for each provider
  const [claudeMode, setClaudeMode] = useState<'desktop' | 'web' | 'cli'>('desktop')
  const [claudeOs, setClaudeOs] = useState<'mac' | 'windows' | 'linux'>('mac')
  const [geminiMode, setGeminiMode] = useState<'app' | 'sdk'>('app')
  const [cursorMode, setCursorMode] = useState<'cursor' | 'vscode'>('cursor')
  const [apiMode, setApiMode] = useState<'curl' | 'python'>('curl')

  // Keys state
  const [keys, setKeys] = useState<ApiKeyItem[]>([])
  const [loadingKeys, setLoadingKeys] = useState(true)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [showAllKeys, setShowAllKeys] = useState(false)
  const [creatingKey, setCreatingKey] = useState(false)

  // Create key form state
  const [keyName, setKeyName] = useState('')
  const [scopeType, setScopeType] = useState<ApiKeyScopeType>('GLOBAL')
  const [accessLevel, setAccessLevel] = useState<ApiKeyAccessLevel>('READ_WRITE')
  const [selectedGroupId, setSelectedGroupId] = useState<string>(() => groups[0]?.id ?? '')
  const [formError, setFormError] = useState('')

  // Newly created key with privacy & mask controls
  const [newKey, setNewKey] = useState<CreatedApiKeyResponse | null>(null)
  const [isKeyCopied, setIsKeyCopied] = useState(false)
  const [showRawKey, setShowRawKey] = useState(true)

  // Inline confirmation state
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null)
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null)

  // Dynamic public backend URLs
  const baseBackend = getBackendBaseUrl()
  const mcpUrl = getMcpUrl()
  const sseUrl = getSseUrl()
  const restUrl = `${baseBackend}/api`

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

  async function handleCopyNewKey() {
    if (!newKey) return
    await navigator.clipboard.writeText(newKey.raw_key)
    setIsKeyCopied(true)
    setShowRawKey(false)
    setCopiedId('new-key')
    toast('API key copied & masked for security!', { tone: 'success' })
    window.setTimeout(() => setCopiedId(prev => (prev === 'new-key' ? null : prev)), 2000)
  }

  async function handleGenerateKey(e: React.FormEvent) {
    e.preventDefault()
    setFormError('')
    const trimmedName = keyName.trim()
    if (!trimmedName) {
      setFormError('Give this key a friendly name (e.g. "My Claude Assistant" or "Gemini Phone").')
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
      setIsKeyCopied(false)
      setShowRawKey(true)
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
  const currentKey = newKey ?? (activeKeys[0] || null)

  const claudeDesktopPaths = {
    mac: '~/Library/Application Support/Claude/claude_desktop_config.json',
    windows: '%APPDATA%\\Claude\\claude_desktop_config.json',
    linux: '~/.config/Claude/claude_desktop_config.json',
  }

  const keyPlaceholder = 'YOUR_API_KEY'
  const activeRawKey = newKey?.raw_key || keyPlaceholder
  const copyAuthMcpUrl = `${mcpUrl}?api_key=${activeRawKey}`
  const copyAuthSseUrl = `${sseUrl}?api_key=${activeRawKey}`
  const displayAuthMcpUrl = `${mcpUrl}?api_key=${
    newKey
      ? (!isKeyCopied || showRawKey ? newKey.raw_key : 'pvh_••••••••')
      : currentKey ? `${currentKey.key_prefix}••••••••` : 'YOUR_API_KEY'
  }`

  const claudeConfigJson = JSON.stringify(
    {
      mcpServers: {
        prompthold: {
          command: 'npx',
          args: ['-y', 'mcp-remote', copyAuthMcpUrl],
        },
      },
    },
    null,
    2
  )

  const cursorMcpConfigJson = JSON.stringify(
    {
      mcpServers: {
        prompthold: {
          command: 'npx',
          args: ['-y', 'mcp-remote', copyAuthMcpUrl],
        },
      },
    },
    null,
    2
  )

  const clineConfigJson = JSON.stringify(
    {
      mcpServers: {
        prompthold: {
          command: 'npx',
          args: ['-y', 'mcp-remote', copyAuthMcpUrl],
        },
      },
    },
    null,
    2
  )

  const copySnippetKey = activeRawKey

  const geminiPythonSnippet = `import requests
from google import genai

# 1. Fetch prompts from PromptHold Backend API
headers = {"Authorization": "Bearer ${copySnippetKey}"}
response = requests.get("${restUrl}/prompts", headers=headers)
prompts = response.json()

# 2. Extract active prompt template
template = prompts[0]["content"] if prompts else "You are a helpful assistant."

# 3. Generate response with Gemini 2.5
client = genai.Client()
result = client.models.generate_content(
    model="gemini-2.5-flash",
    contents=f"System Template:\\n{template}\\n\\nTask: Assist user with prompt.",
)
print(result.text)`

  const pythonSnippet = `import requests

# Query prompts using live PromptHold Backend API
headers = {"Authorization": "Bearer ${copySnippetKey}"}
response = requests.get("${restUrl}/prompts", headers=headers)

# Parse JSON response
prompts = response.json()
print(f"Loaded {len(prompts)} prompts:")
for p in prompts:
    print(f"• [{p.get('group_name', 'Personal')}] {p.get('title')} (v{p.get('current_version_number', 1)})")`

  const curlSnippet = `curl -X GET "${restUrl}/prompts" \\
  -H "Authorization: Bearer ${copySnippetKey}"`

  return (
    <Modal
      title="Connect PromptHold to Your AI"
      description="Use your saved prompts directly inside Claude, ChatGPT, Gemini, Cursor, or custom workflows."
      icon={<PlugZap size={18} className="text-brand-600 dark:text-brand-400" />}
      size="xl"
      onClose={onClose}
      footer={
        <button type="button" onClick={onClose} className="btn-primary" data-autofocus>
          Done
        </button>
      }
    >
      <div className="max-h-[75vh] space-y-5 overflow-y-auto pr-1 custom-scrollbar">
        {/* Global Security & Privacy Trust Banner */}
        <div className="flex items-center gap-2.5 rounded-xl border border-emerald-200/90 bg-emerald-50/70 p-3 text-xs text-emerald-950 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200">
          <ShieldCheck size={18} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div className="min-w-0 flex-1 leading-relaxed">
            <span className="font-semibold text-slate-900 dark:text-zinc-100">🔒 100% Private &amp; Automatic: </span>
            Set up once in your assistant settings. You will <strong>never</strong> need to paste API keys into chat messages.
          </div>
        </div>

        {/* ==================== STEP 1: SECURITY KEY ==================== */}
        <section aria-labelledby="connect-keys-heading" className="space-y-3 rounded-xl border border-slate-200/90 bg-slate-50/60 p-4 dark:border-zinc-800 dark:bg-zinc-950/40">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5">
            <div>
              <h3 id="connect-keys-heading" className="text-sm font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-1.5">
                <KeyRound size={15} className="text-brand-600 dark:text-brand-400" />
                Step 1: Your Security Key
              </h3>
              <p className="text-xs text-slate-500 dark:text-zinc-400">
                Gives your assistants secure access to your prompts. Claude.ai, ChatGPT and Gemini connect with your PromptHold sign-in (OAuth), so they don't need an API key. Keys are only for desktop configs, IDEs and scripts.
              </p>
            </div>

            <div className="flex items-center gap-2 self-start sm:self-auto">
              {activeKeys.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAllKeys(prev => !prev)}
                  className="btn-ghost btn-sm text-xs"
                >
                  {showAllKeys ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  <span>{showAllKeys ? 'Hide Keys' : `All Keys (${activeKeys.length})`}</span>
                </button>
              )}
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
                  <span>Create Key</span>
                </button>
              )}
            </div>
          </div>

          {/* Active Key Status Card (Clean, compact, no clutter) */}
          {!newKey && activeKeys.length > 0 && !showCreateForm && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 rounded-lg border border-slate-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex items-center gap-2 min-w-0">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-950/80 dark:text-emerald-400 ring-1 ring-emerald-500/20">
                  <KeyRound size={14} />
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-xs text-slate-900 dark:text-zinc-100 truncate">{activeKeys[0].name}</span>
                    <ScopePill item={activeKeys[0]} />
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-zinc-400 font-mono mt-0.5">
                    Prefix: <span className="font-semibold text-slate-700 dark:text-zinc-300">{activeKeys[0].key_prefix}</span> · {formatRelativeTime(activeKeys[0].last_used_at)}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 self-start sm:self-auto">
                <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 ring-1 ring-emerald-600/20">
                  <Check size={11} /> Ready to use
                </span>
              </div>
            </div>
          )}

          {/* Newly Created Key Alert (Temporary one-time copy) */}
          {newKey && (
            <div
              role="region"
              aria-label="New API key"
              className="animate-pop-in rounded-xl border border-brand-300 bg-brand-50/80 p-3.5 dark:border-brand-900/60 dark:bg-brand-950/40"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-medium text-brand-900 dark:text-brand-200">
                  <ShieldCheck size={16} className="text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <span>
                    New key created for <strong>{newKey.name}</strong>.
                    {isKeyCopied
                      ? ' Copied to clipboard and safely masked!'
                      : ' Copy it now — for your security, full keys are hidden once copied.'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {isKeyCopied && (
                    <button
                      type="button"
                      onClick={() => setShowRawKey(prev => !prev)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:text-brand-900 dark:text-brand-300 dark:hover:text-brand-100"
                    >
                      {showRawKey ? <EyeOff size={13} /> : <Eye size={13} />}
                      <span>{showRawKey ? 'Hide key' : 'Peek key'}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setNewKey(null)}
                    className="text-xs font-medium text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                  >
                    Dismiss
                  </button>
                </div>
              </div>

              <div className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1 relative flex items-center">
                  <code
                    className="w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 font-mono text-xs text-emerald-300 select-all dark:border-zinc-800 dark:bg-black dark:text-emerald-400 tracking-wider truncate"
                  >
                    {showRawKey ? newKey.raw_key : '••••••••••••••••••••••••••••••••••••••••••••••••'}
                  </code>
                </div>
                <button
                  type="button"
                  onClick={() => void handleCopyNewKey()}
                  className="btn-primary btn-sm shrink-0"
                >
                  {isKeyCopied ? <Check size={14} /> : <Copy size={14} />}
                  <span>{isKeyCopied ? 'Copied' : 'Copy Key'}</span>
                </button>
              </div>
            </div>
          )}

          {/* Simple Create Key Form */}
          {showCreateForm && (
            <form
              onSubmit={e => void handleGenerateKey(e)}
              className="animate-pop-in space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="min-w-0">
                  <label htmlFor="api-key-name" className="field-label text-xs">
                    Key Friendly Name
                  </label>
                  <input
                    id="api-key-name"
                    value={keyName}
                    onChange={e => setKeyName(e.target.value)}
                    placeholder="e.g. My Claude Desktop"
                    maxLength={120}
                    className="field bg-slate-50 dark:bg-zinc-950"
                  />
                </div>

                <div className="min-w-0">
                  <label className="field-label text-xs">Access Scope</label>
                  <div role="radiogroup" aria-label="Access scope" className="segmented w-full">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={scopeType === 'GLOBAL'}
                      onClick={() => setScopeType('GLOBAL')}
                      className={`segmented-item flex-1 ${scopeType === 'GLOBAL' ? 'segmented-item-active' : ''}`}
                    >
                      All spaces
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={scopeType === 'GROUP'}
                      onClick={() => setScopeType('GROUP')}
                      className={`segmented-item flex-1 ${scopeType === 'GROUP' ? 'segmented-item-active' : ''}`}
                    >
                      Specific space
                    </button>
                  </div>
                </div>

                <div className="min-w-0">
                  <label className="field-label text-xs">Permission</label>
                  <div role="radiogroup" aria-label="Permission level" className="segmented w-full">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={accessLevel === 'READ_WRITE'}
                      onClick={() => setAccessLevel('READ_WRITE')}
                      className={`segmented-item flex-1 ${accessLevel === 'READ_WRITE' ? 'segmented-item-active' : ''}`}
                    >
                      Read &amp; Write
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={accessLevel === 'READ_ONLY'}
                      onClick={() => setAccessLevel('READ_ONLY')}
                      className={`segmented-item flex-1 ${accessLevel === 'READ_ONLY' ? 'segmented-item-active' : ''}`}
                    >
                      Read-only
                    </button>
                  </div>
                </div>
              </div>

              {scopeType === 'GROUP' && (
                <div className="pt-1">
                  <label className="field-label text-xs">Select Space</label>
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

              <div className="flex items-center justify-end gap-2 pt-1">
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
                  <span>{creatingKey ? 'Creating…' : 'Generate Key'}</span>
                </button>
              </div>
            </form>
          )}

          {/* Active Keys Expanded List */}
          {showAllKeys && (
            <div className="space-y-2 pt-1">
              <h4 className="text-xs font-semibold text-slate-700 dark:text-zinc-300">Active Security Keys:</h4>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
                {activeKeys.map(item => {
                  const isConfirming = confirmRevokeId === item.id
                  const isBusy = busyKeyId === item.id
                  const isReadOnly = item.access_level === 'READ_ONLY'
                  return (
                    <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className="font-semibold text-slate-900 dark:text-zinc-100">{item.name}</span>
                        <ScopePill item={item} />
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            isReadOnly
                              ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
                              : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                          }`}
                        >
                          {isReadOnly ? 'Read-only' : 'Read & Write'}
                        </span>
                        <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[10px] text-slate-500 dark:bg-zinc-800 dark:text-zinc-400">
                          {item.key_prefix}
                        </code>
                      </div>

                      <div className="flex items-center gap-1.5">
                        {isConfirming ? (
                          <>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleRevoke(item.id)}
                              className="rounded bg-rose-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-rose-700"
                            >
                              {isBusy ? 'Revoking…' : 'Confirm'}
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => setConfirmRevokeId(null)}
                              className="btn-ghost btn-xs text-[11px]"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmRevokeId(item.id)}
                            className="text-[11px] font-medium text-slate-400 hover:text-rose-600 dark:text-zinc-500 dark:hover:text-rose-400 transition"
                          >
                            Revoke
                          </button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {loadingKeys && (
            <p className="py-1 text-xs text-slate-400 dark:text-zinc-500">Checking key status…</p>
          )}
        </section>

        {/* ==================== STEP 2: CHOOSE AI ASSISTANT ==================== */}
        <section aria-labelledby="connect-setup-heading" className="space-y-4">
          <div>
            <h3 id="connect-setup-heading" className="text-sm font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-1.5">
              <Sparkles size={15} className="text-brand-600 dark:text-brand-400" />
              Step 2: Choose Your AI Assistant
            </h3>
            <p className="text-xs text-slate-500 dark:text-zinc-400">
              Select your AI tool below for 3-step setup instructions.
            </p>
          </div>

          {/* AI Provider Tabs (Responsive Grid) */}
          <div role="tablist" aria-label="AI assistants" className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {PROVIDERS.map((item, index) => {
              const Icon = item.Icon
              const active = provider === item.id
              const isLast = index === PROVIDERS.length - 1
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setProvider(item.id)}
                  className={`flex flex-col gap-1.5 rounded-xl border p-3 text-left transition focus:outline-none focus-visible:ring-2 cursor-pointer ${
                    isLast ? 'col-span-2 sm:col-span-1' : ''
                  } ${
                    active
                      ? `${item.activeRing} ${item.activeBg}`
                      : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/60'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className={`inline-flex rounded-lg p-1.5 ${item.iconColor} ${active ? 'bg-white shadow-xs dark:bg-black/30' : 'bg-slate-100 dark:bg-zinc-800'}`}>
                      <Icon className="h-4 w-4" />
                    </span>
                    {active && <span className="h-2 w-2 rounded-full bg-brand-500 ring-2 ring-brand-500/30" aria-hidden="true" />}
                  </div>
                  <div className="min-w-0">
                    <div className="font-semibold text-xs text-slate-900 dark:text-zinc-100">{item.name}</div>
                    <div className="text-[10px] text-slate-500 dark:text-zinc-400 truncate">{item.subtitle}</div>
                    <div className="mt-1 inline-flex items-center rounded bg-slate-100/90 px-1.5 py-0.5 text-[9px] font-medium text-slate-600 dark:bg-zinc-800/90 dark:text-zinc-300 truncate">
                      {item.authBadge}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>

          {/* ==================== PROVIDER 1: CLAUDE ==================== */}
          {provider === 'claude' && (
            <div className="space-y-4 rounded-xl border border-amber-200/90 bg-gradient-to-b from-amber-50/50 to-white p-4.5 dark:border-amber-900/40 dark:from-amber-950/20 dark:to-zinc-900">
              {/* Header with Title and Unmistakable Active Segmented Selector */}
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 border-b border-amber-100 pb-3.5 dark:border-amber-900/30">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 shrink-0">
                    <ClaudeIcon className="h-4 w-4" />
                  </span>
                  <div>
                    <h4 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">Connect Anthropic Claude</h4>
                    <p className="text-xs text-slate-500 dark:text-zinc-400">Choose your environment:</p>
                  </div>
                </div>

                <div role="tablist" aria-label="Claude setup options" className="segmented w-full md:w-auto">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={claudeMode === 'desktop'}
                    onClick={() => setClaudeMode('desktop')}
                    className={`segmented-item flex-1 md:flex-none ${
                      claudeMode === 'desktop' ? 'segmented-item-active-amber' : ''
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full transition-colors ${claudeMode === 'desktop' ? 'bg-amber-500' : 'bg-transparent'}`} aria-hidden="true" />
                    <span>Claude Desktop</span>
                    <span className={`rounded px-1.5 py-0.2 text-[9px] font-bold uppercase tracking-wider ${
                      claudeMode === 'desktop'
                        ? 'bg-amber-200 text-amber-950 dark:bg-amber-900 dark:text-amber-200'
                        : 'bg-slate-200 text-slate-600 dark:bg-zinc-800 dark:text-zinc-400'
                    }`}>
                      Easiest
                    </span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={claudeMode === 'web'}
                    onClick={() => setClaudeMode('web')}
                    className={`segmented-item flex-1 md:flex-none ${
                      claudeMode === 'web' ? 'segmented-item-active-amber' : ''
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full transition-colors ${claudeMode === 'web' ? 'bg-amber-500' : 'bg-transparent'}`} aria-hidden="true" />
                    <span>Claude.ai Web</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={claudeMode === 'cli'}
                    onClick={() => setClaudeMode('cli')}
                    className={`segmented-item flex-1 md:flex-none ${
                      claudeMode === 'cli' ? 'segmented-item-active-amber' : ''
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full transition-colors ${claudeMode === 'cli' ? 'bg-amber-500' : 'bg-transparent'}`} aria-hidden="true" />
                    <span>Claude Code CLI</span>
                  </button>
                </div>
              </div>

              {/* Sub-Mode 1: Claude Desktop */}
              {claudeMode === 'desktop' && (
                <div className="space-y-3.5 pt-1">
                  <ol className="space-y-3 text-xs text-slate-700 dark:text-zinc-300">
                    <li className="flex gap-2.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-200 text-[11px] font-bold text-amber-950 dark:bg-amber-900/60 dark:text-amber-200">1</span>
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <span className="font-medium text-slate-900 dark:text-zinc-100">Select your Operating System:</span>
                        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                          {(['mac', 'windows', 'linux'] as const).map(os => (
                            <button
                              key={os}
                              type="button"
                              onClick={() => setClaudeOs(os)}
                              className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition cursor-pointer ${
                                claudeOs === os
                                  ? 'bg-amber-600 text-white shadow-xs dark:bg-amber-500 dark:text-zinc-950'
                                  : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50 dark:bg-zinc-900 dark:border-zinc-800 dark:text-zinc-400'
                              }`}
                            >
                              {os === 'mac' ? 'macOS' : os === 'windows' ? 'Windows' : 'Linux'}
                            </button>
                          ))}
                        </div>
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg bg-white p-2.5 border border-slate-200 dark:bg-zinc-900 dark:border-zinc-800 min-w-0">
                          <code className="min-w-0 break-all font-mono text-[11px] text-slate-700 dark:text-zinc-300">
                            {claudeDesktopPaths[claudeOs]}
                          </code>
                          <button
                            type="button"
                            onClick={() => void copy(claudeDesktopPaths[claudeOs], 'claude-path', 'File path copied')}
                            className="btn-secondary btn-sm shrink-0 self-start sm:self-auto text-xs"
                          >
                            {copiedId === 'claude-path' ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
                            <span>{copiedId === 'claude-path' ? 'Copied' : 'Copy path'}</span>
                          </button>
                        </div>
                      </div>
                    </li>

                    <li className="flex gap-2.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-200 text-[11px] font-bold text-amber-950 dark:bg-amber-900/60 dark:text-amber-200">2</span>
                      <div className="min-w-0 flex-1 space-y-1">
                        <span className="font-medium text-slate-900 dark:text-zinc-100">Paste configuration into that file:</span>
                        <div className="mt-1">
                          <div className="mb-1 flex items-center justify-between text-xs font-medium text-slate-600 dark:text-zinc-300">
                            <span>claude_desktop_config.json</span>
                            <button
                              type="button"
                              onClick={() => void copy(claudeConfigJson, 'claude-json', 'Configuration copied')}
                              className="btn-ghost btn-sm h-7 px-2 text-xs"
                            >
                              {copiedId === 'claude-json' ? <Check size={13} className="text-amber-600 dark:text-amber-400" /> : <Copy size={13} />}
                              <span>{copiedId === 'claude-json' ? 'Copied' : 'Copy config'}</span>
                            </button>
                          </div>
                          <pre className="overflow-x-auto rounded-lg bg-slate-900 px-3.5 py-2.5 font-mono text-xs leading-relaxed text-slate-100 custom-scrollbar dark:border dark:border-zinc-800 dark:bg-black dark:text-zinc-200 min-w-0 max-w-full">
                            <code>{claudeConfigJson}</code>
                          </pre>
                        </div>
                      </div>
                    </li>

                    <li className="flex gap-2.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-200 text-[11px] font-bold text-amber-950 dark:bg-amber-900/60 dark:text-amber-200">3</span>
                      <span className="font-medium text-slate-900 dark:text-zinc-100">Restart Claude Desktop. Your PromptHold prompt tools are live!</span>
                    </li>
                  </ol>
                </div>
              )}

              {/* Sub-Mode 2: Claude.ai Web */}
              {claudeMode === 'web' && (
                <div className="space-y-3.5 pt-1">
                  <ol className="space-y-2.5 text-xs text-slate-700 dark:text-zinc-300">
                      <li className="flex gap-2.5">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-200 text-[11px] font-bold text-amber-950 dark:bg-amber-900/60 dark:text-amber-200">1</span>
                        <span>On <strong>claude.ai</strong>, open <strong>Customize</strong> → <strong>Connectors</strong> → <strong>Add</strong> → <strong>Add custom connector</strong>.</span>
                      </li>
                      <li className="flex gap-2.5">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-200 text-[11px] font-bold text-amber-950 dark:bg-amber-900/60 dark:text-amber-200">2</span>
                        <div className="min-w-0 flex-1 space-y-1">
                          <span>Name it <strong>PromptHold</strong> and paste the server URL:</span>
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg bg-white p-2.5 border border-slate-200 dark:bg-zinc-900 dark:border-zinc-800 min-w-0">
                            <code className="min-w-0 break-all font-mono text-[11px] text-amber-700 dark:text-amber-400">
                              {mcpUrl}
                            </code>
                            <button
                              type="button"
                              onClick={() => void copy(mcpUrl, 'claude-oauth-url', 'Server URL copied')}
                              className="btn-secondary btn-sm shrink-0 self-start sm:self-auto text-xs"
                            >
                              {copiedId === 'claude-oauth-url' ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
                              <span>{copiedId === 'claude-oauth-url' ? 'Copied' : 'Copy URL'}</span>
                            </button>
                          </div>
                        </div>
                      </li>
                      <li className="flex gap-2.5">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-200 text-[11px] font-bold text-amber-950 dark:bg-amber-900/60 dark:text-amber-200">3</span>
                        <span>Under <strong>Authentication</strong>, keep <strong>Sign in now</strong> and click <strong>Add</strong>. Then click <strong>Connect</strong> and sign in with your <strong>PromptHold</strong> email and password. No API key is needed.</span>
                      </li>
                  </ol>
                </div>
              )}

              {/* Sub-Mode 3: Claude Code CLI */}
              {claudeMode === 'cli' && (
                <div className="space-y-3 pt-1">
                  <div className="space-y-1.5">
                    <span className="text-xs font-semibold text-slate-800 dark:text-zinc-200">Run this single terminal command:</span>
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg bg-slate-900 p-2.5 border border-slate-800 dark:bg-black dark:border-zinc-800 min-w-0">
                      <code className="min-w-0 break-all font-mono text-xs text-emerald-300 dark:text-emerald-400">
                        claude mcp add --transport http prompthold "{displayAuthMcpUrl}"
                      </code>
                      <button
                        type="button"
                        onClick={() => void copy(`claude mcp add --transport http prompthold "${copyAuthMcpUrl}"`, 'claude-cli', 'Command copied')}
                        className="btn-secondary btn-sm shrink-0 self-start sm:self-auto text-xs text-white bg-slate-800 border-slate-700 hover:bg-slate-700"
                      >
                        {copiedId === 'claude-cli' ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                        <span>{copiedId === 'claude-cli' ? 'Copied' : 'Copy command'}</span>
                      </button>
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-zinc-400">
                    Launch Claude Code with <code>claude</code> and run <code>/mcp</code> to verify connection.
                  </p>
                </div>
              )}

              {/* Interactive Sample Chat Prompt */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-xs dark:border-amber-900/40 dark:bg-amber-950/30">
                <div className="flex items-start gap-2 min-w-0">
                  <Sparkles size={15} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                  <div className="min-w-0">
                    <span className="font-semibold text-slate-900 dark:text-zinc-100">Try in Claude Chat:</span>
                    <div className="text-slate-700 dark:text-zinc-300 font-mono text-[11px] truncate mt-0.5">
                      “Show my available prompt templates in PromptHold”
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void copy('Show my available prompt templates in PromptHold', 'claude-sample', 'Prompt copied')}
                  className="btn-secondary btn-sm shrink-0 self-start sm:self-auto text-xs"
                >
                  {copiedId === 'claude-sample' ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
                  <span>{copiedId === 'claude-sample' ? 'Copied' : 'Copy prompt'}</span>
                </button>
              </div>
            </div>
          )}

          {/* ==================== PROVIDER 2: CHATGPT ==================== */}
          {provider === 'chatgpt' && (
            <div className="space-y-4 rounded-xl border border-emerald-200/90 bg-gradient-to-b from-emerald-50/50 to-white p-4.5 dark:border-emerald-900/40 dark:from-emerald-950/20 dark:to-zinc-900">
              {/* Header with Title and Unmistakable Active Segmented Selector */}
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 border-b border-emerald-100 pb-3.5 dark:border-emerald-900/30">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 shrink-0">
                    <ChatGptIcon className="h-4 w-4" />
                  </span>
                  <div>
                    <h4 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">Connect OpenAI ChatGPT</h4>
                    <p className="text-xs text-slate-500 dark:text-zinc-400">Syncs prompts with Web, Mobile &amp; Desktop:</p>
                  </div>
                </div>

              </div>

              <div className="space-y-3.5 pt-1">
                <ol className="space-y-2.5 text-xs text-slate-700 dark:text-zinc-300">
                  <li className="flex gap-2.5">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-200 text-[11px] font-bold text-emerald-950 dark:bg-emerald-900/60 dark:text-emerald-200">1</span>
                    <span>On <strong>chatgpt.com</strong>, open <strong>Plugins</strong> → <strong>Add</strong> → <strong>Add custom MCP server</strong>.</span>
                  </li>
                  <li className="flex gap-2.5">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-200 text-[11px] font-bold text-emerald-950 dark:bg-emerald-900/60 dark:text-emerald-200">2</span>
                    <div className="min-w-0 flex-1 space-y-1">
                      <span>Name it <strong>PromptHold</strong>, paste this server URL, and keep <strong>Authentication: OAuth</strong>:</span>
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg bg-white p-2.5 border border-slate-200 dark:bg-zinc-900 dark:border-zinc-800 min-w-0">
                        <code className="min-w-0 break-all font-mono text-[11px] text-emerald-700 dark:text-emerald-400">
                          {mcpUrl}
                        </code>
                        <button
                          type="button"
                          onClick={() => void copy(mcpUrl, 'chatgpt-url', 'Server URL copied')}
                          className="btn-secondary btn-sm shrink-0 self-start sm:self-auto text-xs"
                        >
                          {copiedId === 'chatgpt-url' ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
                          <span>{copiedId === 'chatgpt-url' ? 'Copied' : 'Copy URL'}</span>
                        </button>
                      </div>
                    </div>
                  </li>
                  <li className="flex gap-2.5">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-200 text-[11px] font-bold text-emerald-950 dark:bg-emerald-900/60 dark:text-emerald-200">3</span>
                    <span>Tick <strong>I understand and want to continue</strong>, click <strong>Create as a plugin</strong>, then sign in with your <strong>PromptHold</strong> email and password. No API key is needed.</span>
                  </li>
                </ol>
                <p className="text-[11px] text-slate-500 dark:text-zinc-400">Once added, PromptHold is available in ChatGPT on web, desktop and mobile. Mention <code>@PromptHold</code> in a chat to use it.</p>
              </div>

              {/* Sample Prompt */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50/70 p-3 text-xs dark:border-emerald-900/40 dark:bg-emerald-950/30">
                <div className="flex items-start gap-2 min-w-0">
                  <Sparkles size={15} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <div className="min-w-0">
                    <span className="font-semibold text-slate-900 dark:text-zinc-100">Try in ChatGPT:</span>
                    <div className="text-slate-700 dark:text-zinc-300 font-mono text-[11px] truncate mt-0.5">
                      “Search PromptHold for the 'Customer Onboarding' prompt and fill client_name='Acme'”
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void copy("Search PromptHold for the 'Customer Onboarding' prompt and fill client_name='Acme'", 'gpt-sample', 'Prompt copied')}
                  className="btn-secondary btn-sm shrink-0 self-start sm:self-auto text-xs"
                >
                  {copiedId === 'gpt-sample' ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
                  <span>{copiedId === 'gpt-sample' ? 'Copied' : 'Copy prompt'}</span>
                </button>
              </div>
            </div>
          )}

          {/* ==================== PROVIDER 3: GEMINI ==================== */}
          {provider === 'gemini' && (
            <div className="space-y-4 rounded-xl border border-indigo-200/90 bg-gradient-to-b from-indigo-50/50 to-white p-4.5 dark:border-indigo-900/40 dark:from-indigo-950/20 dark:to-zinc-900">
              {/* Header with Title and Unmistakable Active Segmented Selector */}
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 border-b border-indigo-100 pb-3.5 dark:border-indigo-900/30">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300 shrink-0">
                    <GeminiIcon className="h-4 w-4" />
                  </span>
                  <div>
                    <h4 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">Connect Google Gemini</h4>
                    <p className="text-xs text-slate-500 dark:text-zinc-400">Available in Web, Android &amp; iOS:</p>
                  </div>
                </div>

                <div role="tablist" aria-label="Gemini setup options" className="segmented w-full md:w-auto">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={geminiMode === 'app'}
                    onClick={() => setGeminiMode('app')}
                    className={`segmented-item flex-1 md:flex-none ${
                      geminiMode === 'app' ? 'segmented-item-active-indigo' : ''
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full transition-colors ${geminiMode === 'app' ? 'bg-indigo-500' : 'bg-transparent'}`} aria-hidden="true" />
                    <span>Gemini App (Web, Android &amp; iOS)</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={geminiMode === 'sdk'}
                    onClick={() => setGeminiMode('sdk')}
                    className={`segmented-item flex-1 md:flex-none ${
                      geminiMode === 'sdk' ? 'segmented-item-active-indigo' : ''
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full transition-colors ${geminiMode === 'sdk' ? 'bg-indigo-500' : 'bg-transparent'}`} aria-hidden="true" />
                    <span>Python GenAI SDK</span>
                  </button>
                </div>
              </div>

              {geminiMode === 'app' && (
                <div className="space-y-3.5 pt-1">
                  <ol className="space-y-2.5 text-xs text-slate-700 dark:text-zinc-300">
                    <li className="flex gap-2.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-200 text-[11px] font-bold text-indigo-950 dark:bg-indigo-900/60 dark:text-indigo-200">1</span>
                      <span>On <strong>gemini.google.com</strong>, open <strong>More</strong> → <strong>Customize</strong> → <strong>Connectors</strong> → click <strong>+ Custom</strong>.</span>
                    </li>
                    <li className="flex gap-2.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-200 text-[11px] font-bold text-indigo-950 dark:bg-indigo-900/60 dark:text-indigo-200">2</span>
                      <div className="min-w-0 flex-1 space-y-1">
                        <span>Paste the server URL and click <strong>Next</strong>:</span>
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg bg-white p-2.5 border border-slate-200 dark:bg-zinc-900 dark:border-zinc-800 min-w-0">
                          <code className="min-w-0 break-all font-mono text-[11px] text-indigo-700 dark:text-indigo-400">
                            {mcpUrl}
                          </code>
                          <button
                            type="button"
                            onClick={() => void copy(mcpUrl, 'gemini-url', 'Server URL copied')}
                            className="btn-secondary btn-sm shrink-0 self-start sm:self-auto text-xs"
                          >
                            {copiedId === 'gemini-url' ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
                            <span>{copiedId === 'gemini-url' ? 'Copied' : 'Copy URL'}</span>
                          </button>
                        </div>
                      </div>
                    </li>
                    <li className="flex gap-2.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-200 text-[11px] font-bold text-indigo-950 dark:bg-indigo-900/60 dark:text-indigo-200">3</span>
                      <span>Review the consent screen and click <strong>Connect</strong>, then sign in with your <strong>PromptHold</strong> email and password and click <strong>Authorize</strong>. No API key is needed.</span>
                    </li>
                  </ol>
                </div>
              )}

              {geminiMode === 'sdk' && (
                <div className="space-y-3 pt-1">
                  <div>
                    <div className="mb-1 flex items-center justify-between text-xs font-medium text-slate-600 dark:text-zinc-300">
                      <span>Python script (google-genai SDK)</span>
                      <button
                        type="button"
                        onClick={() => void copy(geminiPythonSnippet, 'gemini-sdk', 'Code copied')}
                        className="btn-ghost btn-sm h-7 px-2 text-xs"
                      >
                        {copiedId === 'gemini-sdk' ? <Check size={13} className="text-indigo-600 dark:text-indigo-400" /> : <Copy size={13} />}
                        <span>{copiedId === 'gemini-sdk' ? 'Copied' : 'Copy code'}</span>
                      </button>
                    </div>
                    <pre className="overflow-x-auto rounded-lg bg-slate-900 px-3.5 py-2.5 font-mono text-xs leading-relaxed text-slate-100 custom-scrollbar dark:border dark:border-zinc-800 dark:bg-black dark:text-zinc-200 min-w-0 max-w-full">
                      <code>{geminiPythonSnippet}</code>
                    </pre>
                  </div>
                </div>
              )}

              {/* Sample Prompt */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 rounded-xl border border-indigo-200 bg-indigo-50/70 p-3 text-xs dark:border-indigo-900/40 dark:bg-indigo-950/30">
                <div className="flex items-start gap-2 min-w-0">
                  <Sparkles size={15} className="mt-0.5 shrink-0 text-indigo-600 dark:text-indigo-400" />
                  <div className="min-w-0">
                    <span className="font-semibold text-slate-900 dark:text-zinc-100">Try in Gemini:</span>
                    <div className="text-slate-700 dark:text-zinc-300 font-mono text-[11px] truncate mt-0.5">
                      “@PromptHold show my active Marketing templates”
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void copy('@PromptHold show my active Marketing templates', 'gemini-sample', 'Prompt copied')}
                  className="btn-secondary btn-sm shrink-0 self-start sm:self-auto text-xs"
                >
                  {copiedId === 'gemini-sample' ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
                  <span>{copiedId === 'gemini-sample' ? 'Copied' : 'Copy prompt'}</span>
                </button>
              </div>
            </div>
          )}

          {/* ==================== PROVIDER 4: CURSOR & IDES ==================== */}
          {provider === 'cursor' && (
            <div className="space-y-4 rounded-xl border border-cyan-200/90 bg-gradient-to-b from-cyan-50/50 to-white p-4.5 dark:border-cyan-900/40 dark:from-cyan-950/20 dark:to-zinc-900">
              {/* Header with Title and Unmistakable Active Segmented Selector */}
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 border-b border-cyan-100 pb-3.5 dark:border-cyan-900/30">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300 shrink-0">
                    <CursorIcon className="h-4 w-4" />
                  </span>
                  <div>
                    <h4 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">Connect Cursor &amp; Coding IDEs</h4>
                    <p className="text-xs text-slate-500 dark:text-zinc-400">Use prompts in Cursor Chat, Composer, or Cline:</p>
                  </div>
                </div>

                <div role="tablist" aria-label="Cursor setup options" className="segmented w-full md:w-auto">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={cursorMode === 'cursor'}
                    onClick={() => setCursorMode('cursor')}
                    className={`segmented-item flex-1 md:flex-none ${
                      cursorMode === 'cursor' ? 'segmented-item-active-cyan' : ''
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full transition-colors ${cursorMode === 'cursor' ? 'bg-cyan-500' : 'bg-transparent'}`} aria-hidden="true" />
                    <span>Cursor IDE</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={cursorMode === 'vscode'}
                    onClick={() => setCursorMode('vscode')}
                    className={`segmented-item flex-1 md:flex-none ${
                      cursorMode === 'vscode' ? 'segmented-item-active-cyan' : ''
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full transition-colors ${cursorMode === 'vscode' ? 'bg-cyan-500' : 'bg-transparent'}`} aria-hidden="true" />
                    <span>VS Code (Cline / Roo)</span>
                  </button>
                </div>
              </div>

              {cursorMode === 'cursor' && (
                <div className="space-y-3.5 pt-1">
                  <ol className="space-y-2.5 text-xs text-slate-700 dark:text-zinc-300">
                    <li className="flex gap-2.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cyan-200 text-[11px] font-bold text-cyan-950 dark:bg-cyan-900/60 dark:text-cyan-200">1</span>
                      <span>In Cursor, open <strong>Settings</strong> (Cmd+, or Ctrl+,) → <strong>Features</strong> → <strong>MCP Servers</strong>.</span>
                    </li>
                    <li className="flex gap-2.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cyan-200 text-[11px] font-bold text-cyan-950 dark:bg-cyan-900/60 dark:text-cyan-200">2</span>
                      <div className="min-w-0 flex-1 space-y-1">
                        <span>Click <strong>Add New MCP Server</strong>:</span>
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg bg-white p-2.5 border border-slate-200 dark:bg-zinc-900 dark:border-zinc-800 min-w-0">
                          <code className="min-w-0 break-all font-mono text-xs text-slate-800 dark:text-zinc-200">
                            npx -y mcp-remote "{displayAuthMcpUrl}"
                          </code>
                          <button
                            type="button"
                            onClick={() => void copy(`npx -y mcp-remote "${copyAuthMcpUrl}"`, 'cursor-cmd', 'Command copied')}
                            className="btn-secondary btn-sm shrink-0 self-start sm:self-auto text-xs"
                          >
                            {copiedId === 'cursor-cmd' ? <Check size={12} className="text-cyan-600" /> : <Copy size={12} />}
                            <span>{copiedId === 'cursor-cmd' ? 'Copied' : 'Copy command'}</span>
                          </button>
                        </div>
                      </div>
                    </li>
                  </ol>

                  {/* Or JSON Config */}
                  <div className="pt-1">
                    <div className="mb-1 flex items-center justify-between text-xs font-medium text-slate-600 dark:text-zinc-300">
                      <span>Or paste into <code>~/.cursor/mcp.json</code>:</span>
                      <button
                        type="button"
                        onClick={() => void copy(cursorMcpConfigJson, 'cursor-json', 'Config copied')}
                        className="btn-ghost btn-sm h-7 px-2 text-xs"
                      >
                        {copiedId === 'cursor-json' ? <Check size={13} className="text-cyan-600 dark:text-cyan-400" /> : <Copy size={13} />}
                        <span>{copiedId === 'cursor-json' ? 'Copied' : 'Copy config'}</span>
                      </button>
                    </div>
                    <pre className="overflow-x-auto rounded-lg bg-slate-900 px-3.5 py-2.5 font-mono text-xs leading-relaxed text-slate-100 custom-scrollbar dark:border dark:border-zinc-800 dark:bg-black dark:text-zinc-200 min-w-0 max-w-full">
                      <code>{cursorMcpConfigJson}</code>
                    </pre>
                  </div>

                  <p className="text-[11px] text-slate-500 dark:text-zinc-400">
                    💡 If using direct SSE mode: set <strong>Type: sse</strong> and URL to <code className="font-mono text-cyan-700 dark:text-cyan-300">{copyAuthSseUrl}</code>.
                  </p>
                </div>
              )}

              {cursorMode === 'vscode' && (
                <div className="space-y-3 pt-1">
                  <div>
                    <div className="mb-1 flex items-center justify-between text-xs font-medium text-slate-600 dark:text-zinc-300">
                      <span>Paste into Cline settings (<code>cline_mcp_settings.json</code>):</span>
                      <button
                        type="button"
                        onClick={() => void copy(clineConfigJson, 'cline-json', 'Configuration copied')}
                        className="btn-ghost btn-sm h-7 px-2 text-xs"
                      >
                        {copiedId === 'cline-json' ? <Check size={13} className="text-cyan-600 dark:text-cyan-400" /> : <Copy size={13} />}
                        <span>{copiedId === 'cline-json' ? 'Copied' : 'Copy config'}</span>
                      </button>
                    </div>
                    <pre className="overflow-x-auto rounded-lg bg-slate-900 px-3.5 py-2.5 font-mono text-xs leading-relaxed text-slate-100 custom-scrollbar dark:border dark:border-zinc-800 dark:bg-black dark:text-zinc-200 min-w-0 max-w-full">
                      <code>{clineConfigJson}</code>
                    </pre>
                  </div>
                </div>
              )}

              {/* Sample Prompt */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 rounded-xl border border-cyan-200 bg-cyan-50/70 p-3 text-xs dark:border-cyan-900/40 dark:bg-cyan-950/30">
                <div className="flex items-start gap-2 min-w-0">
                  <Sparkles size={15} className="mt-0.5 shrink-0 text-cyan-600 dark:text-cyan-400" />
                  <div className="min-w-0">
                    <span className="font-semibold text-slate-900 dark:text-zinc-100">Try in Cursor Chat (Cmd+L / Composer):</span>
                    <div className="text-slate-700 dark:text-zinc-300 font-mono text-[11px] truncate mt-0.5">
                      “Use PromptHold to load my 'Code Review' prompt and review this file”
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void copy("Use PromptHold to load my 'Code Review' prompt and review this file", 'cursor-sample', 'Prompt copied')}
                  className="btn-secondary btn-sm shrink-0 self-start sm:self-auto text-xs"
                >
                  {copiedId === 'cursor-sample' ? <Check size={12} className="text-cyan-600" /> : <Copy size={12} />}
                  <span>{copiedId === 'cursor-sample' ? 'Copied' : 'Copy prompt'}</span>
                </button>
              </div>
            </div>
          )}

          {/* ==================== PROVIDER 5: API & SCRIPTS ==================== */}
          {provider === 'api' && (
            <div className="space-y-4 rounded-xl border border-slate-200/90 bg-gradient-to-b from-slate-50/50 to-white p-4.5 dark:border-zinc-800 dark:from-zinc-950/20 dark:to-zinc-900">
              {/* Header with Title and Unmistakable Active Segmented Selector */}
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 border-b border-slate-200 pb-3.5 dark:border-zinc-800">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-slate-200 text-slate-700 dark:bg-zinc-800 dark:text-zinc-300 shrink-0">
                    <Terminal className="h-4 w-4" />
                  </span>
                  <div>
                    <h4 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">REST API &amp; Automated Scripts</h4>
                    <p className="text-xs text-slate-500 dark:text-zinc-400">Query prompts and substitute variables in pipelines:</p>
                  </div>
                </div>

                <div role="tablist" aria-label="API setup options" className="segmented w-full md:w-auto">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={apiMode === 'curl'}
                    onClick={() => setApiMode('curl')}
                    className={`segmented-item flex-1 md:flex-none ${
                      apiMode === 'curl' ? 'segmented-item-active' : ''
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full transition-colors ${apiMode === 'curl' ? 'bg-brand-500' : 'bg-transparent'}`} aria-hidden="true" />
                    <span>cURL</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={apiMode === 'python'}
                    onClick={() => setApiMode('python')}
                    className={`segmented-item flex-1 md:flex-none ${
                      apiMode === 'python' ? 'segmented-item-active' : ''
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full transition-colors ${apiMode === 'python' ? 'bg-brand-500' : 'bg-transparent'}`} aria-hidden="true" />
                    <span>Python</span>
                  </button>
                </div>
              </div>

              <div className="space-y-3 pt-1">
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs font-medium text-slate-600 dark:text-zinc-300">
                    <span>{apiMode === 'python' ? 'Python script' : 'cURL command'}</span>
                    <button
                      type="button"
                      onClick={() => void copy(apiMode === 'python' ? pythonSnippet : curlSnippet, `code-${apiMode}`, 'Code copied')}
                      className="btn-ghost btn-sm h-7 px-2 text-xs"
                    >
                      {copiedId === `code-${apiMode}` ? <Check size={13} className="text-brand-600 dark:text-brand-400" /> : <Copy size={13} />}
                      <span>{copiedId === `code-${apiMode}` ? 'Copied' : 'Copy code'}</span>
                    </button>
                  </div>
                  <pre className="overflow-x-auto rounded-lg bg-slate-900 px-3.5 py-2.5 font-mono text-xs leading-relaxed text-slate-100 custom-scrollbar dark:border dark:border-zinc-800 dark:bg-black dark:text-zinc-200 min-w-0 max-w-full">
                    <code>{apiMode === 'python' ? pythonSnippet : curlSnippet}</code>
                  </pre>
                </div>

                <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
                  <p>
                    <strong>API Filtering:</strong> Query specific spaces using <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] text-slate-700 dark:bg-zinc-800 dark:text-zinc-300">?group_id=&lt;id&gt;</code> or search with <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] text-slate-700 dark:bg-zinc-800 dark:text-zinc-300">?search=&lt;query&gt;</code>.
                  </p>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </Modal>
  )
}
