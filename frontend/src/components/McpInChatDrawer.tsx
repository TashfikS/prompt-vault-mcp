import { useState } from 'react'
import { useApp } from '@modelcontextprotocol/ext-apps/react'
import { ArrowUpRight, KeyRound, Send } from 'lucide-react'
import type { PromptItem } from '../types'
import { LogoMark, PromptText } from './ui/Brand'
import AutoGrowingTextarea from './ui/AutoGrowingTextarea'

export default function McpInChatDrawer() {
  const [prompts, setPrompts] = useState<PromptItem[]>([])
  const [selected, setSelected] = useState<PromptItem | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [apiKey, setApiKey] = useState('')
  const [editedContent, setEditedContent] = useState('')
  const [note, setNote] = useState('')
  const { app, isConnected, error } = useApp({
    appInfo: { name: 'PromptHold', version: '2.0.0' },
    capabilities: {},
    onAppCreated: created => {
      created.ontoolresult = result => {
        const content = result.structuredContent as { prompts?: PromptItem[] } | undefined
        if (content?.prompts) setPrompts(content.prompts)
      }
    },
  })
  const vars = selected?.variables ?? []
  const compiled = editedContent.replace(/\{\{\s*([a-zA-Z0-9_ -]+)\s*\}\}/g, (match, key: string) => values[key.trim()] || match)

  async function loadPrompts() {
    if (!app || !apiKey.trim()) return
    try {
      const result = await app.callServerTool({ name: 'list_my_accessible_prompts', arguments: { api_key: apiKey.trim() } })
      const content = result.structuredContent as { prompts?: PromptItem[] } | undefined
      if (content?.prompts) {
        setPrompts(content.prompts)
        setNote('Loaded prompts for this API key.')
      } else setNote('No accessible prompts were returned. Check the key and try again.')
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not load prompts for this API key.')
    }
  }

  async function saveVersion() {
    if (!app || !selected || !apiKey.trim()) return
    try {
      const result = await app.callServerTool({
        name: 'save_prompt_version_from_chat',
        arguments: { api_key: apiKey.trim(), prompt_id: selected.id, new_content: editedContent, change_note: 'Updated via AI Chat' },
      })
      const content = result.structuredContent as { proposal_created?: boolean; message?: string } | undefined
      if (content?.proposal_created) {
        setNote(content.message || 'Submitted as a proposal for review.')
      } else {
        setNote('Saved a new prompt version from chat.')
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not save this prompt version.')
    }
  }

  return (
    <main className="min-h-screen bg-[#f6f7f9] p-4 text-slate-900 dark:bg-zinc-950 dark:text-zinc-100 sm:p-6">
      <div className="mx-auto max-w-xl">
        <header className="mb-5 flex items-center gap-3">
          <LogoMark size={36} />
          <div>
            <h1 className="text-base font-semibold text-slate-900 dark:text-zinc-100">PromptHold</h1>
            <p className="text-xs text-slate-500 dark:text-zinc-400">Your team prompts, ready for chat</p>
          </div>
          <span className={`ml-auto rounded-full px-2.5 py-0.5 text-xs font-medium ${
            isConnected
              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
              : 'bg-slate-200 text-slate-600 dark:bg-zinc-800 dark:text-zinc-400'
          }`}>
            {isConnected ? 'Connected' : 'Connecting'}
          </span>
        </header>

        {error && <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">Chat connection: {error.message}</p>}

        {!selected ? (
          <>
            <p className="mb-3 text-sm text-slate-500 dark:text-zinc-400">Enter your PromptHold API key to load only the prompts assigned to your spaces.</p>
            <div className="mb-4 flex gap-2">
              <input value={apiKey} onChange={e => setApiKey(e.target.value)} type="password" placeholder="Personal API key" className="field flex-1" />
              <button onClick={() => void loadPrompts()} disabled={!app || !isConnected || !apiKey.trim()} className="btn-primary">
                <KeyRound size={15} /> Load
              </button>
            </div>
            <div className="space-y-2">
              {prompts.map(prompt => (
                <button
                  key={prompt.id}
                  onClick={() => {
                    setSelected(prompt)
                    setEditedContent(prompt.content)
                    setValues(Object.fromEntries(prompt.variables.map(v => [v, ''])))
                  }}
                  className="card flex w-full items-center justify-between p-4 text-left transition hover:border-brand-300 dark:hover:border-zinc-700"
                >
                  <div>
                    <span className="text-xs font-medium text-brand-700 dark:text-brand-400">{prompt.group_name}</span>
                    <span className="mt-0.5 block font-semibold text-slate-900 dark:text-zinc-100">{prompt.title}</span>
                    <span className="mt-0.5 block line-clamp-2 text-xs text-slate-500 dark:text-zinc-400">{prompt.description}</span>
                  </div>
                  <ArrowUpRight size={17} className="text-slate-400 dark:text-zinc-500" />
                </button>
              ))}
            </div>
            {!prompts.length && (
              <div className="card border-dashed p-7 text-center text-sm text-slate-500 dark:text-zinc-400">
                Your prompt list will appear here after you load it with your API key.
              </div>
            )}
          </>
        ) : (
          <>
            <button onClick={() => setSelected(null)} className="mb-3 text-sm font-medium text-brand-700 hover:underline dark:text-brand-400">
              ← All prompts
            </button>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-zinc-100">{selected.title}</h2>
            <p className="text-xs text-slate-500 dark:text-zinc-400">{selected.group_name} · Version {selected.current_version_number}</p>
            {vars.map(key => (
              <label key={key} className="mt-3 block text-xs font-medium text-slate-700 dark:text-zinc-300">
                {key.replace(/[_-]/g, ' ')}
                <AutoGrowingTextarea
                  value={values[key] ?? ''}
                  onChange={val => setValues({ ...values, [key]: val })}
                  placeholder={`Enter ${key.replace(/[_-]/g, ' ')}…`}
                  minRows={1}
                  maxHeight={120}
                  className="mt-1"
                />
              </label>
            ))}
            <textarea value={editedContent} onChange={e => setEditedContent(e.target.value)} rows={7} aria-label="Prompt text" className="field mt-4 font-mono text-xs leading-5" />
            <div className="mt-3">
              <span className="block text-xs font-semibold text-slate-500 dark:text-zinc-400">Filled preview</span>
              <div className="mt-1 whitespace-pre-wrap break-anywhere break-words [overflow-wrap:anywhere] [word-break:break-word] rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-5 text-slate-800 dark:border-zinc-800 dark:bg-zinc-950/50 dark:text-zinc-200">
                <PromptText text={editedContent} values={values} />
              </div>
            </div>
            <button
              disabled={!app || !isConnected}
              onClick={() => {
                void app?.sendMessage({ role: 'user', content: [{ type: 'text', text: compiled }] })
                setNote('Prompt sent to the chat.')
              }}
              className="btn-primary mt-3 w-full"
            >
              <Send size={15} /> Send prompt to chat
            </button>
            <button disabled={!apiKey.trim() || !app || !isConnected} onClick={() => void saveVersion()} className="btn-secondary mt-2 w-full">
              Save as new prompt version
            </button>
          </>
        )}
        {note && <p className="mt-3 rounded-lg bg-brand-50 p-3 text-xs text-brand-800 dark:bg-brand-950/60 dark:text-brand-300">{note}</p>}
      </div>
    </main>
  )
}
