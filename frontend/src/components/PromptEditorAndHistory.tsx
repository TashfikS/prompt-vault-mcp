import { useEffect, useState } from 'react'
import {
  ArrowLeftRight,
  Check,
  CheckCheck,
  Clipboard,
  CopyPlus,
  FileCheck,
  FileUp,
  History,
  RotateCcw,
  Save,
  Send,
  Shield,
  Sparkles,
  X,
} from 'lucide-react'
import { api, approveProposal, getProposals, getVersions, rejectProposal } from '../api'
import type { Group, GroupRole, PromptItem, PromptProposalItem, PromptVersionItem, User } from '../types'
import { accessFor } from '../access'
import DuplicatePromptModal from './DuplicatePromptModal'
import FileUploadModal from './FileUploadModal'
import VisualDiffViewer from './VisualDiffViewer'
import { PromptText, timeAgo } from './ui/Brand'
import Modal from './ui/Modal'
import RoleBadge from './ui/RoleBadge'
import { useToast } from './ui/Toast'
import AutoGrowingTextarea from './ui/AutoGrowingTextarea'

type Tab = 'use' | 'history' | 'diff' | 'proposals'

export default function PromptEditorAndHistory({
  prompt,
  groups,
  prompts,
  activeUser,
  onClose,
  onChanged,
}: {
  prompt: PromptItem
  groups: Group[]
  prompts: PromptItem[]
  activeUser: User | null
  onClose: () => void
  onChanged: () => void
}) {
  const notify = useToast()
  const [tab, setTab] = useState<Tab>('use')
  const [content, setContent] = useState(prompt.content)
  const [title, setTitle] = useState(prompt.title)
  const [note, setNote] = useState('Updated prompt')
  const [versions, setVersions] = useState<PromptVersionItem[]>([])
  const [proposals, setProposals] = useState<PromptProposalItem[]>([])
  const [compareBase, setCompareBase] = useState<number | undefined>()
  const [values, setValues] = useState<Record<string, string>>({})
  const [uploadOpen, setUploadOpen] = useState(false)
  const [duplicateOpen, setDuplicateOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [versionToRestore, setVersionToRestore] = useState<PromptVersionItem | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [processingProposalId, setProcessingProposalId] = useState<string | null>(null)

  const currentGroup = groups.find(g => g.id === prompt.group_id)
  const currentMembership = currentGroup?.members.find(m => m.user_id === activeUser?.id)
  const isPersonal = Boolean(currentGroup?.is_personal)
  const isAdmin = Boolean(activeUser?.is_workspace_admin)
  const userRole: GroupRole = isPersonal || isAdmin ? 'GROUP_MANAGER' : (currentMembership?.role ?? 'GUEST')
  const isGuest = userRole === 'GUEST'
  const canManageActiveVersion = isAdmin || isPersonal || userRole === 'GROUP_MANAGER'
  const isProposalWorkflow = !canManageActiveVersion && !isGuest
  const roleKind = accessFor(currentGroup, activeUser)

  useEffect(() => {
    if (uploadOpen || versionToRestore || duplicateOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, uploadOpen, versionToRestore, duplicateOpen])

  const variables = Array.from(
    new Set(
      content.match(/\{\{\s*([a-zA-Z0-9_ -]+)\s*\}\}/g)?.map(match => match.replace(/\{\{|\}\}/g, '').trim()) ?? []
    )
  )
  const compiled = content.replace(
    /\{\{\s*([a-zA-Z0-9_ -]+)\s*\}\}/g,
    (match, key: string) => values[key.trim()] || match
  )
  const hasFilledValues = variables.some(k => Boolean(values[k]?.trim()))

  async function copyPrompt() {
    await navigator.clipboard.writeText(compiled)
    setCopied(true)
    notify('Compiled prompt copied')
    setTimeout(() => setCopied(false), 1600)
  }

  async function reload() {
    const rows = await getVersions(prompt.id)
    setVersions(rows)
  }

  async function reloadProposals() {
    try {
      const list = await getProposals(prompt.id)
      setProposals(list)
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    setContent(prompt.content)
    setTitle(prompt.title)
    void reload().catch(e => notify(e.message, { tone: 'error' }))
    void reloadProposals()
  }, [prompt.id, prompt.current_version_number])

  async function save() {
    try {
      const res = await api<{ proposal_created?: boolean; proposal_id?: string; message?: string }>(
        `/api/prompts/${prompt.id}`,
        { method: 'PUT', body: JSON.stringify({ title, content, change_note: note }) }
      )
      if (res.proposal_created) {
        notify('Review request submitted', { description: 'Team members and owners can now review and approve your edit.' })
        await reloadProposals()
        setTab('proposals')
      } else {
        notify('New version published', { description: `Saved changes to “${title}”.` })
        await reload()
        onChanged()
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not save the prompt.', { tone: 'error' })
    }
  }

  async function confirmRestore() {
    if (!versionToRestore) return
    setRestoring(true)
    try {
      await api(`/api/prompts/${prompt.id}/rollback/${versionToRestore.version_number}`, { method: 'POST' })
      notify(`Active version switched to v${versionToRestore.version_number}`)
      setContent(versionToRestore.content)
      setVersionToRestore(null)
      await reload()
      onChanged()
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not activate this version.', { tone: 'error' })
    } finally {
      setRestoring(false)
    }
  }

  async function handleApprove(proposalId: string) {
    setProcessingProposalId(proposalId)
    try {
      const res = await approveProposal(proposalId)
      if (res.merged) {
        notify('Review request approved & merged', { description: `Version ${res.version_number ?? ''} is now active.` })
        await reload()
        onChanged()
      } else {
        notify(`Approval recorded (${res.approvals_count} of ${res.required_approvals} required)`)
      }
      await reloadProposals()
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Failed to approve review request.', { tone: 'error' })
    } finally {
      setProcessingProposalId(null)
    }
  }

  async function handleReject(proposalId: string) {
    setProcessingProposalId(proposalId)
    try {
      await rejectProposal(proposalId)
      notify('Review request rejected', { tone: 'info' })
      await reloadProposals()
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Failed to reject review request.', { tone: 'error' })
    } finally {
      setProcessingProposalId(null)
    }
  }

  const activeVersion = versions.find(v => v.version_number === prompt.current_version_number)
  const otherVersions = versions
    .filter(v => v.version_number !== prompt.current_version_number)
    .sort((a, b) => b.version_number - a.version_number)
  const rankedVersions = activeVersion ? [activeVersion, ...otherVersions] : versions

  const pendingCount = proposals.filter(p => p.status === 'PENDING').length

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'use', label: isGuest ? 'View & test prompt' : 'Use & edit prompt' },
    { id: 'history', label: 'Version history', count: versions.length },
    { id: 'diff', label: 'Visual changes' },
    { id: 'proposals', label: 'Review requests', count: pendingCount || undefined },
  ]

  return (
    <div
      className="fixed inset-0 z-40 overflow-y-auto bg-black/60 p-3 backdrop-blur-[2px] sm:p-6"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={prompt.title}
        className="mx-auto my-2 flex min-h-[calc(100dvh-1.5rem)] max-w-6xl flex-col xl:max-w-7xl animate-pop-in overflow-hidden sm:min-h-[calc(100dvh-6rem)] rounded-2xl bg-[#f6f7f9] shadow-pop ring-1 ring-slate-900/5 dark:bg-zinc-950 dark:ring-zinc-800 dark:border dark:border-zinc-800 sm:my-6"
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 bg-white px-5 py-5 sm:px-7 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-slate-500 dark:text-zinc-400">
              <span className="rounded-md bg-slate-100 px-2 py-0.5 font-semibold text-slate-700 dark:bg-zinc-800 dark:text-zinc-300">{prompt.group_name}</span>
              <span>·</span>
              <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 font-semibold text-emerald-800 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-950/60 dark:text-emerald-300 dark:ring-emerald-500/30">
                Active · v{prompt.current_version_number}
              </span>
              <RoleBadge kind={roleKind} size="sm" side="bottom" />
            </div>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950 dark:text-zinc-50 sm:text-2xl">{prompt.title}</h2>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-zinc-400">
              {prompt.description || 'Fill in dynamic fields, inspect version history, or compare changes.'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!isGuest && (
              <button
                type="button"
                onClick={() => setDuplicateOpen(true)}
                className="btn-secondary btn-sm"
                title="Duplicate or move this prompt to another space"
                aria-label="Duplicate prompt"
              >
                <CopyPlus size={14} /> <span className="hidden sm:inline">Duplicate</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary btn-sm"
              aria-label="Close prompt"
            >
              <X size={15} /> <span className="hidden sm:inline">Close</span>
            </button>
          </div>
        </header>

        <nav role="tablist" aria-label="Prompt sections" className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-5 sm:px-7 dark:border-zinc-800 dark:bg-zinc-900">
          {tabs.map(item => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={e => { setTab(item.id); e.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }) }}
              className={`inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium transition ${
                tab === item.id
                  ? 'border-brand-600 text-brand-700 dark:border-brand-400 dark:text-brand-300'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              {item.label}
              {item.count !== undefined && (
                <span className={`rounded-full px-1.5 py-px text-[11px] tabular-nums ${
                  tab === item.id ? 'bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300' : 'bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400'
                }`}>
                  {item.count}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="p-5 sm:p-7">
          {tab === 'use' && (
            <div>
              {isGuest && (
                <div className="mb-5 flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
                  <div className="flex items-center gap-2.5">
                    <Shield size={16} className="shrink-0 text-amber-600 dark:text-amber-400" />
                    <span>
                      <strong className="font-semibold text-amber-950 dark:text-amber-100">Guest view-only access:</strong> You can fill in fields and copy the compiled prompt, but editing and file uploads are disabled.
                    </span>
                  </div>
                  <RoleBadge kind="GUEST" size="sm" side="bottom" />
                </div>
              )}
              {isProposalWorkflow && (
                <div className="mb-5 flex items-center justify-between gap-3 rounded-xl border border-brand-200 bg-brand-50/70 px-4 py-3 text-xs text-brand-900 dark:border-brand-900/50 dark:bg-brand-950/40 dark:text-brand-200">
                  <div className="flex items-center gap-2.5">
                    <FileCheck size={16} className="shrink-0 text-brand-600 dark:text-brand-400" />
                    <span>
                      <strong className="font-semibold text-brand-950 dark:text-brand-100">Review workflow:</strong> Edits you submit create a review request. Once approved ({currentGroup?.required_approvals ?? 1} required), your change becomes the next active version.
                    </span>
                  </div>
                  <RoleBadge kind={roleKind} size="sm" side="bottom" />
                </div>
              )}

              <div className="grid gap-6 lg:grid-cols-[minmax(0,1.75fr)_minmax(340px,1.1fr)] xl:grid-cols-[minmax(0,1.9fr)_minmax(360px,1.15fr)] items-start">
                <div className="card flex flex-col p-5 sm:p-6 shadow-sm">
                  <div className={`grid gap-3.5 ${isGuest ? '' : 'sm:grid-cols-2'}`}>
                    <div>
                      <label className="field-label" htmlFor="ed-title">Prompt title</label>
                      <input
                        id="ed-title"
                        readOnly={isGuest}
                        disabled={isGuest}
                        value={title}
                        onChange={e => setTitle(e.target.value)}
                        className="field font-medium text-slate-900 dark:text-zinc-100"
                      />
                    </div>
                    {!isGuest && (
                      <div>
                        <label className="field-label" htmlFor="ed-note">Change note</label>
                        <input
                          id="ed-note"
                          value={note}
                          onChange={e => setNote(e.target.value)}
                          placeholder="Brief summary of edits…"
                          className="field"
                        />
                      </div>
                    )}
                  </div>

                  <div className="mt-4 flex flex-1 flex-col">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <label className="text-sm font-semibold text-slate-800 dark:text-zinc-200" htmlFor="ed-content">
                          Prompt template
                        </label>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-zinc-800 dark:text-zinc-400">
                          {content.split('\n').length} {content.split('\n').length === 1 ? 'line' : 'lines'} · {content.length.toLocaleString()} chars
                        </span>
                        {variables.length > 0 && (
                          <span className="hidden sm:inline-flex items-center rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700 ring-1 ring-inset ring-brand-600/15 dark:bg-brand-950/60 dark:text-brand-300 dark:ring-brand-500/30">
                            {variables.length} dynamic field{variables.length === 1 ? '' : 's'}
                          </span>
                        )}
                      </div>
                      {!isGuest && <span className="text-xs text-slate-500 dark:text-zinc-400">
                        Use <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-brand-700 ring-1 ring-slate-200 dark:bg-zinc-800 dark:text-brand-300 dark:ring-zinc-700">{'{{field_name}}'}</code> for dynamic fields
                      </span>}
                    </div>
                    <textarea
                      id="ed-content"
                      readOnly={isGuest}
                      disabled={isGuest}
                      value={content}
                      onChange={e => setContent(e.target.value)}
                      className="field min-h-[260px] sm:min-h-[320px] lg:min-h-[380px] flex-1 resize-y font-mono text-[13px] leading-6 custom-scrollbar"
                      placeholder="Write your prompt template here. Use {{variable_name}} for dynamic placeholders…"
                    />
                  </div>

                  {!isGuest && (
                    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 dark:border-zinc-800 pt-4">
                      <div className="flex flex-wrap gap-2.5">
                        <button
                          type="button"
                          onClick={() => void save()}
                          className="btn-primary"
                        >
                          {isProposalWorkflow ? <Send size={15} /> : <Save size={15} />}
                          {isProposalWorkflow ? 'Submit review request' : 'Save new version'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setUploadOpen(true)}
                          className="btn-secondary"
                          title="Upload a text or Markdown file (.txt, .md • max 1 MB) as the new version"
                        >
                          <FileUp size={15} /> {isProposalWorkflow ? 'Upload file for review' : 'Upload file as version'}
                        </button>
                      </div>
                      {variables.length > 0 && (
                        <span className="hidden xl:inline-block text-xs text-slate-400 dark:text-zinc-500">
                          Fill test values in the side panel to test live →
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Live personalizer & preview */}
                <aside className="card flex flex-col justify-between p-5 sm:p-6 shadow-sm">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-zinc-100">
                        <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
                          <Sparkles size={15} />
                        </span>
                        <span>Personalize &amp; test</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {variables.length > 0 && (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:bg-zinc-800 dark:text-zinc-400">
                            {variables.length} field{variables.length === 1 ? '' : 's'}
                          </span>
                        )}
                        {hasFilledValues && (
                          <button
                            type="button"
                            onClick={() => setValues({})}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 transition"
                            title="Clear all test inputs"
                          >
                            <RotateCcw size={11} /> Clear values
                          </button>
                        )}
                      </div>
                    </div>
                    <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">
                      Fill dynamic fields below to compile and test. Inputs expand vertically as you type longer content.
                    </p>

                    {variables.length ? (
                      <div className="mt-3.5 max-h-[380px] sm:max-h-[440px] overflow-y-auto pr-1.5 space-y-2.5 custom-scrollbar">
                        {variables.map(key => {
                          const val = values[key] ?? ''
                          return (
                            <div
                              key={key}
                              className="rounded-xl border border-slate-200/80 bg-slate-50/60 p-2.5 transition focus-within:border-brand-500 focus-within:bg-white focus-within:ring-1 focus-within:ring-brand-500/20 dark:border-zinc-800 dark:bg-zinc-950/60 dark:focus-within:border-brand-400 dark:focus-within:bg-zinc-900"
                            >
                              <div className="mb-1 flex items-center justify-between gap-1.5">
                                <label
                                  className="truncate text-xs font-semibold capitalize text-slate-700 dark:text-zinc-300"
                                  htmlFor={`var-${key}`}
                                  title={key}
                                >
                                  {key.replace(/[_-]/g, ' ')}
                                </label>
                                <div className="flex shrink-0 items-center gap-1">
                                  <span className="rounded bg-slate-200/70 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:bg-zinc-800 dark:text-zinc-400">
                                    {`{{${key}}}`}
                                  </span>
                                  {val && (
                                    <button
                                      type="button"
                                      onClick={() => setValues(prev => ({ ...prev, [key]: '' }))}
                                      aria-label={`Clear ${key}`}
                                      className="rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 transition"
                                    >
                                      <X size={12} />
                                    </button>
                                  )}
                                </div>
                              </div>
                              <AutoGrowingTextarea
                                id={`var-${key}`}
                                value={val}
                                onChange={newVal => setValues(prev => ({ ...prev, [key]: newVal }))}
                                placeholder={`Enter ${key.replace(/[_-]/g, ' ')}…`}
                                minRows={1}
                                maxHeight={140}
                                className="bg-white py-1 px-2.5 text-xs text-slate-900 dark:bg-zinc-900 dark:text-zinc-100"
                              />
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <p className="mt-4 rounded-lg border border-dashed border-slate-200 bg-slate-50/70 p-3 text-xs text-slate-500 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-400">
                        No <code className="font-mono text-slate-700 dark:text-zinc-300">{'{{fields}}'}</code> in this prompt. Add double-braced words in the template to create fill-in inputs.
                      </p>
                    )}

                    <div className="mt-4 border-t border-slate-100 dark:border-zinc-800 pt-3.5">
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-600 dark:text-zinc-300">
                          Compiled preview
                        </span>
                        <span className="font-mono text-[11px] text-slate-400 dark:text-zinc-500">
                          {compiled.length.toLocaleString()} chars
                        </span>
                      </div>
                      <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-anywhere break-words [overflow-wrap:anywhere] [word-break:break-word] rounded-xl border border-slate-200 bg-slate-50/80 p-3.5 font-mono text-xs leading-5 text-slate-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 custom-scrollbar">
                        <PromptText text={content} values={values} />
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => void copyPrompt()}
                    className="btn-primary mt-4 w-full shadow-sm"
                  >
                    {copied ? (
                      <>
                        <Check size={15} /> Copied to clipboard
                      </>
                    ) : (
                      <>
                        <Clipboard size={15} /> Copy compiled prompt
                      </>
                    )}
                  </button>
                </aside>
              </div>
            </div>
          )}

          {tab === 'history' && (
            <div>
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <History size={17} className="text-brand-600 dark:text-brand-400" />
                  <h3 className="text-base font-semibold text-slate-900 dark:text-zinc-100">Immutable version timeline</h3>
                </div>
                <span className="text-xs font-medium text-slate-500 dark:text-zinc-400">{versions.length} sequential snapshots</span>
              </div>

              <div className="space-y-3">
                {rankedVersions.map(version => {
                  const isActive = version.version_number === prompt.current_version_number
                  return (
                    <article
                      key={version.id}
                      className={`card p-5 transition ${
                        isActive ? 'border-emerald-300 bg-emerald-50/20 dark:border-emerald-500/40 dark:bg-emerald-950/20' : ''
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="flex min-w-0 items-start gap-3">
                          <span
                            className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${
                              isActive ? 'bg-emerald-500 ring-4 ring-emerald-100 dark:ring-emerald-950/80' : 'bg-slate-300 dark:bg-zinc-700'
                            }`}
                          />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-semibold text-slate-900 dark:text-zinc-100">{version.change_note}</span>
                              <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs font-medium text-slate-700 dark:bg-zinc-800 dark:text-zinc-300">
                                v{version.version_number}
                              </span>
                              {isActive && (
                                <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-800 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-950/60 dark:text-emerald-300 dark:ring-emerald-500/30">
                                  Active Version
                                </span>
                              )}
                            </div>
                            <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">
                              {version.author_name} · {timeAgo(version.created_at)} ({new Date(version.created_at).toLocaleString()})
                              {version.source_filename ? ` · ${version.source_filename}` : ''}
                            </p>
                          </div>
                        </div>

                        {!isActive && (
                          <div className="flex shrink-0 items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setCompareBase(version.version_number)
                                setTab('diff')
                              }}
                              className="btn-secondary btn-sm"
                            >
                              <ArrowLeftRight size={13} /> Compare with active
                            </button>
                            {canManageActiveVersion && (
                              <button
                                type="button"
                                onClick={() => setVersionToRestore(version)}
                                className="btn-secondary btn-sm"
                              >
                                <RotateCcw size={13} /> Make active
                              </button>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="mt-3 pl-5">
                        <p className="line-clamp-3 whitespace-pre-wrap break-anywhere break-words [overflow-wrap:anywhere] [word-break:break-word] rounded-lg border border-slate-200/80 bg-white p-3 font-mono text-xs leading-5 text-slate-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
                          <PromptText text={version.content} />
                        </p>
                      </div>
                    </article>
                  )
                })}
              </div>
            </div>
          )}

          {tab === 'diff' && (
            <VisualDiffViewer
              promptId={prompt.id}
              promptTitle={prompt.title}
              versions={versions}
              initialBaseVersion={compareBase}
              initialTargetVersion={prompt.current_version_number}
            />
          )}

          {tab === 'proposals' && (
            <div>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-slate-900 dark:text-zinc-100">Review requests</h3>
                  <p className="text-xs text-slate-500 dark:text-zinc-400">
                    Proposed prompt edits awaiting team approval before merging into the sequential version history.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-800 dark:border-brand-900/50 dark:bg-brand-950/60 dark:text-brand-300">
                    Required approvals: {currentGroup?.required_approvals ?? 1}
                  </span>
                  <button
                    type="button"
                    onClick={() => void reloadProposals()}
                    className="btn-secondary btn-sm"
                  >
                    Refresh
                  </button>
                </div>
              </div>

              {proposals.length === 0 ? (
                <div className="card border-dashed p-12 text-center">
                  <FileCheck size={24} className="mx-auto mb-2 text-slate-400 dark:text-zinc-500" />
                  <p className="text-sm font-medium text-slate-800 dark:text-zinc-200">No review requests submitted yet</p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">
                    When edits are proposed for this prompt, they’ll appear here for peer and owner review.
                  </p>
                </div>
              ) : (
                <div className="space-y-3.5">
                  {proposals.map(proposal => {
                    const isPending = proposal.status === 'PENDING'
                    const isApproved = proposal.status === 'APPROVED'
                    const isProcessing = processingProposalId === proposal.id

                    return (
                      <article
                        key={proposal.id}
                        className={`card p-5 ${
                          isPending
                            ? 'border-amber-200 dark:border-amber-900/50'
                            : isApproved
                            ? 'border-emerald-200 dark:border-emerald-900/50'
                            : 'opacity-75'
                        }`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <h4 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">{proposal.title}</h4>
                              <span
                                className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                                  isPending
                                    ? 'bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-950/60 dark:text-amber-300 dark:ring-amber-500/30'
                                    : isApproved
                                    ? 'bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-950/60 dark:text-emerald-300 dark:ring-emerald-500/30'
                                    : 'bg-rose-50 text-rose-800 ring-1 ring-inset ring-rose-600/20 dark:bg-rose-950/60 dark:text-rose-300 dark:ring-rose-500/30'
                                }`}
                              >
                                {isPending ? 'Pending review' : isApproved ? 'Approved & Merged' : 'Rejected'}
                              </span>
                            </div>
                            <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">
                              Proposed by <strong className="font-medium text-slate-700 dark:text-zinc-300">{proposal.proposer_name}</strong> ·{' '}
                              {timeAgo(proposal.created_at)}
                            </p>
                            <p className="mt-1.5 text-xs text-slate-600 dark:text-zinc-300">
                              Change note: <span className="font-medium text-slate-800 dark:text-zinc-200">{proposal.change_note}</span>
                            </p>
                          </div>

                          <div className="flex flex-col items-end gap-2">
                            <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700 dark:border-zinc-800 dark:bg-zinc-800/80 dark:text-zinc-300">
                              <CheckCheck size={13} className="text-brand-600 dark:text-brand-400" />
                              <span>
                                {proposal.approvals_count} / {proposal.required_approvals} approvals
                              </span>
                            </div>

                            {isPending && (
                              <div className="flex items-center gap-2">
                                {proposal.can_approve && (
                                  <>
                                    <button
                                      type="button"
                                      disabled={isProcessing}
                                      onClick={() => void handleApprove(proposal.id)}
                                      className="btn-primary btn-sm"
                                    >
                                      <Check size={13} /> {isProcessing ? 'Processing…' : 'Approve'}
                                    </button>
                                    <button
                                      type="button"
                                      disabled={isProcessing}
                                      onClick={() => void handleReject(proposal.id)}
                                      className="btn-secondary btn-sm text-rose-700 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
                                    >
                                      <X size={13} /> Reject
                                    </button>
                                  </>
                                )}
                                {proposal.has_approved && (
                                  <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-950/60 dark:text-emerald-300 dark:ring-emerald-500/30">
                                    <Check size={12} /> You approved this
                                  </span>
                                )}
                                {!proposal.can_approve && !proposal.has_approved && (
                                  <span className="text-xs text-slate-400 dark:text-zinc-500">
                                    Awaiting peer or Owner approval
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>

                        {proposal.approvals.length > 0 && (
                          <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-slate-100 dark:border-zinc-800 pt-3 text-xs text-slate-500 dark:text-zinc-400">
                            <span className="font-medium text-slate-600 dark:text-zinc-300">Approved by:</span>
                            {proposal.approvals.map(appr => (
                              <span
                                key={appr.id}
                                className="rounded-md bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-950/60 dark:text-emerald-300 dark:ring-emerald-500/30"
                              >
                                {appr.user_name}
                              </span>
                            ))}
                          </div>
                        )}

                        <div className="mt-3">
                          <span className="text-[11px] font-medium text-slate-400 dark:text-zinc-500">
                            Proposed content
                          </span>
                          <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-anywhere break-words [overflow-wrap:anywhere] [word-break:break-word] rounded-lg border border-slate-200/80 bg-slate-50 p-3 font-mono text-xs leading-5 text-slate-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
                            <PromptText text={proposal.content} />
                          </p>
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {uploadOpen && (
        <FileUploadModal
          groups={groups}
          prompts={prompts}
          activeUser={activeUser}
          existingPromptId={prompt.id}
          onClose={() => setUploadOpen(false)}
          onComplete={() => {
            setUploadOpen(false)
            void reload()
            onChanged()
          }}
        />
      )}

      {versionToRestore && (
        <Modal
          title={`Make Version ${versionToRestore.version_number} active?`}
          description={`This switches the active version pointer to v${versionToRestore.version_number} without duplicating history.`}
          icon={<RotateCcw size={18} />}
          size="sm"
          busy={restoring}
          onClose={() => setVersionToRestore(null)}
          footer={
            <>
              <button
                type="button"
                disabled={restoring}
                onClick={() => setVersionToRestore(null)}
                className="btn-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={restoring}
                onClick={() => void confirmRestore()}
                className="btn-primary"
                data-autofocus
              >
                {restoring ? 'Switching…' : `Activate v${versionToRestore.version_number}`}
              </button>
            </>
          }
        >
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-center justify-between font-medium text-slate-700 dark:text-zinc-300">
              <span className="font-semibold text-slate-900 dark:text-zinc-100">{versionToRestore.change_note}</span>
              <span className="rounded bg-white px-2 py-0.5 font-mono text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-700">
                v{versionToRestore.version_number}
              </span>
            </div>
            <p className="mt-2 line-clamp-3 font-mono text-[11px] leading-5 text-slate-600 dark:text-zinc-400">
              {versionToRestore.content}
            </p>
          </div>
        </Modal>
      )}

      {duplicateOpen && (
        <DuplicatePromptModal
          prompt={prompt}
          groups={groups}
          activeUser={activeUser}
          onClose={() => setDuplicateOpen(false)}
          onSuccess={result => {
            setDuplicateOpen(false)
            onChanged()
            if (result.mode === 'move') {
              onClose()
            }
          }}
        />
      )}
    </div>
  )
}
