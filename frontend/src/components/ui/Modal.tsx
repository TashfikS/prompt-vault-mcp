import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

/**
 * Centered dialog shell. Handles Escape, backdrop click, initial focus, scroll lock and focus return.
 */
export default function Modal({
  title,
  description,
  icon,
  iconWrapper = true,
  children,
  footer,
  onClose,
  size = 'md',
  busy = false,
  as = 'div',
  onSubmit,
}: {
  title: ReactNode
  description?: ReactNode
  icon?: ReactNode
  iconWrapper?: boolean
  children?: ReactNode
  footer?: ReactNode
  onClose: () => void
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl'
  busy?: boolean
  as?: 'div' | 'form'
  onSubmit?: (e: React.FormEvent) => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const first = panelRef.current?.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]), textarea:not([disabled]), [data-autofocus]')
    ;(first ?? panelRef.current)?.focus()
    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation()
        closeRef.current()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
      previouslyFocused?.focus?.()
    }
  }, [busy])

  const width = size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-2xl' : size === 'xl' ? 'max-w-3xl' : size === '2xl' ? 'max-w-5xl' : 'max-w-lg'
  const Panel = as
  return createPortal(
    <div
      className="fixed inset-0 z-[60] grid animate-fade-in place-items-center overflow-y-auto bg-black/50 p-4 backdrop-blur-[2px]"
      onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose() }}
    >
      <Panel
        ref={panelRef as never}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onSubmit={onSubmit}
        className={`w-full ${width} animate-pop-in rounded-2xl bg-white shadow-pop outline-none ring-1 ring-slate-900/5 dark:bg-zinc-900 dark:ring-zinc-800 dark:border dark:border-zinc-800`}
      >
        <div className="flex items-start gap-3.5 px-6 pt-6">
          {icon && (
            iconWrapper ? (
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-700 ring-8 ring-brand-50/50 dark:bg-brand-950/60 dark:text-brand-300 dark:ring-brand-950/40">
                {icon}
              </div>
            ) : (
              <div className="shrink-0 flex items-center justify-center">
                {icon}
              </div>
            )
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-zinc-100 flex items-center leading-7 min-h-[28px]">{title}</h2>
            {description && <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-zinc-400">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close dialog"
            className="-mr-2 -mt-1 rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          >
            <X size={18} />
          </button>
        </div>
        {children && <div className="px-6 pt-5">{children}</div>}
        {footer ? (
          <div className="mt-6 flex flex-wrap justify-end gap-2.5 border-t border-slate-100 bg-slate-50/60 px-6 py-4 rounded-b-2xl dark:border-zinc-800 dark:bg-zinc-950/50">
            {footer}
          </div>
        ) : (
          <div className="h-6" />
        )}
      </Panel>
    </div>,
    document.body
  )
}
