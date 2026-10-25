import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { FileText, FileUp, UploadCloud, X } from 'lucide-react'
import { api } from '../api'
import { accessFor } from '../access'
import type { Group, PromptItem, User } from '../types'
import GroupSelectDropdown from './GroupSelectDropdown'
import PromptSelectDropdown from './PromptSelectDropdown'
import Modal from './ui/Modal'
import { useToast } from './ui/Toast'

export default function FileUploadModal({ groups, prompts, activeUser = null, onClose, onComplete, existingPromptId }: {
  groups: Group[]; prompts: PromptItem[]; activeUser?: User | null; onClose: () => void; onComplete: () => void; existingPromptId?: string
}) {
  const notify = useToast()
  const [groupId, setGroupId] = useState(existingPromptId ? prompts.find(p => p.id === existingPromptId)?.group_id ?? '' : groups[0]?.id ?? '')
  const [promptId, setPromptId] = useState(existingPromptId ?? '')
  const [note, setNote] = useState('Uploaded updated prompt file')
  const [files, setFiles] = useState<File[]>([])
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!groupId && groups[0]?.id) {
      setGroupId(existingPromptId ? prompts.find(p => p.id === existingPromptId)?.group_id ?? groups[0].id : groups[0].id)
    }
  }, [groups, groupId, existingPromptId, prompts])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!files.length || !groupId) return
    const form = new FormData()
    form.set('group_id', groupId)
    if (promptId) form.set('prompt_id', promptId)
    form.set('change_note', note)
    files.forEach(file => form.append('files', file))
    setBusy(true)
    setError('')
    try {
      const res = await api<{ created_prompt_ids?: string[]; updated_prompt_ids?: string[]; proposal_ids?: string[] }>(
        '/api/prompts/upload-files',
        { method: 'POST', body: form }
      )
      if (res.proposal_ids && res.proposal_ids.length > 0) {
        notify('Review request submitted', { description: 'The file was submitted as a review request.' })
      } else {
        notify(promptId ? 'New version uploaded' : 'Files imported', { description: `${files.length} file${files.length === 1 ? '' : 's'} processed.` })
      }
      onComplete()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Upload failed. Check the file type and try again.')
    } finally {
      setBusy(false)
    }
  }

  const selectedGroup = groups.find(g => g.id === groupId)
  const accessKind = accessFor(selectedGroup, activeUser)
  const canDirectWrite = Boolean(selectedGroup?.is_personal) || accessKind === 'GROUP_MANAGER' || accessKind === 'ADMIN'
  const groupPrompts = prompts.filter(p => p.group_id === groupId)
  const acceptFiles = (list: File[]) => setFiles(list.filter(f => /\.(txt|md|csv|json)$/i.test(f.name)))

  return (
    <Modal
      as="form"
      onSubmit={e => void submit(e)}
      title={existingPromptId ? (canDirectWrite ? 'Upload a new version' : 'Upload file for review') : 'Upload prompt files'}
      description={existingPromptId ? (canDirectWrite ? 'The file’s text becomes the next version of this prompt.' : 'The file’s text is submitted as a review request.') : 'Text files create a prompt each. CSV and JSON files can import many prompts at once.'}
      icon={<FileUp size={18} />}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-secondary" disabled={busy}>Cancel</button>
          <button type="submit" disabled={busy || !files.length || !groupId} className="btn-primary">
            {busy ? 'Uploading…' : promptId ? (canDirectWrite ? 'Upload version' : 'Submit for review') : 'Import files'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {!existingPromptId && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <span className="field-label">Save to</span>
              <GroupSelectDropdown groups={groups} value={groupId} onChange={nextGroup => { setGroupId(nextGroup); if (promptId) setPromptId(prompts.find(p => p.group_id === nextGroup)?.id ?? '') }} />
            </div>
            <div>
              <span className="field-label">What should happen?</span>
              <div className="segmented flex w-full">
                <button type="button" onClick={() => setPromptId('')} className={`segmented-item flex-1 ${!promptId ? 'segmented-item-active' : ''}`}>New prompts</button>
                <button type="button" disabled={!groupPrompts.length} onClick={() => setPromptId(groupPrompts[0]?.id ?? '')} className={`segmented-item flex-1 disabled:opacity-40 ${promptId ? 'segmented-item-active' : ''}`}>New version</button>
              </div>
            </div>
          </div>
        )}
        {!existingPromptId && promptId && groupPrompts.length > 0 && (
          <div>
            <span className="field-label">Prompt to update</span>
            <PromptSelectDropdown prompts={groupPrompts} value={promptId} onChange={setPromptId} />
          </div>
        )}
        <div>
          <label className="field-label" htmlFor="up-note">Change note</label>
          <input id="up-note" value={note} onChange={e => setNote(e.target.value)} className="field" />
        </div>

        <input ref={input} type="file" accept=".txt,.md,.csv,.json" multiple={!promptId} className="hidden" onChange={e => acceptFiles(Array.from(e.target.files ?? []))} />
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); acceptFiles(Array.from(e.dataTransfer.files)) }}
          className={`w-full rounded-xl border-2 border-dashed px-5 py-8 text-center transition ${
            dragging
              ? 'border-brand-500 bg-brand-50/60 dark:border-brand-400 dark:bg-brand-950/40'
              : 'border-slate-300 bg-slate-50/60 hover:border-brand-400 hover:bg-brand-50/30 dark:border-zinc-700 dark:bg-zinc-900/60 dark:hover:border-zinc-600 dark:hover:bg-zinc-800/40'
          }`}
        >
          <span className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-white text-slate-500 shadow-xs ring-1 ring-slate-200 dark:bg-zinc-800 dark:text-zinc-400 dark:ring-zinc-700"><UploadCloud size={18} /></span>
          <span className="mt-3 block text-sm text-slate-700 dark:text-zinc-300"><span className="font-medium text-brand-700 dark:text-brand-400">Click to choose</span> or drag and drop</span>
          <span className="mt-1 block text-xs text-slate-500 dark:text-zinc-400">.txt, .md, .csv or .json</span>
        </button>
        {files.length > 0 && (
          <ul className="space-y-1.5">
            {files.map(f => (
              <li key={f.name} className="flex items-center gap-2.5 rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950/40">
                <FileText size={15} className="shrink-0 text-slate-400 dark:text-zinc-500" />
                <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-zinc-200">{f.name}</span>
                <span className="text-xs text-slate-400 dark:text-zinc-500">{Math.max(1, Math.round(f.size / 1024))} KB</span>
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter(x => x !== f))} className="rounded p-0.5 text-slate-400 hover:text-slate-700 dark:text-zinc-500 dark:hover:text-zinc-300"><X size={14} /></button>
              </li>
            ))}
          </ul>
        )}
        {error && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">{error}</p>}
      </div>
    </Modal>
  )
}
