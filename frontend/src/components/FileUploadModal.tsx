import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileText,
  FileUp,
  Info,
  ShieldCheck,
  UploadCloud,
  X,
} from 'lucide-react'
import { api } from '../api'
import { accessFor } from '../access'
import type { Group, PromptItem, User } from '../types'
import GroupSelectDropdown from './GroupSelectDropdown'
import PromptSelectDropdown from './PromptSelectDropdown'
import Modal from './ui/Modal'
import { useToast } from './ui/Toast'

export const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024 // 1 MB
export const MAX_BATCH_FILES = 10
export const MAX_BATCH_PROMPTS_PER_FILE = 200
export const MAX_PROMPT_CONTENT_CHARS = 100_000
const ALLOWED_EXTENSIONS_REGEX = /\.(txt|md|csv|json)$/i

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export default function FileUploadModal({
  groups,
  prompts,
  activeUser = null,
  onClose,
  onComplete,
  existingPromptId,
}: {
  groups: Group[]
  prompts: PromptItem[]
  activeUser?: User | null
  onClose: () => void
  onComplete: () => void
  existingPromptId?: string
}) {
  const notify = useToast()
  const [groupId, setGroupId] = useState(
    existingPromptId
      ? prompts.find(p => p.id === existingPromptId)?.group_id ?? ''
      : groups[0]?.id ?? ''
  )
  const [promptId, setPromptId] = useState(existingPromptId ?? '')
  const [note, setNote] = useState('Uploaded updated prompt file')
  const [files, setFiles] = useState<File[]>([])
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showFormatGuide, setShowFormatGuide] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!groupId && groups[0]?.id) {
      setGroupId(
        existingPromptId
          ? prompts.find(p => p.id === existingPromptId)?.group_id ?? groups[0].id
          : groups[0].id
      )
    }
  }, [groups, groupId, existingPromptId, prompts])

  const selectedGroup = groups.find(g => g.id === groupId)
  const accessKind = accessFor(selectedGroup, activeUser)
  const canDirectWrite =
    Boolean(selectedGroup?.is_personal) ||
    accessKind === 'GROUP_MANAGER' ||
    accessKind === 'ADMIN'
  const groupPrompts = prompts.filter(p => p.group_id === groupId)

  // Derived user quota description
  const userPlan = activeUser?.plan || 'community'
  const isWorkspaceAdmin = Boolean(activeUser?.is_workspace_admin)
  let quotaBadgeText = 'Community: 20 prompts (10 ver/prompt)'
  if (isWorkspaceAdmin) {
    quotaBadgeText = 'Admin: Unlimited prompts'
  } else if (userPlan === 'pro') {
    quotaBadgeText = 'Pro: 100 prompts (50 ver/prompt)'
  } else if (userPlan === 'team') {
    quotaBadgeText = 'Team: 500 prompts (100 ver/prompt)'
  } else if (userPlan === 'enterprise') {
    quotaBadgeText = 'Enterprise: 10,000 prompts'
  }

  const oversizedFiles = files.filter(f => f.size > MAX_FILE_SIZE_BYTES)
  const hasOversized = oversizedFiles.length > 0
  const isUpdatingSinglePrompt = Boolean(promptId)
  const totalBytes = files.reduce((acc, f) => acc + f.size, 0)

  function acceptFiles(list: File[]) {
    setError('')
    if (!list.length) return

    let workingList = list
    if (isUpdatingSinglePrompt && workingList.length > 1) {
      setError(
        'When updating an existing prompt, only 1 file can be uploaded as the new version. The first file was selected.'
      )
      workingList = [workingList[0]]
    } else if (workingList.length > MAX_BATCH_FILES) {
      setError(
        `You can upload at most ${MAX_BATCH_FILES} files at once. The first ${MAX_BATCH_FILES} files were selected.`
      )
      workingList = workingList.slice(0, MAX_BATCH_FILES)
    }

    const validFiles: File[] = []
    const unsupportedFiles: string[] = []
    const oversizedNames: string[] = []

    for (const file of workingList) {
      if (ALLOWED_EXTENSIONS_REGEX.test(file.name)) {
        validFiles.push(file)
        if (file.size > MAX_FILE_SIZE_BYTES) {
          oversizedNames.push(`${file.name} (${formatBytes(file.size)})`)
        }
      } else {
        unsupportedFiles.push(file.name)
      }
    }

    if (unsupportedFiles.length > 0) {
      setError(
        `Unsupported file type: ${unsupportedFiles.join(', ')}. Only .txt, .md, .csv, and .json files are allowed.`
      )
    } else if (oversizedNames.length > 0) {
      setError(
        `File exceeds the 1 MB limit: ${oversizedNames.join(', ')}. Please remove or reduce file size before uploading.`
      )
    }

    setFiles(validFiles)
  }

  function removeFile(fileToRemove: File) {
    const nextFiles = files.filter(f => f !== fileToRemove)
    setFiles(nextFiles)
    if (error && fileToRemove.size > MAX_FILE_SIZE_BYTES) {
      const remainingOversized = nextFiles.filter(f => f.size > MAX_FILE_SIZE_BYTES)
      if (remainingOversized.length === 0) {
        setError('')
      } else {
        setError(
          `File exceeds the 1 MB limit: ${remainingOversized.map(f => `${f.name} (${formatBytes(f.size)})`).join(', ')}.`
        )
      }
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!files.length || !groupId || hasOversized) return

    const form = new FormData()
    form.set('group_id', groupId)
    if (promptId) form.set('prompt_id', promptId)
    form.set('change_note', note)
    files.forEach(file => form.append('files', file))

    setBusy(true)
    setError('')
    try {
      const res = await api<{
        created_prompt_ids?: string[]
        updated_prompt_ids?: string[]
        proposal_ids?: string[]
      }>('/api/prompts/upload-files', { method: 'POST', body: form })

      if (res.proposal_ids && res.proposal_ids.length > 0) {
        notify('Review request submitted', {
          description: 'The file was submitted as a review request.',
        })
      } else {
        notify(promptId ? 'New version uploaded' : 'Files imported', {
          description: `${files.length} file${files.length === 1 ? '' : 's'} processed.`,
        })
      }
      onComplete()
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Upload failed. Check the file type, size (max 1 MB), and try again.'
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      as="form"
      size="lg"
      onSubmit={e => void submit(e)}
      title={
        existingPromptId
          ? canDirectWrite
            ? 'Upload a new version'
            : 'Upload file for review'
          : 'Upload prompt files'
      }
      description={
        existingPromptId
          ? canDirectWrite
            ? 'The file’s text becomes the next version of this prompt.'
            : 'The file’s text is submitted as a review request.'
          : 'Import prompts from text, Markdown, CSV, or JSON files into your workspace.'
      }
      icon={<FileUp size={18} />}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary"
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !files.length || !groupId || hasOversized}
            className="btn-primary"
          >
            {busy
              ? 'Uploading…'
              : promptId
              ? canDirectWrite
                ? 'Upload version'
                : 'Submit for review'
              : `Import ${files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : 'files'}`}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {!existingPromptId && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <span className="field-label">Save to</span>
              <GroupSelectDropdown
                groups={groups}
                value={groupId}
                onChange={nextGroup => {
                  setGroupId(nextGroup)
                  if (promptId) {
                    setPromptId(
                      prompts.find(p => p.group_id === nextGroup)?.id ?? ''
                    )
                  }
                }}
              />
            </div>
            <div>
              <span className="field-label">What should happen?</span>
              <div className="segmented flex w-full">
                <button
                  type="button"
                  onClick={() => setPromptId('')}
                  className={`segmented-item flex-1 ${!promptId ? 'segmented-item-active' : ''}`}
                >
                  New prompts
                </button>
                <button
                  type="button"
                  disabled={!groupPrompts.length}
                  onClick={() => setPromptId(groupPrompts[0]?.id ?? '')}
                  className={`segmented-item flex-1 disabled:opacity-40 ${promptId ? 'segmented-item-active' : ''}`}
                >
                  New version
                </button>
              </div>
            </div>
          </div>
        )}

        {!existingPromptId && promptId && groupPrompts.length > 0 && (
          <div>
            <span className="field-label">Prompt to update</span>
            <PromptSelectDropdown
              prompts={groupPrompts}
              value={promptId}
              onChange={setPromptId}
            />
          </div>
        )}

        <div>
          <label className="field-label" htmlFor="up-note">
            Change note
          </label>
          <input
            id="up-note"
            value={note}
            onChange={e => setNote(e.target.value)}
            className="field"
            placeholder="Brief description of this import or version…"
          />
        </div>

        {/* Upload Limits & Specifications Card */}
        <div className="rounded-xl border border-slate-200/90 bg-slate-50/70 p-3.5 text-xs text-slate-600 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
            <div className="flex items-center gap-1.5 font-semibold text-slate-800 dark:text-zinc-200">
              <Info size={14} className="text-brand-600 dark:text-brand-400" />
              <span>Upload Specifications &amp; Limits</span>
            </div>
            <span
              className="inline-flex items-center gap-1 rounded-full bg-slate-200/70 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:bg-zinc-800 dark:text-zinc-300"
              title="New prompts count against your active plan quota"
            >
              <ShieldCheck size={12} className="text-brand-600 dark:text-brand-400" />
              {quotaBadgeText}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg border border-slate-200/70 bg-white p-2 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900">
              <span className="block text-[10px] font-medium uppercase tracking-wider text-slate-400 dark:text-zinc-500">
                File size
              </span>
              <span className="mt-0.5 block font-semibold text-slate-800 dark:text-zinc-200">
                Max 1 MB / file
              </span>
            </div>
            <div className="rounded-lg border border-slate-200/70 bg-white p-2 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900">
              <span className="block text-[10px] font-medium uppercase tracking-wider text-slate-400 dark:text-zinc-500">
                Batch limit
              </span>
              <span className="mt-0.5 block font-semibold text-slate-800 dark:text-zinc-200">
                {isUpdatingSinglePrompt ? '1 file (version)' : 'Max 10 files'}
              </span>
            </div>
            <div className="rounded-lg border border-slate-200/70 bg-white p-2 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900">
              <span className="block text-[10px] font-medium uppercase tracking-wider text-slate-400 dark:text-zinc-500">
                CSV / JSON
              </span>
              <span className="mt-0.5 block font-semibold text-slate-800 dark:text-zinc-200">
                Max 200 rows
              </span>
            </div>
            <div className="rounded-lg border border-slate-200/70 bg-white p-2 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900">
              <span className="block text-[10px] font-medium uppercase tracking-wider text-slate-400 dark:text-zinc-500">
                Prompt length
              </span>
              <span className="mt-0.5 block font-semibold text-slate-800 dark:text-zinc-200">
                100k chars max
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowFormatGuide(!showFormatGuide)}
            className="mt-2.5 inline-flex items-center gap-1 font-medium text-brand-700 hover:text-brand-800 dark:text-brand-400 dark:hover:text-brand-300 transition"
          >
            <span>
              {showFormatGuide
                ? 'Hide format specifications'
                : 'View format requirements (.txt, .md, .csv, .json)'}
            </span>
            {showFormatGuide ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>

          {showFormatGuide && (
            <div className="mt-2.5 space-y-2 border-t border-slate-200/80 pt-2.5 text-[11px] leading-relaxed text-slate-600 dark:border-zinc-800 dark:text-zinc-400">
              <p>
                <strong className="text-slate-800 dark:text-zinc-200">.txt / .md:</strong>{' '}
                Creates a prompt using the file name as the title and text as the prompt content.
              </p>
              <p>
                <strong className="text-slate-800 dark:text-zinc-200">.csv:</strong> Must have{' '}
                <code className="rounded-sm bg-slate-200/70 px-1 py-0.5 font-mono text-[10px] text-slate-800 dark:bg-zinc-800 dark:text-zinc-200">
                  title
                </code>{' '}
                and{' '}
                <code className="rounded-sm bg-slate-200/70 px-1 py-0.5 font-mono text-[10px] text-slate-800 dark:bg-zinc-800 dark:text-zinc-200">
                  content
                </code>{' '}
                column headers (optional:{' '}
                <code className="rounded-sm bg-slate-200/70 px-1 py-0.5 font-mono text-[10px] text-slate-800 dark:bg-zinc-800 dark:text-zinc-200">
                  description
                </code>
                ). Maximum 200 rows per file.
              </p>
              <p>
                <strong className="text-slate-800 dark:text-zinc-200">.json:</strong> An array of{' '}
                <code className="rounded-sm bg-slate-200/70 px-1 py-0.5 font-mono text-[10px] text-slate-800 dark:bg-zinc-800 dark:text-zinc-200">
                  {`{"title": "...", "content": "..."}`}
                </code>{' '}
                objects, or a root object with a{' '}
                <code className="rounded-sm bg-slate-200/70 px-1 py-0.5 font-mono text-[10px] text-slate-800 dark:bg-zinc-800 dark:text-zinc-200">
                  &quot;prompts&quot;
                </code>{' '}
                array. Maximum 200 prompts.
              </p>
              <p className="text-slate-500 dark:text-zinc-500 italic">
                Note: Files must be valid UTF-8 text. Binary formats (.zip, .pdf, .exe) and null bytes are rejected.
              </p>
            </div>
          )}
        </div>

        {/* Drag and Drop Upload Area */}
        <input
          ref={input}
          type="file"
          accept=".txt,.md,.csv,.json"
          multiple={!isUpdatingSinglePrompt}
          className="hidden"
          onChange={e => acceptFiles(Array.from(e.target.files ?? []))}
        />
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={e => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => {
            e.preventDefault()
            setDragging(false)
            acceptFiles(Array.from(e.dataTransfer.files))
          }}
          className={`w-full rounded-xl border-2 border-dashed px-5 py-7 text-center transition ${
            dragging
              ? 'border-brand-500 bg-brand-50/70 dark:border-brand-400 dark:bg-brand-950/40'
              : 'border-slate-300 bg-slate-50/60 hover:border-brand-400 hover:bg-brand-50/30 dark:border-zinc-700 dark:bg-zinc-900/60 dark:hover:border-zinc-600 dark:hover:bg-zinc-800/40'
          }`}
        >
          <span className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-white text-slate-500 shadow-xs ring-1 ring-slate-200 dark:bg-zinc-800 dark:text-zinc-400 dark:ring-zinc-700">
            <UploadCloud size={18} />
          </span>
          <span className="mt-3 block text-sm text-slate-700 dark:text-zinc-300">
            <span className="font-semibold text-brand-700 dark:text-brand-400">
              Click to choose
            </span>{' '}
            or drag and drop
          </span>
          <span className="mt-1 block text-xs text-slate-500 dark:text-zinc-400">
            .txt, .md, .csv or .json • Max 1 MB per file {isUpdatingSinglePrompt ? '• 1 file' : '• Up to 10 files'}
          </span>
        </button>

        {/* Selected Files List with Size & Status Validation */}
        {files.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-zinc-400 px-1">
              <span>
                Selected {files.length} file{files.length === 1 ? '' : 's'} ({formatBytes(totalBytes)} total)
              </span>
              <button
                type="button"
                onClick={() => setFiles([])}
                className="text-xs text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200"
              >
                Clear all
              </button>
            </div>

            <ul className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
              {files.map(f => {
                const isTooLarge = f.size > MAX_FILE_SIZE_BYTES
                return (
                  <li
                    key={f.name}
                    className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition ${
                      isTooLarge
                        ? 'border-rose-300 bg-rose-50/60 text-rose-900 dark:border-rose-900/70 dark:bg-rose-950/40 dark:text-rose-200'
                        : 'border-slate-200 bg-white dark:border-zinc-800 dark:bg-zinc-950/40 text-slate-700 dark:text-zinc-200'
                    }`}
                  >
                    <FileText
                      size={15}
                      className={`shrink-0 ${
                        isTooLarge
                          ? 'text-rose-500 dark:text-rose-400'
                          : 'text-slate-400 dark:text-zinc-500'
                      }`}
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {f.name}
                    </span>

                    {/* File Size & Status Badge */}
                    <div className="flex items-center gap-2 shrink-0">
                      {isTooLarge ? (
                        <span className="inline-flex items-center gap-1 rounded-sm bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-800 dark:bg-rose-900/60 dark:text-rose-200">
                          <AlertCircle size={12} />
                          {formatBytes(f.size)} (Exceeds 1 MB)
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-sm bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-zinc-800 dark:text-zinc-300">
                          <CheckCircle2 size={12} className="text-emerald-600 dark:text-emerald-400" />
                          {formatBytes(f.size)}
                        </span>
                      )}

                      <button
                        type="button"
                        aria-label={`Remove ${f.name}`}
                        onClick={() => removeFile(f)}
                        className="rounded-sm p-0.5 text-slate-400 hover:text-slate-700 dark:text-zinc-500 dark:hover:text-zinc-300"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {/* Global Error message / warning */}
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300 flex items-start gap-2"
          >
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-rose-600 dark:text-rose-400" />
            <span className="flex-1">{error}</span>
          </p>
        )}
      </div>
    </Modal>
  )
}
