import { cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'

type Side = 'top' | 'bottom' | 'right'

/**
 * Hover + keyboard-focus tooltip / hover card.
 * Rendered in a portal with fixed positioning so it is never clipped by scrolling lists or modals.
 */
export default function Tooltip({
  content,
  children,
  side = 'top',
  width = 'w-64',
  delay = 120,
}: {
  content: ReactNode
  children: ReactElement
  side?: Side
  width?: string
  delay?: number
}) {
  const id = useId()
  const triggerRef = useRef<HTMLElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; side: Side }>({ top: -9999, left: -9999, side })

  const show = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOpen(true), delay)
  }, [delay])
  const hide = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOpen(false), 80)
  }, [])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !cardRef.current) return
    const place = () => {
      const t = triggerRef.current!.getBoundingClientRect()
      const c = cardRef.current!.getBoundingClientRect()
      const gap = 8
      const vw = window.innerWidth
      const vh = window.innerHeight
      let s: Side = side
      if (s === 'top' && t.top - c.height - gap < 8) s = 'bottom'
      if (s === 'bottom' && t.bottom + c.height + gap > vh - 8 && t.top - c.height - gap > 8) s = 'top'
      if (s === 'right' && t.right + c.width + gap > vw - 8) s = 'bottom'
      let top = 0
      let left = 0
      if (s === 'right') {
        top = t.top + t.height / 2 - c.height / 2
        left = t.right + gap
      } else {
        top = s === 'top' ? t.top - c.height - gap : t.bottom + gap
        left = t.left + t.width / 2 - c.width / 2
      }
      left = Math.max(8, Math.min(left, vw - c.width - 8))
      top = Math.max(8, Math.min(top, vh - c.height - 8))
      setPos({ top, left, side: s })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, side])

  useEffect(() => {
    if (!open) return
    // Capture phase + stopPropagation so Escape only dismisses this card, not the dialog underneath.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  if (!isValidElement(children)) return children
  const child = children as ReactElement<Record<string, unknown>>
  const trigger = cloneElement(child, {
    ref: (node: HTMLElement | null) => { triggerRef.current = node },
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hide,
    'aria-describedby': open ? id : undefined,
  })

  return (
    <>
      {trigger}
      {open &&
        createPortal(
          <div
            ref={cardRef}
            id={id}
            role="tooltip"
            onMouseEnter={show}
            onMouseLeave={hide}
            style={{ top: pos.top, left: pos.left }}
            className={`fixed z-[70] ${width} animate-pop-in rounded-xl border border-slate-200 bg-white p-3.5 text-left text-[13px] leading-5 text-slate-600 shadow-pop dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300`}
          >
            {content}
          </div>,
          document.body
        )}
    </>
  )
}
