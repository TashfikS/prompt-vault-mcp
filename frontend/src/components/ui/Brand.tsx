import { Fragment, useId } from 'react'

/** PromptHold mark: a secure stronghold tile holding prompt version threads and an active revision node. */
export function LogoMark({ size = 32, className = '' }: { size?: number; className?: string }) {
  // Unique per instance: a duplicate id inside a display:none subtree leaves the visible mark unpainted.
  const uid = useId().replace(/:/g, '')
  const grad = `ph-grad-${uid}`
  const accent = `ph-accent-${uid}`
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden className={className}>
      <defs>
        <linearGradient id={grad} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0f766e" />
          <stop offset="1" stopColor="#115e59" />
        </linearGradient>
        <linearGradient id={accent} x1="18" y1="18" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop stopColor="#5eead4" />
          <stop offset="1" stopColor="#2dd4bf" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${grad})`} />
      <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" stroke="rgba(255, 255, 255, 0.15)" strokeWidth="1" />
      <path d="M9 11.5h14" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M9 16.5h9.5" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M9 21.5h7.5" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="21.5" cy="21.5" r="2.5" fill={`url(#${accent})`} />
      <circle cx="21.5" cy="21.5" r="1.1" fill="#042f2e" />
    </svg>
  )
}

export function Logo({ subtitle }: { subtitle?: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark />
      <span className="leading-tight">
        <span className="block text-[15px] font-semibold tracking-tight text-slate-900 dark:text-zinc-100">PromptHold</span>
        {subtitle && <span className="block text-xs text-slate-500 dark:text-zinc-400">{subtitle}</span>}
      </span>
    </span>
  )
}

const VAR_PATTERN = /(\{\{\s*[a-zA-Z0-9_ -]+\s*\}\})/g

/** Renders prompt text with {{fields}} highlighted as tokens — the visual signature used across the app. */
export function PromptText({ text, values }: { text: string; values?: Record<string, string> }) {
  const parts = text.split(VAR_PATTERN)
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return <Fragment key={i}>{part}</Fragment>
        const key = part.replace(/\{\{|\}\}/g, '').trim()
        const filled = values?.[key]
        return filled ? (
          <mark key={i} className="rounded-sm bg-brand-100/70 px-0.5 text-brand-900 dark:bg-brand-950/80 dark:text-brand-200">{filled}</mark>
        ) : (
          <span key={i} className="whitespace-nowrap rounded-md bg-brand-50 px-1 py-px font-medium text-brand-700 ring-1 ring-inset ring-brand-600/15 dark:bg-brand-950/60 dark:text-brand-300 dark:ring-brand-500/30">
            {part}
          </span>
        )
      })}
    </>
  )
}

export function initials(name?: string) {
  if (!name) return 'U'
  return name.split(' ').map(part => part[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || 'U'
}

const AVATAR_TONES = [
  'bg-brand-100 text-brand-800 dark:bg-brand-950/70 dark:text-brand-300',
  'bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300',
  'bg-sky-100 text-sky-800 dark:bg-sky-950/70 dark:text-sky-300',
  'bg-rose-100 text-rose-800 dark:bg-rose-950/70 dark:text-rose-300',
  'bg-violet-100 text-violet-800 dark:bg-violet-950/70 dark:text-violet-300',
  'bg-slate-200 text-slate-700 dark:bg-zinc-800 dark:text-zinc-300',
]

export function Avatar({ name, size = 'md' }: { name?: string; size?: 'sm' | 'md' | 'lg' }) {
  const safeName = name || 'User'
  const tone = AVATAR_TONES[[...safeName].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_TONES.length]
  const dims = size === 'sm' ? 'h-6 w-6 text-[10px]' : size === 'lg' ? 'h-10 w-10 text-sm' : 'h-8 w-8 text-xs'
  return <span aria-hidden className={`grid shrink-0 place-items-center rounded-full font-semibold ${dims} ${tone}`}>{initials(safeName)}</span>
}

export function timeAgo(iso: string) {
  const then = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`).getTime()
  const s = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hr ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
