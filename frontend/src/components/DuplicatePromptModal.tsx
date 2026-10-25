import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowRight, ArrowRightLeft, Copy, CopyPlus, LockKeyhole, ShieldAlert, Users } from 'lucide-react'
import { duplicatePrompt } from '../api'
import type { Group, PromptDuplicateResponse, PromptItem, User } from '../types'
import { accessFor, spaceName } from '../access'
import GroupSelectDropdown from './GroupSelectDropdown'
import Modal from './ui/Modal'
import { useToast } from './ui/Toast'

export default function DuplicatePromptModal({
  prompt,
  groups,
  activeUser,
  onClose,
  onSuccess,
}: {
  prompt: PromptItem
  groups: Group[]
  activeUser: User | null
  onClose: () => void
  onSuccess: (result: PromptDuplicateResponse) => void
}) {
  const notify = useToast()
  const [mode, setMode] = useState<'copy' | 'move'>('copy')

  // Filter groups where the current user is a Member or Owner (not a Guest)
  const writableGroups = useMemo(() => {
    return groups.filter(g => accessFor(g, activeUser) !== 'GUEST')
  }, [groups, activeUser])

  const sourceGroup = useMemo(() => {
    return groups.find(g => g.id === prompt.group_id)
  }, [groups, prompt.group_id])

  // Prefer a different group as default target if available
  const initialTargetId = useMemo(() => {
    const other = writableGroups.find(g => g.id !== prompt.group_id)
    return other ? other.id : (writableGroups[0]?.id ?? prompt.group_id)
  }, [writableGroups, prompt.group_id])

  const [targetGroupId, setTargetGroupId] = useState(initialTargetId)
  const [title, setTitle] = useState(
    prompt.group_id === initialTargetId ? `${prompt.title} (Copy)` : prompt.title
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const targetGroup = useMemo(() => {
    return writableGroups.find(g => g.id === targetGroupId)
  }, [writableGroups, targetGroupId])

  const isSameGroup = targetGroupId === prompt.group_id
  const canMove = !isSameGroup && writableGroups.length > 1

  function handleModeChange(newMode: 'copy' | 'move') {
    setMode(newMode)
    setError('')
    if (newMode === 'copy' && isSameGroup) {
      if (title === prompt.title) {
        setTitle(`${prompt.title} (Copy)`)
      }
    } else if (newMode === 'move') {
      if (title === `${prompt.title} (Copy)`) {
        setTitle(prompt.title)
      }
    }
  }

  function handleTargetGroupChange(newGroupId: string) {
    setTargetGroupId(newGroupId)
    setError('')
    if (mode === 'copy') {
      if (newGroupId === prompt.group_id) {
        if (title === prompt.title) setTitle(`${prompt.title} (Copy)`)
      } else {
        if (title === `${prompt.title} (Copy)`) setTitle(prompt.title)
      }
    }
  }

  const isInvalidMove = mode === 'move' && isSameGroup
  const canSubmit = !busy && Boolean(title.trim()) && Boolean(targetGroupId) && !isInvalidMove

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!canSubmit) return

    setBusy(true)
    setError('')
    try {
      const res = await duplicatePrompt(prompt.id, {
        target_group_id: targetGroupId,
        title: title.trim(),
        mode,
      })

      notify(
        mode === 'copy' ? 'Prompt duplicated' : 'Prompt moved',
        {
          description: mode === 'copy'
            ? `“${title.trim()}” is ready in ${res.group_name}.`
            : `“${title.trim()}” transferred to ${res.group_name}.`
        }
      )
      onSuccess(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      as="form"
      onSubmit={e => void submit(e)}
      title="Duplicate or move prompt"
      description="Transfer this prompt to another team space or clone it into your private Personal workspace."
      icon={<CopyPlus size={18} />}
      size="md"
      busy={busy}
      onClose={onClose}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="btn-secondary"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="btn-primary"
          >
            {mode === 'copy' ? <CopyPlus size={15} /> : <ArrowRightLeft size={15} />}
            {mode === 'copy' ? 'Duplicate prompt' : 'Move prompt'}
          </button>
        </div>
      }
    >
      <div className="space-y-5">
        {/* Mode selector (Pill segmented control) */}
        <div>
          <label className="field-label mb-2 block">Action type</label>
          <div className="grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-slate-100/70 p-1 dark:border-zinc-800 dark:bg-zinc-900/80">
            <button
              type="button"
              onClick={() => handleModeChange('copy')}
              className={`flex items-center justify-center gap-2 rounded-lg py-2 text-xs font-semibold transition ${
                mode === 'copy'
                  ? 'bg-white text-brand-700 shadow-xs dark:bg-zinc-800 dark:text-brand-300'
                  : 'text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              <Copy size={14} /> Duplicate (Copy)
            </button>
            <button
              type="button"
              onClick={() => handleModeChange('move')}
              className={`flex items-center justify-center gap-2 rounded-lg py-2 text-xs font-semibold transition ${
                mode === 'move'
                  ? 'bg-white text-brand-700 shadow-xs dark:bg-zinc-800 dark:text-brand-300'
                  : 'text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              <ArrowRightLeft size={14} /> Move (Transfer)
            </button>
          </div>
          <p className="mt-1.5 text-xs text-slate-500 dark:text-zinc-400">
            {mode === 'copy'
              ? 'Creates a fresh copy in the destination space. The original prompt and its history remain untouched.'
              : 'Transfers this prompt and all version history to the destination space, removing it from the current space.'}
          </p>
        </div>

        {/* Transfer visual preview card */}
        <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3.5 dark:border-zinc-800 dark:bg-zinc-900/50">
          <div className="flex items-center justify-between gap-3 text-xs">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 font-medium text-slate-600 dark:text-zinc-400">From:</span>
              <span className="inline-flex items-center gap-1.5 rounded-md bg-white px-2.5 py-1 font-semibold text-slate-800 ring-1 ring-slate-200 dark:bg-zinc-800 dark:text-zinc-200 dark:ring-zinc-700">
                {sourceGroup?.is_personal ? <LockKeyhole size={12} className="shrink-0 text-slate-400" /> : <Users size={12} className="shrink-0 text-brand-600" />}
                <span className="whitespace-nowrap">{sourceGroup ? spaceName(sourceGroup) : prompt.group_name}</span>
              </span>
            </div>

            <ArrowRight size={14} className="shrink-0 text-slate-400 dark:text-zinc-500" />

            <div className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 font-medium text-slate-600 dark:text-zinc-400">To:</span>
              <span className="inline-flex items-center gap-1.5 rounded-md bg-white px-2.5 py-1 font-semibold text-brand-800 ring-1 ring-brand-200 dark:bg-zinc-800 dark:text-brand-300 dark:ring-brand-800/40">
                {targetGroup?.is_personal ? <LockKeyhole size={12} className="shrink-0 text-slate-400" /> : <Users size={12} className="shrink-0 text-brand-600" />}
                <span className="whitespace-nowrap">{targetGroup ? spaceName(targetGroup) : 'Select space'}</span>
              </span>
            </div>
          </div>
        </div>

        {/* Target space selector */}
        <div>
          <label className="field-label mb-1.5 block">Destination space</label>
          {writableGroups.length === 0 ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
              You do not have write access to any spaces. Guests cannot duplicate or move prompts.
            </div>
          ) : (
            <GroupSelectDropdown
              groups={writableGroups}
              value={targetGroupId}
              onChange={handleTargetGroupChange}
              allowCreateGroup={false}
            />
          )}

          {isInvalidMove && (
            <p className="mt-1.5 flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
              <ShieldAlert size={13} className="shrink-0" />
              Please choose a different destination space to transfer this prompt.
            </p>
          )}

          {mode === 'move' && !canMove && writableGroups.length <= 1 && (
            <p className="mt-1.5 text-xs text-slate-500 dark:text-zinc-400">
              You belong to only one space. To move prompts to other spaces, join or create a team group first.
            </p>
          )}
        </div>

        {/* Prompt title in destination space */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="field-label" htmlFor="dup-title">
              Prompt title in destination
            </label>
            {prompt.current_version_number > 1 && (
              <span className="text-[11px] text-slate-400 dark:text-zinc-500">
                Copies active v{prompt.current_version_number}
              </span>
            )}
          </div>
          <input
            id="dup-title"
            value={title}
            onChange={e => setTitle(e.target.value)}
            disabled={busy}
            placeholder="e.g. Customer Support Responder"
            className="field font-medium text-slate-900 dark:text-zinc-100"
          />
        </div>

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/60 dark:text-rose-300">
            {error}
          </div>
        )}
      </div>
    </Modal>
  )
}
