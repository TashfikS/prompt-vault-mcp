import { useMemo, useState } from 'react'
import { ArrowUpRight, Check, Copy, CopyPlus, FileText, LockKeyhole, Plus, Search, UploadCloud, Users, X } from 'lucide-react'
import type { Group, PromptItem, User } from '../types'
import { accessFor, spaceName } from '../access'
import { PromptText, timeAgo } from './ui/Brand'
import RoleBadge from './ui/RoleBadge'
import { useToast } from './ui/Toast'

export default function PromptDashboard({
  prompts,
  groups = [],
  activeUser = null,
  selectedSpaceId = null,
  onSelectSpace,
  loading,
  onSelect,
  onCreate,
  onUpload,
  onDuplicate,
  onNavigate,
}: {
  prompts: PromptItem[]
  groups?: Group[]
  activeUser?: User | null
  selectedSpaceId?: string | null
  onSelectSpace?: (groupId: string | null) => void
  loading: boolean
  onSelect: (prompt: PromptItem) => void
  onCreate: () => void
  onUpload: () => void
  onDuplicate?: (prompt: PromptItem) => void
  onNavigate?: (page: 'prompts' | 'groups') => void
}) {
  const notify = useToast()
  const [search, setSearch] = useState('')
  const [internalGroupId, setInternalGroupId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const activeGroupId = selectedSpaceId !== undefined ? selectedSpaceId : internalGroupId
  const setGroupId = (id: string | null) => {
    if (onSelectSpace) onSelectSpace(id)
    else setInternalGroupId(id)
  }

  const selectedGroup = useMemo(
    () => groups.find(g => g.id === activeGroupId),
    [groups, activeGroupId]
  )

  const groupMap = useMemo(() => new Map(groups.map(g => [g.id, g])), [groups])

  const filtered = useMemo(() => {
    return prompts.filter(p => {
      if (activeGroupId && p.group_id !== activeGroupId) return false
      if (!search.trim()) return true
      const query = search.trim().toLowerCase()
      return `${p.title} ${p.description || ''} ${p.group_name || ''} ${p.content || ''}`.toLowerCase().includes(query)
    })
  }, [prompts, search, activeGroupId])

  const resetAll = () => {
    setGroupId(null)
    setSearch('')
  }

  async function quickCopy(e: React.MouseEvent, prompt: PromptItem) {
    e.stopPropagation()
    await navigator.clipboard.writeText(prompt.content)
    setCopiedId(prompt.id)
    notify('Prompt copied to clipboard', { description: `Active v${prompt.current_version_number} of “${prompt.title}”` })
    window.setTimeout(() => setCopiedId(curr => (curr === prompt.id ? null : curr)), 1600)
  }

  const selectedAccess = selectedGroup ? accessFor(selectedGroup, activeUser) : null

  return (
    <main className="mx-auto max-w-6xl px-5 py-8 sm:px-8">
      {/* Header and actions */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-950 dark:text-zinc-50 sm:text-3xl">
              {selectedGroup ? (selectedGroup.is_personal ? 'Personal space' : selectedGroup.name) : 'Prompt library'}
            </h1>
            {selectedGroup && selectedAccess && (
              <RoleBadge kind={selectedAccess} side="bottom" />
            )}
          </div>

          <p className="mt-1.5 text-sm text-slate-500 dark:text-zinc-400">
            {selectedGroup
              ? selectedGroup.description ||
                (selectedGroup.is_personal
                  ? 'Private prompts visible only to you. Draft freely before sharing with a team group.'
                  : `Shared with ${selectedGroup.members.length} team ${selectedGroup.members.length === 1 ? 'member' : 'members'}.`)
              : 'Browse verified prompts, fill in dynamic fields, or inspect version history.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {selectedGroup && !selectedGroup.is_personal && onNavigate && (
            <button
              type="button"
              onClick={() => onNavigate('groups')}
              className="btn-secondary"
            >
              <Users size={15} /> Members &amp; roles
            </button>
          )}
          <button
            type="button"
            onClick={onUpload}
            className="btn-secondary"
            title="Import prompts (.txt, .md, .csv, .json • max 1 MB per file, up to 10 files)"
          >
            <UploadCloud size={15} /> Upload files
          </button>
          <button
            type="button"
            data-tour="new-prompt"
            onClick={onCreate}
            className="btn-primary"
          >
            <Plus size={16} /> New prompt
          </button>
        </div>
      </div>

      {/* Search & filter bar */}
      <div className="mb-6 space-y-3">
        <div className="relative w-full">
          <Search size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-zinc-500" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search prompts by title, description, {{field}}, or group…"
            aria-label="Search prompts"
            className="field h-10 pl-10 pr-9"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-700 dark:text-zinc-500 dark:hover:text-zinc-300"
              aria-label="Clear search"
            >
              <X size={15} />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setGroupId(null)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                !activeGroupId
                  ? 'bg-slate-900 text-white shadow-xs dark:bg-zinc-100 dark:text-zinc-900'
                  : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
              }`}
            >
              All spaces
              <span
                className={`rounded-full px-1.5 py-px text-[11px] tabular-nums ${
                  !activeGroupId
                    ? 'bg-white/20 text-white dark:bg-black/20 dark:text-zinc-900'
                    : 'bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400'
                }`}
              >
                {prompts.length}
              </span>
            </button>
            {groups.map(group => {
              const count = prompts.filter(p => p.group_id === group.id).length
              const isSelected = activeGroupId === group.id
              return (
                <button
                  key={group.id}
                  type="button"
                  onClick={() => setGroupId(isSelected ? null : group.id)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    isSelected
                      ? 'bg-brand-600 text-white shadow-xs dark:bg-brand-500 dark:text-zinc-950 font-semibold'
                      : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
                  }`}
                >
                  {group.is_personal ? (
                    <LockKeyhole size={12} className={isSelected ? 'text-brand-100 dark:text-zinc-950' : 'text-slate-400 dark:text-zinc-500'} />
                  ) : null}
                  {spaceName(group)}
                  <span
                    className={`rounded-full px-1.5 py-px text-[11px] tabular-nums ${
                      isSelected
                        ? 'bg-white/20 text-white dark:bg-black/20 dark:text-zinc-950'
                        : 'bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400'
                    }`}
                  >
                    {count}
                  </span>
                </button>
              )
            })}
          </div>

          <span className="text-xs font-medium tabular-nums text-slate-400 dark:text-zinc-500">
            Showing {filtered.length} of {prompts.length} {prompts.length === 1 ? 'prompt' : 'prompts'}
          </span>
        </div>
      </div>

      {/* Prompt cards grid */}
      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3].map(n => (
            <div key={n} className="card h-64 animate-pulse p-5">
              <div className="h-5 w-28 rounded bg-slate-100 dark:bg-zinc-800" />
              <div className="mt-4 h-5 w-3/4 rounded bg-slate-100 dark:bg-zinc-800" />
              <div className="mt-2 h-4 w-1/2 rounded bg-slate-100 dark:bg-zinc-800" />
              <div className="mt-4 h-24 rounded-lg bg-slate-50 dark:bg-zinc-800/60" />
            </div>
          ))}
        </div>
      ) : filtered.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map(prompt => {
            const grp = groupMap.get(prompt.group_id)
            const roleKind = accessFor(grp, activeUser)
            const isCopied = copiedId === prompt.id

            return (
              <article
                key={prompt.id}
                data-prompt-card
                onClick={() => onSelect(prompt)}
                className="group card flex cursor-pointer flex-col justify-between p-5 transition hover:border-brand-300 dark:hover:border-zinc-700 hover:shadow-md"
              >
                <div>
                  {/* Card top metadata bar */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="inline-flex items-center gap-1 truncate rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 dark:bg-zinc-800 dark:text-zinc-300">
                        {grp?.is_personal ? <LockKeyhole size={11} className="text-slate-500 dark:text-zinc-400" /> : null}
                        {prompt.group_name}
                      </span>
                      <span onClick={e => e.stopPropagation()}>
                        <RoleBadge kind={roleKind} size="sm" side="top" showIcon={false} />
                      </span>
                    </div>
                    <span className="shrink-0 rounded-full bg-brand-50 px-2 py-0.5 font-mono text-[11px] font-medium text-brand-800 ring-1 ring-inset ring-brand-600/15 dark:bg-brand-950/60 dark:text-brand-300 dark:ring-brand-500/30">
                      v{prompt.current_version_number}
                    </span>
                  </div>

                  {/* Title & description */}
                  <h2 className="mt-3.5 text-base font-semibold text-slate-900 transition group-hover:text-brand-700 dark:text-zinc-100 dark:group-hover:text-brand-400">
                    {prompt.title}
                  </h2>
                  <p className="mt-1 line-clamp-1 text-xs text-slate-500 dark:text-zinc-400">
                    {prompt.description || 'Reusable prompt template'}
                  </p>

                  {/* Monospace preview with highlighted {{variables}} */}
                  <div className="relative mt-3.5 rounded-lg border border-slate-200/80 bg-slate-50/70 p-3 font-mono text-xs leading-5 text-slate-700 dark:border-zinc-800 dark:bg-zinc-950/70 dark:text-zinc-300">
                    <button
                      type="button"
                      onClick={e => void quickCopy(e, prompt)}
                      className="absolute top-2 right-2 inline-flex items-center justify-center rounded-md border border-slate-200/80 bg-white/90 p-1.5 text-slate-400 shadow-xs backdrop-blur-xs transition hover:border-slate-300 hover:bg-white hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-zinc-700 dark:bg-zinc-850 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                      aria-label={`Copy ${prompt.title}`}
                      title={isCopied ? 'Copied to clipboard' : 'Copy raw prompt'}
                    >
                      {isCopied ? <Check size={13} className="text-emerald-600 dark:text-emerald-400" /> : <Copy size={13} />}
                    </button>
                    <p className="line-clamp-3 whitespace-pre-wrap break-anywhere break-words [overflow-wrap:anywhere] [word-break:break-word] pr-8">
                      <PromptText text={prompt.content || ''} />
                    </p>
                  </div>
                </div>

                {/* Card footer */}
                <div className="mt-4 pt-3 border-t border-slate-100 dark:border-zinc-800/80">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 text-xs text-slate-400 dark:text-zinc-500">
                      <span className="tabular-nums">{prompt.version_count} {prompt.version_count === 1 ? 'version' : 'versions'}</span>
                      {Boolean(prompt.variables && prompt.variables.length > 0) && (
                        <span> · {prompt.variables.length} {prompt.variables.length === 1 ? 'field' : 'fields'}</span>
                      )}
                      {prompt.updated_at && (
                        <span> · {timeAgo(prompt.updated_at)}</span>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {onDuplicate && roleKind !== 'GUEST' && (
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation()
                            onDuplicate(prompt)
                          }}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 shadow-xs hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 transition"
                          title="Duplicate or move this prompt to another space"
                        >
                          <CopyPlus size={13} />
                          <span className="hidden sm:inline">Duplicate</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={e => {
                          e.stopPropagation()
                          onSelect(prompt)
                        }}
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-white transition group-hover:bg-brand-600 dark:bg-zinc-100 dark:text-zinc-900 dark:group-hover:bg-brand-400 dark:group-hover:text-zinc-950 font-semibold"
                      >
                        Open prompt <ArrowUpRight size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      ) : (
        <div className="card border-dashed px-6 py-14 text-center">
          <span className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
            <FileText size={20} />
          </span>
          <h2 className="mt-3.5 text-base font-semibold text-slate-900 dark:text-zinc-100">
            {prompts.length ? 'No prompts match your current filter' : 'Your prompt library is empty'}
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-zinc-400">
            {prompts.length
              ? 'Try clearing your search query or switching back to All spaces.'
              : 'Start by saving a prompt in your private Personal space or creating one for your team.'}
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
            {search || activeGroupId ? (
              <button type="button" onClick={resetAll} className="btn-secondary">
                Reset filters
              </button>
            ) : (
              <>
                <button type="button" onClick={onCreate} className="btn-primary">
                  <Plus size={16} /> Create first prompt
                </button>
                <button type="button" onClick={onUpload} className="btn-secondary">
                  <UploadCloud size={15} /> Upload files
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </main>
  )
}
