import { useCallback, useEffect, useState } from 'react'
import {
  Check,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  HelpCircle,
  Info,
  KeyRound,
  LockKeyhole,
  PlugZap,
  Plus,
  ShieldCheck,
  Smartphone,
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

interface ProviderTab {
  id: ProviderId
  name: string
  subtitle: string
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
    Icon: ClaudeIcon,
    iconColor: 'text-amber-600 dark:text-amber-400',
    activeRing: 'border-amber-500 ring-2 ring-amber-500/20 dark:border-amber-400',
    activeBg: 'bg-amber-50/70 dark:bg-amber-950/40 text-slate-900 dark:text-zinc-100',
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    subtitle: 'Web, Mobile & Desktop',
    Icon: ChatGptIcon,
    iconColor: 'text-emerald-600 dark:text-emerald-400',
    activeRing: 'border-emerald-500 ring-2 ring-emerald-500/20 dark:border-emerald-400',
    activeBg: 'bg-emerald-50/70 dark:bg-emerald-950/40 text-slate-900 dark:text-zinc-100',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    subtitle: 'Web, Mobile App & SDK',
    Icon: GeminiIcon,
    iconColor: 'text-indigo-600 dark:text-indigo-400',
    activeRing: 'border-indigo-500 ring-2 ring-indigo-500/20 dark:border-indigo-400',
    activeBg: 'bg-indigo-50/70 dark:bg-indigo-950/40 text-slate-900 dark:text-zinc-100',
  },
  {
    id: 'cursor',
    name: 'Cursor & IDEs',
    subtitle: 'Cursor, Cline & VS Code',
    Icon: CursorIcon,
    iconColor: 'text-cyan-600 dark:text-cyan-400',
    activeRing: 'border-cyan-500 ring-2 ring-cyan-500/20 dark:border-cyan-400',
    activeBg: 'bg-cyan-50/70 dark:bg-cyan-950/40 text-slate-900 dark:text-zinc-100',
  },
  {
    id: 'api',
    name: 'API & Scripts',
    subtitle: 'Python & cURL',
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
  const [claudeMode, setClaudeMode] = useState<'desktop' | 'cli' | 'web'>('desktop')
  const [claudeOs, setClaudeOs] = useState<'mac' | 'windows' | 'linux'>('mac')
  const [chatgptMode, setChatgptMode] = useState<'web' | 'desktop'>('web')
  const [geminiMode, setGeminiMode] = useState<'app' | 'sdk'>('app')
  const [cursorMode, setCursorMode] = useState<'cursor' | 'vscode'>('cursor')
  const [apiMode, setApiMode] = useState<'python' | 'curl'>('python')

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
  const openApiUrl = `${baseBackend}/openapi.json`

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
    setShowRawKey(false) // IMMEDIATELY mask with stars once copied for security!
    setCopiedId('new-key')
    toast('API key copied & masked for security!', { tone: 'success' })
    window.setTimeout(() => setCopiedId(prev => (prev === 'new-key' ? null : prev)), 2000)
  }

  async function handleGenerateKey(e: React.FormEvent) {
    e.preventDefault()
    setFormError('')
    const trimmedName = keyName.trim()
    if (!trimmedName) {
      setFormError('Give this key a friendly name (for example, "My Claude Key" or "Gemini Mobile").')
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
      : 'YOUR_API_KEY'
  }`

  // Modern MCP Bridge config using mcp-remote with authenticated personal endpoint
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

  const displaySnippetKey = newKey && !isKeyCopied ? newKey.raw_key : 'pvh_••••••••••••••••••••••••••••••••'
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
    contents=f"System Template:\\n{template}\\n\\nTask: Assist the user based on the prompt.",
)
print(result.text)`

  const pythonSnippet = `import requests

# Query your prompts using the live PromptHold Backend API
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
      description="Use your saved prompts directly inside Claude, ChatGPT, Gemini, Cursor, or your custom scripts."
      icon={<PlugZap size={18} className="text-brand-600 dark:text-brand-400" />}
      size="xl"
      onClose={onClose}
      footer={
        <button type="button" onClick={onClose} className="btn-primary" data-autofocus>
          Done
        </button>
      }
    >
      <div className="max-h-[75vh] space-y-6 overflow-y-auto pr-1 custom-scrollbar">
        {/* STEP 1: API KEY SECTION */}
        <section aria-labelledby="connect-keys-heading" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 id="connect-keys-heading" className="text-sm font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-1.5">
                <KeyRound size={15} className="text-brand-600 dark:text-brand-400" />
                Step 1: Your Security Key
              </h3>
              <p className="text-xs text-slate-500 dark:text-zinc-400">
                This key gives your AI assistants secure permission to read or update your prompts.
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
                <span>Create New Key</span>
              </button>
            )}
          </div>

          {/* Newly Created Key Banner (Shown once, stars after copy) */}
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
                      ? ' Copied to clipboard! Masked for security.'
                      : ' Copy it now — for security, it is hidden once copied!'}
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
                    style={{ overflowWrap: 'anywhere' }}
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

              {isKeyCopied && (
                <p className="mt-2 text-[11px] text-slate-600 dark:text-zinc-400 flex items-center gap-1">
                  <span className="text-emerald-600 dark:text-emerald-400 font-semibold">✓ Saved to clipboard.</span>
                  PromptHold never displays the full key again to protect your account.
                </p>
              )}
            </div>
          )}

          {/* Simple Create Key Form */}
          {showCreateForm && (
            <form
              onSubmit={e => void handleGenerateKey(e)}
              className="animate-pop-in space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 dark:border-zinc-800 dark:bg-zinc-950/40"
            >
              <div className="grid gap-3 sm:grid-cols-[1fr,auto,auto]">
                <div>
                  <label htmlFor="api-key-name" className="field-label text-xs">
                    Key Friendly Name
                  </label>
                  <input
                    id="api-key-name"
                    value={keyName}
                    onChange={e => setKeyName(e.target.value)}
                    placeholder="e.g. My Claude Desktop, Gemini Phone App"
                    maxLength={120}
                    className="field bg-white dark:bg-zinc-900"
                  />
                </div>

                <div>
                  <span className="field-label text-xs">Allowed Spaces</span>
                  <div className="segmented h-[38px] bg-white dark:bg-zinc-900">
                    <button
                      type="button"
                      onClick={() => setScopeType('GLOBAL')}
                      className={`segmented-item text-xs ${scopeType === 'GLOBAL' ? 'segmented-item-active' : ''}`}
                    >
                      All My Spaces
                    </button>
                    <button
                      type="button"
                      onClick={() => setScopeType('GROUP')}
                      className={`segmented-item text-xs ${scopeType === 'GROUP' ? 'segmented-item-active' : ''}`}
                    >
                      One Space Only
                    </button>
                  </div>
                </div>

                <div>
                  <span className="field-label text-xs">Permission</span>
                  <div className="segmented h-[38px] bg-white dark:bg-zinc-900">
                    <button
                      type="button"
                      onClick={() => setAccessLevel('READ_WRITE')}
                      className={`segmented-item text-xs ${accessLevel === 'READ_WRITE' ? 'segmented-item-active' : ''}`}
                    >
                      Read &amp; Save
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
                  <span>{creatingKey ? 'Creating Key…' : 'Generate Key'}</span>
                </button>
              </div>
            </form>
          )}

          {/* Active Keys List (Shows only masked prefixes) */}
          {loadingKeys ? (
            <p className="py-2 text-xs text-slate-400 dark:text-zinc-500">Loading your keys…</p>
          ) : activeKeys.length === 0 ? (
            !showCreateForm && (
              <p className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-500 dark:border-zinc-800 dark:text-zinc-400">
                No active keys found. Create a key above to get started!
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
                      <span className="font-semibold text-slate-900 dark:text-zinc-100">{item.name}</span>
                      <ScopePill item={item} />
                      <span
                        className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ${
                          isReadOnly
                            ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
                            : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                        }`}
                      >
                        {isReadOnly ? 'Read-only' : 'Read & Write'}
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

        {/* STEP 2: CHOOSE AI ASSISTANT */}
        <section aria-labelledby="connect-setup-heading" className="space-y-4 border-t border-slate-100 pt-5 dark:border-zinc-800">
          <div>
            <h3 id="connect-setup-heading" className="text-sm font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-1.5">
              <Sparkles size={15} className="text-brand-600 dark:text-brand-400" />
              Step 2: Choose Your AI Assistant
            </h3>
            <p className="text-xs text-slate-500 dark:text-zinc-400">
              Select the tool you use every day for simple 3-step setup instructions.
            </p>
          </div>

          {/* Zero-Key In-Chat Privacy Guarantee */}
          <div className="flex items-start gap-2.5 rounded-xl border border-emerald-300 bg-emerald-50/80 p-3 text-xs text-emerald-950 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200">
            <ShieldCheck size={18} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <div className="space-y-0.5">
              <span className="font-bold text-slate-900 dark:text-zinc-100">🔒 Zero-Key In-Chat Privacy (Never paste keys into chat):</span>
              <p className="text-slate-700 dark:text-zinc-300">
                You will <strong>never</strong> have to type or paste your API key into an AI chat message.
                Your key is configured once in your assistant settings, and PromptHold authenticates your requests silently in the background.
                Chat naturally in plain English!
              </p>
            </div>
          </div>

          {/* AI Provider Tabs */}
          <div role="tablist" aria-label="AI assistants" className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {PROVIDERS.map(item => {
              const Icon = item.Icon
              const active = provider === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setProvider(item.id)}
                  className={`flex flex-col gap-1.5 rounded-xl border p-3 text-left transition focus:outline-none focus-visible:ring-2 ${
                    active
                      ? `${item.activeRing} ${item.activeBg}`
                      : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/60'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className={`inline-flex rounded-lg p-1.5 ${item.iconColor} ${active ? 'bg-white/70 shadow-xs dark:bg-black/30' : 'bg-slate-100 dark:bg-zinc-800'}`}>
                      <Icon className="h-4 w-4" />
                    </span>
                    {active && <span className="h-2 w-2 rounded-full bg-brand-500" aria-hidden="true" />}
                  </div>
                  <div>
                    <div className="font-semibold text-xs text-slate-900 dark:text-zinc-100">{item.name}</div>
                    <div className="text-[10px] text-slate-500 dark:text-zinc-400 truncate">{item.subtitle}</div>
                  </div>
                </button>
              )
            })}
          </div>

          {/* Key Status Pill */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200/80 bg-slate-50/70 px-3.5 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-950/40">
            <div className="flex min-w-0 items-center gap-2">
              <KeyRound size={13} className="text-slate-500 dark:text-zinc-400 shrink-0" />
              <div className="min-w-0 text-slate-600 dark:text-zinc-300 truncate">
                Active Key:{' '}
                {newKey ? (
                  <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                    {newKey.name} (ready to use)
                  </span>
                ) : activeKeys.length > 0 ? (
                  <span className="font-medium text-slate-800 dark:text-zinc-200">
                    {activeKeys[0].name} <code className="text-[11px] text-slate-500 dark:text-zinc-400">({activeKeys[0].key_prefix})</code>
                  </span>
                ) : (
                  <span className="font-medium text-amber-700 dark:text-amber-400">
                    Please create a key in Step 1 first
                  </span>
                )}
              </div>
            </div>
            {newKey && (
              <button
                type="button"
                onClick={() => void handleCopyNewKey()}
                className="btn-secondary btn-sm h-7 shrink-0 text-xs"
              >
                {copiedId === 'new-key' ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
                <span>{isKeyCopied ? 'Copy key again' : 'Copy key'}</span>
              </button>
            )}
          </div>

          {/* ==================== PROVIDER 1: CLAUDE ==================== */}
          {provider === 'claude' && (
            <div className="space-y-4 rounded-xl border border-amber-200/80 bg-gradient-to-b from-amber-50/40 to-slate-50/60 p-4 dark:border-amber-900/40 dark:from-amber-950/20 dark:to-zinc-950/40">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <ClaudeIcon className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                  <div>
                    <h4 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">Connect to Anthropic Claude</h4>
                    <p className="text-xs text-slate-500 dark:text-zinc-400">
                      Choose Claude Desktop (easiest), Claude Code CLI, or Claude.ai Web:
                    </p>
                  </div>
                </div>

                <div className="segmented h-8 bg-white dark:bg-zinc-900">
                  <button
                    type="button"
                    onClick={() => setClaudeMode('desktop')}
                    className={`segmented-item text-xs ${claudeMode === 'desktop' ? 'segmented-item-active' : ''}`}
                  >
                    Claude Desktop (Recommended)
                  </button>
                  <button
                    type="button"
                    onClick={() => setClaudeMode('cli')}
                    className={`segmented-item text-xs ${claudeMode === 'cli' ? 'segmented-item-active' : ''}`}
                  >
                    Claude Code CLI
                  </button>
                  <button
                    type="button"
                    onClick={() => setClaudeMode('web')}
                    className={`segmented-item text-xs ${claudeMode === 'web' ? 'segmented-item-active' : ''}`}
                  >
                    Claude.ai Web
                  </button>
                </div>
              </div>

              {claudeMode === 'desktop' && (
                <div className="space-y-3 pt-1">
                  <div className="rounded-lg border border-emerald-200/70 bg-emerald-50/60 p-2.5 text-xs text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-200 flex items-center gap-2">
                    <Sparkles size={15} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <span><strong>No complex sign-in required!</strong> Claude Desktop connects instantly in 30 seconds on macOS, Windows, and Linux.</span>
                  </div>

                  <ol className="space-y-3 text-xs text-slate-700 dark:text-zinc-300">
                    <li className="flex gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-200 text-[11px] font-bold text-amber-900 dark:bg-amber-900/60 dark:text-amber-200">1</span>
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <span>Locate your Claude Desktop config file:</span>
                        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                          {(['mac', 'windows', 'linux'] as const).map(os => (
                            <button
                              key={os}
                              type="button"
                              onClick={() => setClaudeOs(os)}
                              className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition ${
                                claudeOs === os
                                  ? 'bg-amber-600 text-white dark:bg-amber-500'
                                  : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50 dark:bg-zinc-900 dark:border-zinc-800 dark:text-zinc-400'
                              }`}
                            >
                              {os === 'mac' ? 'macOS' : os === 'windows' ? 'Windows' : 'Linux'}
                            </button>
                          ))}
                        </div>
                        <div className="flex items-center justify-between gap-2 rounded-md bg-white px-2.5 py-1.5 border border-slate-200 dark:bg-zinc-900 dark:border-zinc-800">
                          <code className="min-w-0 truncate font-mono text-[11px] text-slate-700 dark:text-zinc-300">
                            {claudeDesktopPaths[claudeOs]}
                          </code>
                          <button
                            type="button"
                            onClick={() => void copy(claudeDesktopPaths[claudeOs], 'claude-path', 'Path copied')}
                            className="btn-ghost btn-xs shrink-0"
                          >
                            {copiedId === 'claude-path' ? <Check size={11} className="text-emerald-600" /> : <Copy size={11} />}
                            <span>{copiedId === 'claude-path' ? 'Copied' : 'Copy path'}</span>
                          </button>
                        </div>
                      </div>
                    </li>

                    <li className="flex gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-200 text-[11px] font-bold text-amber-900 dark:bg-amber-900/60 dark:text-amber-200">2</span>
                      <div className="min-w-0 flex-1 space-y-1">
                        <span>Paste this configuration into the file:</span>
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
                          <pre className="overflow-x-auto rounded-lg bg-slate-900 px-3.5 py-2.5 font-mono text-xs leading-relaxed text-slate-100 custom-scrollbar dark:border dark:border-zinc-800 dark:bg-black dark:text-zinc-200">
                            <code>{claudeConfigJson}</code>
                          </pre>
                        </div>
                      </div>
                    </li>

                    <li className="flex gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-200 text-[11px] font-bold text-amber-900 dark:bg-amber-900/60 dark:text-amber-200">3</span>
                      <span>Restart Claude Desktop. In any chat, Claude can now list, fill, and save your prompts!</span>
                    </li>
                  </ol>
                </div>
              )}

              {claudeMode === 'cli' && (
                <div className="space-y-3 pt-1">
                  <ol className="space-y-2 text-xs text-slate-700 dark:text-zinc-300">
                    <li className="flex gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-200 text-[11px] font-bold text-amber-900 dark:bg-amber-900/60 dark:text-amber-200">1</span>
                      <span>Run this one command in your terminal:</span>
                    </li>
                  </ol>

                  <div>
                    <div className="mb-1 flex items-center justify-between text-xs font-medium text-slate-600 dark:text-zinc-300">
                      <span>Terminal command</span>
                      <button
                        type="button"
                        onClick={() => void copy(`claude mcp add --transport http prompthold "${copyAuthMcpUrl}"`, 'claude-cli', 'Command copied')}
                        className="btn-ghost btn-sm h-7 px-2 text-xs"
                      >
                        {copiedId === 'claude-cli' ? <Check size={13} className="text-amber-600 dark:text-amber-400" /> : <Copy size={13} />}
                        <span>{copiedId === 'claude-cli' ? 'Copied' : 'Copy command'}</span>
                      </button>
                    </div>
                    <pre className="overflow-x-auto rounded-lg bg-slate-900 px-3.5 py-2.5 font-mono text-xs leading-relaxed text-emerald-300 custom-scrollbar dark:border dark:border-zinc-800 dark:bg-black dark:text-emerald-400">
                      <code>claude mcp add --transport http prompthold "{displayAuthMcpUrl}"</code>
                    </pre>
                  </div>

                  <p className="text-xs text-slate-600 dark:text-zinc-300">
                    Start Claude Code with <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-slate-800 dark:bg-zinc-800 dark:text-zinc-200">claude</code> and run <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-slate-800 dark:bg-zinc-800 dark:text-zinc-200">/mcp</code> to see your PromptHold tools.
                  </p>
                </div>
              )}

              {claudeMode === 'web' && (
                <div className="space-y-3 pt-1">
                  {/* Step-by-step guidance for Claude.ai Web */}
                  <div className="rounded-xl border border-brand-300 bg-brand-50/90 p-3.5 text-xs text-brand-950 dark:border-brand-900/60 dark:bg-brand-950/40 dark:text-brand-200 space-y-2">
                    <div className="flex items-center gap-2 font-bold text-slate-900 dark:text-zinc-100 text-sm">
                      <HelpCircle size={16} className="text-brand-600 dark:text-brand-400 shrink-0" />
                      <span>Which sign-in option to select in Claude.ai?</span>
                    </div>
                    <p className="text-slate-700 dark:text-zinc-300">
                      When Claude asks you to choose an Authentication / Sign-in method:
                    </p>
                    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-white p-2.5 border border-brand-200 dark:bg-zinc-900 dark:border-zinc-800">
                      <span className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-bold text-white shadow-xs">
                        <Check size={13} /> Select "No sign-in"
                      </span>
                      <span className="text-xs font-semibold text-rose-600 dark:text-rose-400">
                        ❌ Do NOT select "OAuth"
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-600 dark:text-zinc-400">
                      <strong>Why?</strong> Your connector URL below already includes your personal security key.
                      Selecting "No sign-in" connects cleanly without asking for an OAuth Client ID or showing <em>"Couldn't register with sign-in service"</em>.
                    </p>
                  </div>

                  <ol className="space-y-3 text-xs text-slate-700 dark:text-zinc-300">
                    <li className="flex gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-200 text-[11px] font-bold text-amber-900 dark:bg-amber-900/60 dark:text-amber-200">1</span>
                      <span>
                        In <strong>Claude.ai</strong>, open <strong>Settings ⚙️</strong> → <strong>Connectors</strong> → click <strong>Add Custom Connector</strong>.
                      </span>
                    </li>
                    <li className="flex gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-200 text-[11px] font-bold text-amber-900 dark:bg-amber-900/60 dark:text-amber-200">2</span>
                      <div className="min-w-0 flex-1 space-y-1">
                        <span>Set <strong>Name</strong> to <code>PromptHold</code> and enter your <strong>Connector URL</strong>:</span>
                        <div className="flex items-center justify-between gap-2 rounded-md bg-white px-2.5 py-1.5 border border-slate-200 dark:bg-zinc-900 dark:border-zinc-800">
                          <code className="min-w-0 truncate font-mono text-[11px] text-amber-700 dark:text-amber-400">
                            {displayAuthMcpUrl}
                          </code>
                          <button
                            type="button"
                            onClick={() => void copy(copyAuthMcpUrl, 'claude-web-url', 'URL copied')}
                            className="btn-ghost btn-xs shrink-0"
                          >
                            {copiedId === 'claude-web-url' ? <Check size={11} className="text-emerald-600" /> : <Copy size={11} />}
                            <span>{copiedId === 'claude-web-url' ? 'Copied' : 'Copy URL'}</span>
                          </button>
                        </div>
                      </div>
                    </li>
                    <li className="flex gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-200 text-[11px] font-bold text-amber-900 dark:bg-amber-900/60 dark:text-amber-200">3</span>
                      <span>
                        Under <strong>Authentication</strong>, select <strong>"No sign-in"</strong>. Click <strong>Add</strong>. You are connected!
                      </span>
                    </li>
                  </ol>
                </div>
              )}

              {/* In-chat example */}
              <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50/80 p-2.5 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                <Sparkles size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-slate-900 dark:text-zinc-100">What to ask Claude in chat:</span>
                    <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                      <ShieldCheck size={11} /> No API key needed in chat
                    </span>
                  </div>
                  <em className="text-slate-800 dark:text-zinc-200 font-sans block font-medium">
                    “Show my available prompt templates in PromptHold”
                  </em>
                  <em className="text-slate-600 dark:text-zinc-400 font-sans block text-[11px]">
                    Or: “Load the 'Customer Support' prompt and fill issue='Login error'”
                  </em>
                </div>
              </div>
            </div>
          )}

          {/* ==================== PROVIDER 2: CHATGPT ==================== */}
          {provider === 'chatgpt' && (
            <div className="space-y-4 rounded-xl border border-emerald-200/80 bg-gradient-to-b from-emerald-50/40 to-slate-50/60 p-4 dark:border-emerald-900/40 dark:from-emerald-950/20 dark:to-zinc-950/40">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <ChatGptIcon className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                  <div>
                    <h4 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">Connect to OpenAI ChatGPT</h4>
                    <p className="text-xs text-slate-500 dark:text-zinc-400">
                      Use Custom GPTs (syncs automatically to Web, iPhone &amp; Android) or the Desktop app:
                    </p>
                  </div>
                </div>

                <div className="segmented h-8 bg-white dark:bg-zinc-900">
                  <button
                    type="button"
                    onClick={() => setChatgptMode('web')}
                    className={`segmented-item text-xs ${chatgptMode === 'web' ? 'segmented-item-active' : ''}`}
                  >
                    Custom GPT (Web &amp; Mobile)
                  </button>
                  <button
                    type="button"
                    onClick={() => setChatgptMode('desktop')}
                    className={`segmented-item text-xs ${chatgptMode === 'desktop' ? 'segmented-item-active' : ''}`}
                  >
                    Desktop App
                  </button>
                </div>
              </div>

              {chatgptMode === 'web' && (
                <div className="space-y-3 pt-1">
                  <div className="rounded-lg border border-emerald-200/70 bg-emerald-50/60 p-2.5 text-xs text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-200 flex items-center gap-2">
                    <Smartphone size={15} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <span><strong>Cross-device sync:</strong> Setting this up once in ChatGPT Web makes your PromptHold prompts available on your iPhone and Android too!</span>
                  </div>

                  <ol className="space-y-2.5 text-xs text-slate-700 dark:text-zinc-300">
                    <li className="flex gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-200 text-[11px] font-bold text-emerald-900 dark:bg-emerald-900/60 dark:text-emerald-200">1</span>
                      <span>
                        On <strong>chatgpt.com</strong>, click <strong>Explore GPTs</strong> → <strong>+ Create</strong> (or edit your GPT) → click the <strong>Configure</strong> tab.
                      </span>
                    </li>
                    <li className="flex gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-200 text-[11px] font-bold text-emerald-900 dark:bg-emerald-900/60 dark:text-emerald-200">2</span>
                      <span>Scroll down to <strong>Actions</strong> and click <strong>Create new action</strong>.</span>
                    </li>
                    <li className="flex gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-200 text-[11px] font-bold text-emerald-900 dark:bg-emerald-900/60 dark:text-emerald-200">3</span>
                      <div className="min-w-0 flex-1 space-y-1">
                        <span>Under <strong>Authentication</strong>, choose <strong>API Key</strong> (Auth Type: <strong>Bearer</strong>) and paste your key:</span>
                        <div className="flex items-center justify-between gap-2 rounded-md bg-white px-2.5 py-1.5 border border-slate-200 dark:bg-zinc-900 dark:border-zinc-800">
                          <code className="min-w-0 truncate font-mono text-[11px] text-emerald-700 dark:text-emerald-400">
                            {displaySnippetKey}
                          </code>
                          <button
                            type="button"
                            onClick={() => void copy(copySnippetKey, 'gpt-key', 'API key copied')}
                            className="btn-ghost btn-xs shrink-0"
                          >
                            {copiedId === 'gpt-key' ? <Check size={11} className="text-emerald-600" /> : <Copy size={11} />}
                            <span>{copiedId === 'gpt-key' ? 'Copied' : 'Copy Key'}</span>
                          </button>
                        </div>
                      </div>
                    </li>
                    <li className="flex gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-200 text-[11px] font-bold text-emerald-900 dark:bg-emerald-900/60 dark:text-emerald-200">4</span>
                      <div className="min-w-0 flex-1 space-y-1">
                        <span>Under <strong>Schema</strong>, import this OpenAPI URL:</span>
                        <div className="flex items-center justify-between gap-2 rounded-md bg-white px-2.5 py-1.5 border border-slate-200 dark:bg-zinc-900 dark:border-zinc-800">
                          <code className="min-w-0 truncate font-mono text-[11px] text-slate-700 dark:text-zinc-300">
                            {openApiUrl}
                          </code>
                          <button
                            type="button"
                            onClick={() => void copy(openApiUrl, 'gpt-schema', 'Schema URL copied')}
                            className="btn-ghost btn-xs shrink-0"
                          >
                            {copiedId === 'gpt-schema' ? <Check size={11} className="text-emerald-600" /> : <Copy size={11} />}
                            <span>{copiedId === 'gpt-schema' ? 'Copied' : 'Copy URL'}</span>
                          </button>
                        </div>
                      </div>
                    </li>
                  </ol>
                </div>
              )}

              {chatgptMode === 'desktop' && (
                <div className="space-y-3 pt-1">
                  <ol className="space-y-2 text-xs text-slate-700 dark:text-zinc-300">
                    <li className="flex gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-200 text-[11px] font-bold text-emerald-900 dark:bg-emerald-900/60 dark:text-emerald-200">1</span>
                      <span>In ChatGPT Desktop, open <strong>Settings</strong> → <strong>Developer Mode</strong> (toggle ON).</span>
                    </li>
                    <li className="flex gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-200 text-[11px] font-bold text-emerald-900 dark:bg-emerald-900/60 dark:text-emerald-200">2</span>
                      <span>Click <strong>MCP Servers</strong> → <strong>+ Add Server</strong> with:</span>
                    </li>
                  </ol>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="rounded-lg border border-slate-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-900">
                      <div className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-zinc-500">Name</div>
                      <code className="text-xs font-semibold text-slate-800 dark:text-zinc-200">prompthold</code>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-900">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-zinc-500">Server URL</span>
                        <button
                          type="button"
                          onClick={() => void copy(copyAuthMcpUrl, 'chatgpt-desktop-url', 'URL copied')}
                          className="btn-ghost btn-xs text-[10px]"
                        >
                          {copiedId === 'chatgpt-desktop-url' ? <Check size={11} className="text-emerald-600" /> : <Copy size={11} />}
                          <span>{copiedId === 'chatgpt-desktop-url' ? 'Copied' : 'Copy'}</span>
                        </button>
                      </div>
                      <code className="truncate text-xs font-semibold text-slate-800 dark:text-zinc-200 block">
                        {displayAuthMcpUrl}
                      </code>
                    </div>
                  </div>
                </div>
              )}

              {/* In-chat example */}
              <div className="flex items-start gap-2.5 rounded-lg border border-emerald-200 bg-emerald-50/80 p-2.5 text-xs text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200">
                <Sparkles size={14} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-slate-900 dark:text-zinc-100">What to ask ChatGPT in chat:</span>
                    <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                      <ShieldCheck size={11} /> No API key needed in chat
                    </span>
                  </div>
                  <em className="text-slate-800 dark:text-zinc-200 font-sans block font-medium">
                    “Search PromptHold for the 'Customer Onboarding' prompt and substitute client_name='Acme Corp'”
                  </em>
                </div>
              </div>
            </div>
          )}

          {/* ==================== PROVIDER 3: GOOGLE GEMINI ==================== */}
          {provider === 'gemini' && (
            <div className="space-y-4 rounded-xl border border-indigo-200/80 bg-gradient-to-b from-indigo-50/40 to-slate-50/60 p-4 dark:border-indigo-900/40 dark:from-indigo-950/20 dark:to-zinc-950/40">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <GeminiIcon className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                  <div>
                    <h4 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">Connect to Google Gemini</h4>
                    <p className="text-xs text-slate-500 dark:text-zinc-400">
                      Use in Gemini Web &amp; Mobile App, or in Python scripts via GenAI SDK:
                    </p>
                  </div>
                </div>

                <div className="segmented h-8 bg-white dark:bg-zinc-900">
                  <button
                    type="button"
                    onClick={() => setGeminiMode('app')}
                    className={`segmented-item text-xs ${geminiMode === 'app' ? 'segmented-item-active' : ''}`}
                  >
                    Gemini App (Web, Android &amp; iPhone)
                  </button>
                  <button
                    type="button"
                    onClick={() => setGeminiMode('sdk')}
                    className={`segmented-item text-xs ${geminiMode === 'sdk' ? 'segmented-item-active' : ''}`}
                  >
                    Python SDK (Developers)
                  </button>
                </div>
              </div>

              {geminiMode === 'app' && (
                <div className="space-y-3 pt-1">
                  <div className="rounded-lg border border-indigo-200/70 bg-indigo-50/60 p-2.5 text-xs text-indigo-900 dark:border-indigo-900/40 dark:bg-indigo-950/30 dark:text-indigo-200 flex items-center gap-2">
                    <Smartphone size={15} className="shrink-0 text-indigo-600 dark:text-indigo-400" />
                    <span><strong>Gemini Connected Apps:</strong> Link once at <strong>gemini.google.com</strong> and use PromptHold across both Gemini Web and the Gemini Mobile App on Android and iOS!</span>
                  </div>

                  <ol className="space-y-2.5 text-xs text-slate-700 dark:text-zinc-300">
                    <li className="flex gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-200 text-[11px] font-bold text-indigo-900 dark:bg-indigo-900/60 dark:text-indigo-200">1</span>
                      <span>
                        Open <strong><a href="https://gemini.google.com" target="_blank" rel="noreferrer" className="underline font-semibold text-indigo-700 dark:text-indigo-400 inline-flex items-center gap-0.5">gemini.google.com <ExternalLink size={10} /></a></strong> on your computer or mobile browser.
                      </span>
                    </li>
                    <li className="flex gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-200 text-[11px] font-bold text-indigo-900 dark:bg-indigo-900/60 dark:text-indigo-200">2</span>
                      <span>
                        Click <strong>Settings ⚙️</strong> → <strong>Connected Apps</strong> (or Extensions) → click <strong>Add Connected App</strong>.
                      </span>
                    </li>
                    <li className="flex gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-200 text-[11px] font-bold text-indigo-900 dark:bg-indigo-900/60 dark:text-indigo-200">3</span>
                      <div className="min-w-0 flex-1 space-y-1">
                        <span>Set Name to <strong>PromptHold</strong> and enter your Server URL:</span>
                        <div className="flex items-center justify-between gap-2 rounded-md bg-white px-2.5 py-1.5 border border-slate-200 dark:bg-zinc-900 dark:border-zinc-800">
                          <code className="min-w-0 truncate font-mono text-[11px] text-indigo-700 dark:text-indigo-400">
                            {displayAuthMcpUrl}
                          </code>
                          <button
                            type="button"
                            onClick={() => void copy(copyAuthMcpUrl, 'gemini-url', 'Server URL copied')}
                            className="btn-ghost btn-xs shrink-0"
                          >
                            {copiedId === 'gemini-url' ? <Check size={11} className="text-emerald-600" /> : <Copy size={11} />}
                            <span>{copiedId === 'gemini-url' ? 'Copied' : 'Copy URL'}</span>
                          </button>
                        </div>
                        <p className="text-[11px] text-slate-500 dark:text-zinc-400 pt-0.5">
                          💡 Your personal URL automatically authenticates your account in the background.
                        </p>
                      </div>
                    </li>
                  </ol>

                  {/* In-chat example */}
                  <div className="flex items-start gap-2.5 rounded-lg border border-indigo-200 bg-indigo-50/80 p-2.5 text-xs text-indigo-900 dark:border-indigo-900/50 dark:bg-indigo-950/30 dark:text-indigo-200">
                    <Sparkles size={14} className="mt-0.5 shrink-0 text-indigo-600 dark:text-indigo-400" />
                    <div className="space-y-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-slate-900 dark:text-zinc-100">What to ask Gemini on Web or Mobile:</span>
                        <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                          <ShieldCheck size={11} /> No API key needed in chat
                        </span>
                      </div>
                      <em className="text-slate-800 dark:text-zinc-200 font-sans block font-medium">
                        “@PromptHold show my active Marketing templates”
                      </em>
                    </div>
                  </div>
                </div>
              )}

              {geminiMode === 'sdk' && (
                <div className="space-y-3 pt-1">
                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-xs font-medium text-slate-600 dark:text-zinc-300">
                        Python script (google-genai SDK)
                      </span>
                      <button
                        type="button"
                        onClick={() => void copy(geminiPythonSnippet, 'gemini-sdk', 'Code copied')}
                        className="btn-ghost btn-sm h-7 px-2 text-xs"
                      >
                        {copiedId === 'gemini-sdk' ? <Check size={13} className="text-indigo-600 dark:text-indigo-400" /> : <Copy size={13} />}
                        <span>{copiedId === 'gemini-sdk' ? 'Copied' : 'Copy code'}</span>
                      </button>
                    </div>
                    <pre className="overflow-x-auto rounded-lg bg-slate-900 px-3.5 py-2.5 font-mono text-xs leading-relaxed text-slate-100 custom-scrollbar dark:border dark:border-zinc-800 dark:bg-black dark:text-zinc-200">
                      <code>{geminiPythonSnippet}</code>
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ==================== PROVIDER 4: CURSOR & IDES ==================== */}
          {provider === 'cursor' && (
            <div className="space-y-4 rounded-xl border border-cyan-200/80 bg-gradient-to-b from-cyan-50/40 to-slate-50/60 p-4 dark:border-cyan-900/40 dark:from-cyan-950/20 dark:to-zinc-950/40">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <CursorIcon className="h-5 w-5 text-cyan-600 dark:text-cyan-400" />
                  <div>
                    <h4 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">Connect to Cursor &amp; Coding IDEs</h4>
                    <p className="text-xs text-slate-500 dark:text-zinc-400">
                      Use prompts directly in Cursor Chat, Composer, or VS Code Cline:
                    </p>
                  </div>
                </div>

                <div className="segmented h-8 bg-white dark:bg-zinc-900">
                  <button
                    type="button"
                    onClick={() => setCursorMode('cursor')}
                    className={`segmented-item text-xs ${cursorMode === 'cursor' ? 'segmented-item-active' : ''}`}
                  >
                    Cursor IDE
                  </button>
                  <button
                    type="button"
                    onClick={() => setCursorMode('vscode')}
                    className={`segmented-item text-xs ${cursorMode === 'vscode' ? 'segmented-item-active' : ''}`}
                  >
                    VS Code (Cline / Roo)
                  </button>
                </div>
              </div>

              {cursorMode === 'cursor' && (
                <div className="space-y-3 pt-1">
                  <div className="rounded-lg border border-cyan-200/70 bg-cyan-50/60 p-2.5 text-xs text-cyan-900 dark:border-cyan-900/40 dark:bg-cyan-950/30 dark:text-cyan-200 flex items-center gap-2">
                    <Sparkles size={15} className="shrink-0 text-cyan-600 dark:text-cyan-400" />
                    <span><strong>1-Click Desktop Bridge:</strong> Using <code>mcp-remote</code> handles background reconnection and SSL handshakes seamlessly without network drops.</span>
                  </div>

                  <ol className="space-y-2.5 text-xs text-slate-700 dark:text-zinc-300">
                    <li className="flex gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cyan-200 text-[11px] font-bold text-cyan-900 dark:bg-cyan-900/60 dark:text-cyan-200">1</span>
                      <span>
                        In Cursor, open <strong>Settings</strong> (gear icon or <code className="font-mono">Cmd+,</code> / <code className="font-mono">Ctrl+,</code>) → <strong>Features</strong> → <strong>MCP Servers</strong>.
                      </span>
                    </li>
                    <li className="flex gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cyan-200 text-[11px] font-bold text-cyan-900 dark:bg-cyan-900/60 dark:text-cyan-200">2</span>
                      <div className="min-w-0 flex-1 space-y-1">
                        <span>Click <strong>+ Add New MCP Server</strong> and enter:</span>
                        <div className="grid gap-2 sm:grid-cols-3 pt-1">
                          <div className="rounded-lg border border-slate-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-900">
                            <div className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-zinc-500">Name</div>
                            <code className="text-xs font-semibold text-slate-800 dark:text-zinc-200">prompthold</code>
                          </div>
                          <div className="rounded-lg border border-slate-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-900">
                            <div className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-zinc-500">Type</div>
                            <code className="text-xs font-semibold text-slate-800 dark:text-zinc-200">command</code>
                          </div>
                          <div className="rounded-lg border border-slate-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-900">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-zinc-500">Command</span>
                              <button
                                type="button"
                                onClick={() => void copy(`npx -y mcp-remote "${copyAuthMcpUrl}"`, 'cursor-cmd', 'Command copied')}
                                className="btn-ghost btn-xs text-[10px]"
                              >
                                {copiedId === 'cursor-cmd' ? <Check size={11} className="text-cyan-600" /> : <Copy size={11} />}
                                <span>{copiedId === 'cursor-cmd' ? 'Copied' : 'Copy'}</span>
                              </button>
                            </div>
                            <code className="truncate text-xs font-semibold text-slate-800 dark:text-zinc-200 block">
                              npx -y mcp-remote "{displayAuthMcpUrl}"
                            </code>
                          </div>
                        </div>
                      </div>
                    </li>
                  </ol>

                  {/* Or config JSON */}
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
                    <pre className="overflow-x-auto rounded-lg bg-slate-900 px-3.5 py-2.5 font-mono text-xs leading-relaxed text-slate-100 custom-scrollbar dark:border dark:border-zinc-800 dark:bg-black dark:text-zinc-200">
                      <code>{cursorMcpConfigJson}</code>
                    </pre>
                  </div>

                  <p className="text-[11px] text-slate-500 dark:text-zinc-400">
                    💡 If using direct SSE mode: set <strong>Type: sse</strong> and URL to <code className="font-mono text-cyan-600 dark:text-cyan-400">{copyAuthSseUrl}</code>.
                  </p>
                </div>
              )}

              {cursorMode === 'vscode' && (
                <div className="space-y-3 pt-1">
                  <ol className="space-y-2 text-xs text-slate-700 dark:text-zinc-300">
                    <li className="flex gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cyan-200 text-[11px] font-bold text-cyan-900 dark:bg-cyan-900/60 dark:text-cyan-200">1</span>
                      <span>In Cline or Roo Code settings, paste this into your MCP configuration:</span>
                    </li>
                  </ol>

                  <div>
                    <div className="mb-1 flex items-center justify-between text-xs font-medium text-slate-600 dark:text-zinc-300">
                      <span>cline_mcp_settings.json</span>
                      <button
                        type="button"
                        onClick={() => void copy(clineConfigJson, 'cline-json', 'Configuration copied')}
                        className="btn-ghost btn-sm h-7 px-2 text-xs"
                      >
                        {copiedId === 'cline-json' ? <Check size={13} className="text-cyan-600 dark:text-cyan-400" /> : <Copy size={13} />}
                        <span>{copiedId === 'cline-json' ? 'Copied' : 'Copy config'}</span>
                      </button>
                    </div>
                    <pre className="overflow-x-auto rounded-lg bg-slate-900 px-3.5 py-2.5 font-mono text-xs leading-relaxed text-slate-100 custom-scrollbar dark:border dark:border-zinc-800 dark:bg-black dark:text-zinc-200">
                      <code>{clineConfigJson}</code>
                    </pre>
                  </div>
                </div>
              )}

              {/* In-chat example */}
              <div className="flex items-start gap-2.5 rounded-lg border border-cyan-200 bg-cyan-50/80 p-2.5 text-xs text-cyan-900 dark:border-cyan-900/50 dark:bg-cyan-950/30 dark:text-cyan-200">
                <Sparkles size={14} className="mt-0.5 shrink-0 text-cyan-600 dark:text-cyan-400" />
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-slate-900 dark:text-zinc-100">What to ask in Cursor Chat (Cmd+L / Composer):</span>
                    <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                      <ShieldCheck size={11} /> No API key needed in chat
                    </span>
                  </div>
                  <em className="text-slate-800 dark:text-zinc-200 font-sans block font-medium">
                    “Use PromptHold to load my 'Code Review' prompt and review this file”
                  </em>
                </div>
              </div>
            </div>
          )}

          {/* ==================== PROVIDER 5: API & SCRIPTS ==================== */}
          {provider === 'api' && (
            <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50/60 p-4 dark:border-zinc-800 dark:bg-zinc-950/40">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Terminal className="h-5 w-5 text-slate-700 dark:text-zinc-300" />
                  <div>
                    <h4 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">REST API &amp; Python Scripts</h4>
                    <p className="text-xs text-slate-500 dark:text-zinc-400">
                      Query prompts and substitute variables from your own automated pipelines:
                    </p>
                  </div>
                </div>

                <div className="segmented h-8 bg-white dark:bg-zinc-900">
                  <button
                    type="button"
                    onClick={() => setApiMode('python')}
                    className={`segmented-item text-xs ${apiMode === 'python' ? 'segmented-item-active' : ''}`}
                  >
                    Python
                  </button>
                  <button
                    type="button"
                    onClick={() => setApiMode('curl')}
                    className={`segmented-item text-xs ${apiMode === 'curl' ? 'segmented-item-active' : ''}`}
                  >
                    cURL
                  </button>
                </div>
              </div>

              {/* Notice explaining why previous python code returned HTML */}
              <div className="rounded-lg border border-blue-200 bg-blue-50/80 p-3 text-xs text-blue-900 dark:border-blue-900/40 dark:bg-blue-950/30 dark:text-blue-200 space-y-1">
                <div className="flex items-center gap-1.5 font-semibold text-blue-950 dark:text-blue-100">
                  <Info size={14} className="shrink-0 text-blue-600 dark:text-blue-400" />
                  <span>Always use the live API gateway URL:</span>
                </div>
                <p>
                  If a script ever returned an HTML webpage instead of JSON, it was hitting the static frontend (<code>prompthold.pages.dev</code>).
                  The script below queries the real backend API (<code>{restUrl}</code>) which always returns clean JSON.
                </p>
              </div>

              <div className="space-y-3 pt-1">
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-600 dark:text-zinc-300">
                      {apiMode === 'python' ? 'Python script' : 'cURL command'}
                    </span>
                    <button
                      type="button"
                      onClick={() => void copy(apiMode === 'python' ? pythonSnippet : curlSnippet, `code-${apiMode}`, 'Code copied')}
                      className="btn-ghost btn-sm h-7 px-2 text-xs"
                    >
                      {copiedId === `code-${apiMode}` ? <Check size={13} className="text-brand-600 dark:text-brand-400" /> : <Copy size={13} />}
                      <span>{copiedId === `code-${apiMode}` ? 'Copied' : 'Copy code'}</span>
                    </button>
                  </div>
                  <pre className="overflow-x-auto rounded-lg bg-slate-900 px-3.5 py-2.5 font-mono text-xs leading-relaxed text-slate-100 custom-scrollbar dark:border dark:border-zinc-800 dark:bg-black dark:text-zinc-200">
                    <code>{apiMode === 'python' ? pythonSnippet : curlSnippet}</code>
                  </pre>
                </div>

                <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
                  <p>
                    <strong>API Filtering:</strong> Filter prompts by space using <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] text-slate-700 dark:bg-zinc-800 dark:text-zinc-300">?group_id=&lt;id&gt;</code> or search titles with <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] text-slate-700 dark:bg-zinc-800 dark:text-zinc-300">?search=&lt;query&gt;</code>.
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
