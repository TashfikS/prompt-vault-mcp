import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Check,
  CheckCheck,
  Clock,
  ExternalLink,
  GitPullRequest,
  MessageSquare,
  Search,
  Send,
  X,
} from 'lucide-react'
import { diffArrays, diffWordsWithSpace } from 'diff'
import { addProposalComment, approveProposal, getAllProposals, rejectProposal } from '../api'
import type { Group, PromptItem, PromptProposalItem, User } from '../types'
import { useToast } from './ui/Toast'
import { Avatar } from './ui/Brand'

type FilterTab = 'needs_review' | 'pending' | 'mine' | 'approved' | 'rejected' | 'all'

function timeAgo(dateString: string): string {
  const elapsed = Math.floor((Date.now() - new Date(dateString).getTime()) / 1000)
  if (elapsed < 60) return 'just now'
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ago`
  if (elapsed < 604800) return `${Math.floor(elapsed / 86400)}d ago`
  return new Date(dateString).toLocaleDateString()
}

function diffSentenceChunks(oldText: string, newText: string): { value: string; added?: boolean; removed?: boolean }[] {
  const tokenize = (text: string): string[] => {
    if (!text) return []
    const tokens = text.match(/[^.!?\n]+([.!?]+(\s+|\n|$)|(\n+|$))/g)
    return tokens && tokens.length > 0 ? tokens : [text]
  }

  const partsA = tokenize(oldText)
  const partsB = tokenize(newText)
  return diffArrays(partsA, partsB).map(part => ({
    value: part.value.join(''),
    added: Boolean(part.added),
    removed: Boolean(part.removed),
  }))
}

export default function ReviewRequestsDashboard({
  groups,
  prompts,
  activeUser,
  onSelectPrompt,
  onRefreshWorkspace,
}: {
  groups: Group[]
  prompts: PromptItem[]
  activeUser: User | null
  onSelectPrompt: (prompt: PromptItem) => void
  onRefreshWorkspace: () => void
}) {
  const notify = useToast()
  const [requests, setRequests] = useState<PromptProposalItem[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<FilterTab>('needs_review')
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [expandedDiffId, setExpandedDiffId] = useState<string | null>(null)
  const [expandedComments, setExpandedComments] = useState<Record<string, boolean>>({})
  const [commentTexts, setCommentTexts] = useState<Record<string, string>>({})
  const [diffGranularity, setDiffGranularity] = useState<'word' | 'sentence'>('word')
  const [processingId, setProcessingId] = useState<string | null>(null)
  const [postingCommentId, setPostingCommentId] = useState<string | null>(null)

  const loadRequests = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getAllProposals({
        group_id: selectedGroupId || undefined,
      })
      setRequests(data)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [selectedGroupId])

  useEffect(() => {
    void loadRequests()
  }, [loadRequests])

  async function handleApprove(proposal: PromptProposalItem) {
    setProcessingId(proposal.id)
    try {
      const note = commentTexts[proposal.id]?.trim()
      const res = await approveProposal(proposal.id, note || undefined)
      if (res.merged) {
        notify('Change request approved & merged', {
          description: `Version ${res.version_number ?? ''} is now the active version of “${proposal.title}”.`,
        })
      } else {
        notify('Vote recorded', {
          description: `You approved this request (${res.approvals_count} / ${res.required_approvals} approvals).`,
        })
      }
      setCommentTexts(prev => ({ ...prev, [proposal.id]: '' }))
      await loadRequests()
      onRefreshWorkspace()
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not approve this request.', { tone: 'error' })
    } finally {
      setProcessingId(null)
    }
  }

  async function handleReject(proposal: PromptProposalItem) {
    setProcessingId(proposal.id)
    try {
      const note = commentTexts[proposal.id]?.trim()
      await rejectProposal(proposal.id, note || undefined)
      notify('Change request rejected', { description: `“${proposal.title}” request has been rejected.` })
      setCommentTexts(prev => ({ ...prev, [proposal.id]: '' }))
      await loadRequests()
      onRefreshWorkspace()
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not reject this request.', { tone: 'error' })
    } finally {
      setProcessingId(null)
    }
  }

  async function handlePostComment(proposalId: string) {
    const text = commentTexts[proposalId]?.trim()
    if (!text) return
    setPostingCommentId(proposalId)
    try {
      await addProposalComment(proposalId, text)
      notify('Comment posted', { description: 'Your review comment has been added to the discussion.' })
      setCommentTexts(prev => ({ ...prev, [proposalId]: '' }))
      await loadRequests()
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not post comment.', { tone: 'error' })
    } finally {
      setPostingCommentId(null)
    }
  }

  // Counts
  const needsReviewCount = useMemo(() => {
    return requests.filter(
      r => r.status === 'PENDING' && !r.has_approved && r.can_approve
    ).length
  }, [requests])

  const pendingCount = useMemo(() => {
    return requests.filter(r => r.status === 'PENDING').length
  }, [requests])

  const mineCount = useMemo(() => {
    return requests.filter(r => r.proposer_id === activeUser?.id).length
  }, [requests, activeUser])

  // Filtered requests
  const filtered = useMemo(() => {
    return requests.filter(r => {
      // Tab filter
      if (tab === 'needs_review') {
        const matchesNeeds = r.status === 'PENDING' && !r.has_approved && r.can_approve
        if (!matchesNeeds) return false
      } else if (tab === 'pending') {
        if (r.status !== 'PENDING') return false
      } else if (tab === 'mine') {
        if (r.proposer_id !== activeUser?.id) return false
      } else if (tab === 'approved') {
        if (r.status !== 'APPROVED') return false
      } else if (tab === 'rejected') {
        if (r.status !== 'REJECTED') return false
      }

      // Group filter
      if (selectedGroupId && r.group_id !== selectedGroupId) return false

      // Search filter
      if (search.trim()) {
        const q = search.toLowerCase()
        const text = `${r.title} ${r.prompt_title ?? ''} ${r.change_note} ${r.proposer_name} ${r.group_name ?? ''}`.toLowerCase()
        if (!text.includes(q)) return false
      }

      return true
    })
  }, [requests, tab, selectedGroupId, search, activeUser])

  return (
    <div className="mx-auto max-w-6xl px-5 py-7 sm:px-8">
      {/* Page Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-950 dark:text-zinc-50 sm:text-3xl">
              Review requests
            </h1>
            {needsReviewCount > 0 && (
              <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-bold text-brand-700 ring-1 ring-inset ring-brand-600/20 dark:bg-brand-950/60 dark:text-brand-300">
                {needsReviewCount} waiting for your review
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-slate-500 dark:text-zinc-400">
            Review, discuss, and approve prompt changes proposed across your team spaces before they merge into the active version.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadRequests()}
            className="btn-secondary"
            disabled={loading}
          >
            Refresh requests
          </button>
        </div>
      </div>

      {/* Tabs and Group Filter */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3 dark:border-zinc-800">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setTab('needs_review')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              tab === 'needs_review'
                ? 'bg-slate-900 text-white shadow-xs dark:bg-zinc-100 dark:text-zinc-900'
                : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800'
            }`}
          >
            Needs your review
            {needsReviewCount > 0 && (
              <span className={`grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-bold ${
                tab === 'needs_review' ? 'bg-brand-500 text-white' : 'bg-slate-200 text-slate-700 dark:bg-zinc-700 dark:text-zinc-200'
              }`}>
                {needsReviewCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setTab('pending')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              tab === 'pending'
                ? 'bg-slate-900 text-white shadow-xs dark:bg-zinc-100 dark:text-zinc-900'
                : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800'
            }`}
          >
            All pending ({pendingCount})
          </button>

          <button
            type="button"
            onClick={() => setTab('mine')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              tab === 'mine'
                ? 'bg-slate-900 text-white shadow-xs dark:bg-zinc-100 dark:text-zinc-900'
                : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800'
            }`}
          >
            Submitted by you ({mineCount})
          </button>

          <button
            type="button"
            onClick={() => setTab('approved')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              tab === 'approved'
                ? 'bg-slate-900 text-white shadow-xs dark:bg-zinc-100 dark:text-zinc-900'
                : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800'
            }`}
          >
            Approved &amp; Merged
          </button>

          <button
            type="button"
            onClick={() => setTab('all')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              tab === 'all'
                ? 'bg-slate-900 text-white shadow-xs dark:bg-zinc-100 dark:text-zinc-900'
                : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800'
            }`}
          >
            All requests ({requests.length})
          </button>
        </div>

        {/* Space Filter */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400 dark:text-zinc-500">Space:</span>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => setSelectedGroupId(null)}
              className={`rounded-md px-2 py-1 text-xs font-medium transition ${
                !selectedGroupId
                  ? 'bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300 font-semibold'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
              }`}
            >
              All spaces
            </button>
            {groups
              .filter(g => !g.is_personal)
              .map(g => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setSelectedGroupId(g.id)}
                  className={`rounded-md px-2 py-1 text-xs font-medium transition ${
                    selectedGroupId === g.id
                      ? 'bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300 font-semibold'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
                  }`}
                >
                  {g.name}
                </button>
              ))}
          </div>
        </div>
      </div>

      {/* Search Bar */}
      <div className="relative mb-6">
        <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-zinc-500" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search requests by prompt title, change note, or teammate name…"
          aria-label="Search review requests"
          className="field h-10 pl-10 pr-9"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-slate-400 hover:text-slate-700 dark:text-zinc-500 dark:hover:text-zinc-300"
            aria-label="Clear search"
          >
            <X size={15} />
          </button>
        )}
      </div>

      {/* Content list */}
      {loading ? (
        <div className="card p-12 text-center text-sm text-slate-500 dark:text-zinc-400">
          <GitPullRequest size={24} className="mx-auto mb-2 animate-pulse text-brand-600 dark:text-brand-400" />
          Loading review requests…
        </div>
      ) : filtered.length === 0 ? (
        <div className="card border-dashed p-12 text-center">
          <GitPullRequest size={28} className="mx-auto mb-3 text-slate-400 dark:text-zinc-500" />
          <h3 className="text-base font-semibold text-slate-900 dark:text-zinc-100">
            {tab === 'needs_review'
              ? 'All caught up!'
              : 'No review requests found'}
          </h3>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-500 dark:text-zinc-400">
            {tab === 'needs_review'
              ? 'There are no prompt review requests currently waiting for your review. When teammates propose prompt edits, they will appear here.'
              : search
              ? 'No requests matched your search query. Try clearing your search.'
              : 'When teammates propose edits to prompts in your shared spaces, they will be listed here for review and approval.'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map(req => {
            const isPending = req.status === 'PENDING'
            const isApproved = req.status === 'APPROVED'
            const isExpanded = expandedDiffId === req.id
            const isProcessing = processingId === req.id
            const isProposer = req.proposer_id === activeUser?.id
            const promptItem = prompts.find(p => p.id === req.prompt_id)

            // Compute visual diff
            const baseText = req.current_content || ''
            const targetText = req.content || ''
            const diffParts =
              diffGranularity === 'word'
                ? diffWordsWithSpace(baseText, targetText)
                : diffSentenceChunks(baseText, targetText)

            return (
              <article
                key={req.id}
                className={`card overflow-hidden p-5 transition shadow-sm ${
                  isPending
                    ? 'border-amber-200/90 dark:border-amber-900/50 hover:border-amber-300'
                    : isApproved
                    ? 'border-emerald-200/80 dark:border-emerald-900/50'
                    : 'border-slate-200/70 dark:border-zinc-800 opacity-80'
                }`}
              >
                {/* Header row */}
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700 dark:bg-zinc-800 dark:text-zinc-300">
                        {req.group_name || 'Team Space'}
                      </span>
                      <span className="text-xs text-slate-400 dark:text-zinc-600">·</span>
                      <span className="text-xs font-medium text-slate-500 dark:text-zinc-400">
                        Active version: v{req.current_version_number ?? 1}
                      </span>
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
                      {isProposer && (
                        <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-zinc-800 dark:text-zinc-400">
                          Submitted by you
                        </span>
                      )}
                    </div>

                    <h3 className="mt-1.5 text-base font-semibold tracking-tight text-slate-900 dark:text-zinc-100">
                      {req.prompt_title || req.title}
                    </h3>

                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-zinc-400">
                      <span className="flex items-center gap-1.5">
                        <Avatar name={req.proposer_name} size="sm" />
                        <strong className="font-medium text-slate-700 dark:text-zinc-300">{req.proposer_name}</strong>
                      </span>
                      <span>·</span>
                      <span className="flex items-center gap-1">
                        <Clock size={12} className="text-slate-400" />
                        {timeAgo(req.created_at)}
                      </span>
                    </div>

                    {/* Change Note */}
                    <div className="mt-3 flex items-start gap-2 rounded-lg border border-slate-200/80 bg-slate-50/70 p-2.5 text-xs dark:border-zinc-800 dark:bg-zinc-900/60">
                      <span className="font-medium text-slate-500 dark:text-zinc-400 shrink-0">Change note:</span>
                      <span className="font-semibold text-slate-800 dark:text-zinc-200">{req.change_note}</span>
                    </div>
                  </div>

                  {/* Actions & Approvals tracker */}
                  <div className="flex flex-col items-end gap-2.5">
                    <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
                      <CheckCheck size={14} className={req.approvals_count >= req.required_approvals ? 'text-emerald-600 dark:text-emerald-400' : 'text-brand-600 dark:text-brand-400'} />
                      <span>
                        {req.approvals_count} / {req.required_approvals} approvals
                      </span>
                    </div>

                    {/* Approvers list */}
                    {req.approvals.length > 0 && (
                      <div className="text-right text-[11px] text-slate-500 dark:text-zinc-400">
                        Approved by: {req.approvals.map(a => a.user_name).join(', ')}
                      </div>
                    )}

                    {/* Approve / Reject buttons */}
                    {isPending && (
                      <div className="flex items-center gap-2">
                        {req.can_approve && (
                          <>
                            <button
                              type="button"
                              disabled={isProcessing}
                              onClick={() => void handleApprove(req)}
                              className="btn-primary btn-sm"
                            >
                              <Check size={14} /> {isProcessing ? 'Processing…' : 'Approve change'}
                            </button>
                            <button
                              type="button"
                              disabled={isProcessing}
                              onClick={() => void handleReject(req)}
                              className="btn-secondary btn-sm text-rose-700 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
                            >
                              <X size={14} /> Reject
                            </button>
                          </>
                        )}
                        {req.has_approved && (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                            <Check size={14} /> You approved this
                          </span>
                        )}
                        {isProposer && !req.can_approve && !req.has_approved && (
                          <span className="text-xs text-slate-400 dark:text-zinc-500">
                            (Waiting for peer/owner approval)
                          </span>
                        )}
                        {isProposer && req.can_approve && (
                          <span className="rounded-sm bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
                            Self-approval allowed by owner
                          </span>
                        )}
                      </div>
                    )}

                    {promptItem && (
                      <button
                        type="button"
                        onClick={() => onSelectPrompt(promptItem)}
                        className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline dark:text-brand-400"
                      >
                        <ExternalLink size={12} /> Open prompt editor
                      </button>
                    )}
                  </div>
                </div>

                {/* Diff & Comments toolbar */}
                <div className="mt-4 border-t border-slate-100 pt-3 dark:border-zinc-800">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => setExpandedDiffId(isExpanded ? null : req.id)}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 hover:text-slate-900 dark:text-zinc-300 dark:hover:text-zinc-100"
                      >
                        <GitPullRequest size={13} className="text-brand-600 dark:text-brand-400" />
                        {isExpanded ? 'Hide proposed changes' : 'Inspect proposed changes (Diff)'}
                      </button>

                      <button
                        type="button"
                        onClick={() => setExpandedComments(prev => ({ ...prev, [req.id]: !prev[req.id] }))}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 hover:text-slate-900 dark:text-zinc-300 dark:hover:text-zinc-100"
                      >
                        <MessageSquare size={13} className="text-brand-600 dark:text-brand-400" />
                        {req.comments && req.comments.length > 0
                          ? `${req.comments.length} review comment${req.comments.length === 1 ? '' : 's'}`
                          : 'Review comments'}
                      </button>
                    </div>

                    {isExpanded && (
                      <div className="flex items-center gap-1 text-xs">
                        <span className="text-slate-400 dark:text-zinc-500">Granularity:</span>
                        <div className="segmented">
                          <button
                            type="button"
                            onClick={() => setDiffGranularity('word')}
                            className={`segmented-item ${diffGranularity === 'word' ? 'segmented-item-active' : ''}`}
                          >
                            Word
                          </button>
                          <button
                            type="button"
                            onClick={() => setDiffGranularity('sentence')}
                            className={`segmented-item ${diffGranularity === 'sentence' ? 'segmented-item-active' : ''}`}
                          >
                            Sentence
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Expanded Diff Viewer */}
                  {isExpanded && (
                    <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                      <div className="flex items-center justify-between border-b border-slate-200/80 bg-slate-50 px-3.5 py-2 text-xs font-semibold text-slate-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                        <span>Comparison with current active version (v{req.current_version_number ?? 1})</span>
                        <span className="flex items-center gap-3">
                          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                            <span className="h-2 w-2 rounded-full bg-emerald-500" /> Addition
                          </span>
                          <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-400">
                            <span className="h-2 w-2 rounded-full bg-rose-500" /> Removal
                          </span>
                        </span>
                      </div>

                      <div className="max-h-[380px] overflow-y-auto p-4 font-mono text-xs leading-6 text-slate-800 dark:text-zinc-200 custom-scrollbar whitespace-pre-wrap wrap-break-word">
                        {diffParts.map((part, index) => {
                          if (part.added) {
                            return (
                              <mark
                                key={index}
                                className="rounded-sm bg-emerald-100/90 px-0.5 text-emerald-950 font-medium no-underline dark:bg-emerald-950/70 dark:text-emerald-200"
                              >
                                {part.value}
                              </mark>
                            )
                          }
                          if (part.removed) {
                            return (
                              <del
                                key={index}
                                className="rounded-sm bg-rose-100/90 px-0.5 text-rose-950 line-through dark:bg-rose-950/70 dark:text-rose-200"
                              >
                                {part.value}
                              </del>
                            )
                          }
                          return <span key={index}>{part.value}</span>
                        })}
                      </div>
                    </div>
                  )}

                  {/* Comments and Discussion Thread */}
                  {expandedComments[req.id] && (
                    <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
                      <div className="mb-3 flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-zinc-200">
                          <MessageSquare size={13} className="text-brand-600 dark:text-brand-400" />
                          <span>Review discussion & comments</span>
                        </div>
                        <span className="text-[11px] text-slate-400 dark:text-zinc-500">
                          Live across PromptHold, Claude, and ChatGPT
                        </span>
                      </div>

                      {/* List of comments */}
                      {req.comments && req.comments.length > 0 ? (
                        <div className="mb-3 space-y-2.5">
                          {req.comments.map(c => (
                            <div key={c.id} className="rounded-lg border border-slate-200/80 bg-white p-3 text-xs shadow-2xs dark:border-zinc-800 dark:bg-zinc-900">
                              <div className="mb-1 flex items-center justify-between gap-2">
                                <span className="font-semibold text-slate-900 dark:text-zinc-100">{c.user_name}</span>
                                <span className="text-[10px] text-slate-400 dark:text-zinc-500">{timeAgo(c.created_at)}</span>
                              </div>
                              <p className="whitespace-pre-wrap leading-relaxed text-slate-700 dark:text-zinc-300">{c.comment}</p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="mb-3 text-xs italic text-slate-400 dark:text-zinc-500">
                          No comments yet. Post feedback or questions below.
                        </p>
                      )}

                      {/* Add comment input */}
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={commentTexts[req.id] ?? ''}
                          onChange={e => setCommentTexts(prev => ({ ...prev, [req.id]: e.target.value }))}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault()
                              void handlePostComment(req.id)
                            }
                          }}
                          placeholder="Write feedback, question, or approval note…"
                          className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:outline-hidden focus:ring-1 focus:ring-brand-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                        />
                        <button
                          type="button"
                          disabled={postingCommentId === req.id || !commentTexts[req.id]?.trim()}
                          onClick={() => void handlePostComment(req.id)}
                          className="btn-primary btn-sm"
                        >
                          <Send size={12} /> {postingCommentId === req.id ? 'Posting…' : 'Post'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
