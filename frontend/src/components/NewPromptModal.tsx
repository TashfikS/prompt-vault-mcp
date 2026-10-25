import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { FilePlus2, Users } from 'lucide-react'
import { createGroup, createPrompt } from '../api'
import type { Group } from '../types'
import GroupSelectDropdown from './GroupSelectDropdown'
import Modal from './ui/Modal'
import { useToast } from './ui/Toast'

const VAR_RE = /\{\{\s*([a-zA-Z0-9_ -]+)\s*\}\}/g

export default function NewPromptModal({
  groups,
  defaultGroupId,
  onClose,
  onSaved,
}: {
  groups: Group[]
  defaultGroupId?: string | null
  onClose: () => void
  onSaved: (newGroupId?: string) => void
}) {
  const notify = useToast()
  const [groupId, setGroupId] = useState(defaultGroupId ?? groups[0]?.id ?? '')
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupDescription, setNewGroupDescription] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const [changeNote, setChangeNote] = useState('First version')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!groupId && groups[0]?.id) setGroupId(groups[0].id)
  }, [groups, groupId])

  const isNewGroup = groupId === '__new__'
  const fields = useMemo(() => Array.from(new Set([...content.matchAll(VAR_RE)].map(m => m[1].trim()))), [content])
  const canSubmit = !busy && Boolean(title.trim()) && Boolean(content.trim()) && (isNewGroup ? Boolean(newGroupName.trim()) : Boolean(groupId))

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      let targetGroupId = groupId
      if (isNewGroup) {
        const trimmedGroupName = newGroupName.trim()
        if (!trimmedGroupName) {
          throw new Error('Please enter a group name.')
        }
        if (trimmedGroupName.toLowerCase().startsWith('personal')) {
          throw new Error('Please choose a different group name.')
        }
        if (groups.some(g => g.name.toLowerCase() === trimmedGroupName.toLowerCase())) {
          throw new Error('A group with this name already exists.')
        }

        // 1. Create group first
        const newGroup = await createGroup({
          name: trimmedGroupName,
          description: newGroupDescription.trim(),
        })
        targetGroupId = newGroup.id
      }

      // 2. Create prompt in the chosen (or newly created) group
      await createPrompt({
        group_id: targetGroupId,
        title: title.trim(),
        description: description.trim(),
        content,
        change_note: changeNote,
      })

      if (isNewGroup) {
        notify('Group & prompt created', { description: `Group “${newGroupName.trim()}” and prompt “${title.trim()}” created.` })
      } else {
        notify('Prompt created', { description: `“${title.trim()}” is saved as version 1.` })
      }
      onSaved(targetGroupId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the prompt. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      as="form"
      onSubmit={e => void submit(e)}
      title="Create a prompt"
      description="Save a prompt so you and your team can reuse it. Every future change is kept as a new version."
      icon={<FilePlus2 size={18} />}
      size="lg"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-secondary" disabled={busy}>Cancel</button>
          <button type="submit" disabled={!canSubmit} className="btn-primary">{busy ? (isNewGroup ? 'Creating group & prompt…' : 'Creating…') : 'Create prompt'}</button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="field-label" htmlFor="np-title">Title</label>
            <input id="np-title" required value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Customer follow-up email" className="field" />
          </div>
          <div>
            <span className="field-label">Save to</span>
            <GroupSelectDropdown
              groups={groups}
              value={groupId}
              onChange={setGroupId}
              allowCreateGroup
              newGroupName={newGroupName}
            />
          </div>
        </div>

        {isNewGroup && (
          <div className="rounded-xl border border-brand-200/80 bg-brand-50/40 p-3.5 space-y-3 dark:border-brand-900/60 dark:bg-brand-950/30">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-semibold text-brand-900 dark:text-brand-200">
                <Users size={14} className="text-brand-600 dark:text-brand-400" />
                <span>New team group details</span>
              </div>
              <span className="text-[11px] text-brand-700/80 dark:text-brand-300/80">Group will be created first with this prompt</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="field-label" htmlFor="np-new-group-name">
                  Group name <span className="text-rose-500">*</span>
                </label>
                <input
                  id="np-new-group-name"
                  required
                  value={newGroupName}
                  onChange={e => setNewGroupName(e.target.value)}
                  placeholder="e.g. Customer Support"
                  className="field bg-white dark:bg-zinc-900"
                  autoFocus
                />
              </div>
              <div>
                <label className="field-label" htmlFor="np-new-group-desc">
                  Group description <span className="font-normal text-slate-400 dark:text-zinc-500">(optional)</span>
                </label>
                <input
                  id="np-new-group-desc"
                  value={newGroupDescription}
                  onChange={e => setNewGroupDescription(e.target.value)}
                  placeholder="What will this group be used for?"
                  className="field bg-white dark:bg-zinc-900"
                />
              </div>
            </div>
          </div>
        )}
        <div>
          <label className="field-label" htmlFor="np-desc">Description <span className="font-normal text-slate-400 dark:text-zinc-500">(optional)</span></label>
          <input id="np-desc" value={description} onChange={e => setDescription(e.target.value)} placeholder="When should someone use this prompt?" className="field" />
        </div>
        <div>
          <label className="field-label" htmlFor="np-content">Prompt text</label>
          <textarea
            id="np-content"
            required
            rows={8}
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder={'Write a friendly follow-up to {{contact_name}} at {{company}}…'}
            className="field resize-y font-mono text-[13px] leading-6"
          />
          <div className="mt-2 flex min-h-6 flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-zinc-400">
            {fields.length ? (
              <>
                <span>Fill-in fields:</span>
                {fields.map(f => (
                  <span key={f} className="rounded-md bg-brand-50 px-1.5 py-0.5 font-medium text-brand-700 ring-1 ring-inset ring-brand-600/15 dark:bg-brand-950/60 dark:text-brand-300 dark:ring-brand-500/20">{f}</span>
                ))}
              </>
            ) : (
              <span>Tip: wrap words in double braces, like <code className="font-mono text-slate-700 dark:text-zinc-300">{'{{topic}}'}</code>, to create fill-in fields.</span>
            )}
          </div>
        </div>
        <div>
          <label className="field-label" htmlFor="np-note">Change note</label>
          <input id="np-note" value={changeNote} onChange={e => setChangeNote(e.target.value)} className="field" />
          <p className="field-hint">A short note shown in version history.</p>
        </div>
        {error && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">{error}</p>}
      </div>
    </Modal>
  )
}
