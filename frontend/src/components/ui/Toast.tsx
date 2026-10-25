import { createContext, useCallback, useContext, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'

type Tone = 'success' | 'error' | 'info'
type ToastItem = { id: number; tone: Tone; title: string; description?: string }
type Notify = (title: string, options?: { tone?: Tone; description?: string }) => void

const ToastContext = createContext<Notify>(() => undefined)

export function useToast() {
  return useContext(ToastContext)
}

const toneStyle: Record<Tone, { icon: typeof Info; color: string }> = {
  success: { icon: CheckCircle2, color: 'text-brand-600' },
  error: { icon: AlertCircle, color: 'text-rose-600' },
  info: { icon: Info, color: 'text-slate-500' },
}

/** App-wide toast notifications (bottom-right, auto-dismiss, screen-reader announced). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const seq = useRef(0)

  const dismiss = useCallback((id: number) => setItems(list => list.filter(t => t.id !== id)), [])
  const notify = useCallback<Notify>((title, options) => {
    const id = ++seq.current
    setItems(list => [...list.slice(-3), { id, title, tone: options?.tone ?? 'success', description: options?.description }])
    window.setTimeout(() => dismiss(id), options?.tone === 'error' ? 6000 : 4000)
  }, [dismiss])

  return (
    <ToastContext.Provider value={notify}>
      {children}
      {createPortal(
        <div aria-live="polite" className="pointer-events-none fixed bottom-5 right-5 z-[80] flex w-[min(380px,calc(100vw-2.5rem))] flex-col gap-2">
          {items.map(t => {
            const { icon: Icon, color } = toneStyle[t.tone]
            return (
              <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'} className="pointer-events-auto flex animate-toast-in items-start gap-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-pop dark:border-zinc-800 dark:bg-zinc-900">
                <Icon size={18} className={`mt-px shrink-0 ${color}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-900 dark:text-zinc-100">{t.title}</p>
                  {t.description && <p className="mt-0.5 text-[13px] text-slate-500 dark:text-zinc-400">{t.description}</p>}
                </div>
                <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss notification" className="rounded p-0.5 text-slate-400 hover:text-slate-700 dark:text-zinc-500 dark:hover:text-zinc-300">
                  <X size={15} />
                </button>
              </div>
            )
          })}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  )
}
