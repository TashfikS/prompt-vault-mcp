import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Braces, History, Plus, ShieldCheck, Sparkles } from 'lucide-react'
import type { User } from '../types'
import { LogoMark } from './ui/Brand'

type Step = {
  target?: string
  title: string
  body: ReactNode
}

type Rect = { top: number; left: number; width: number; height: number }

const CARD_W = 340

function buildSteps(user: User): Step[] {
  return [
    { title: 'welcome', body: null },
    {
      target: 'nav-library',
      title: 'Your prompt library',
      body: 'Every prompt you can access lives here — from your private space and every group you belong to. Open one to fill it in, copy it, or see its history.',
    },
    {
      target: 'spaces',
      title: 'Spaces keep things organised',
      body: (
        <>
          <strong className="font-medium text-slate-900 dark:text-zinc-100">Personal</strong> is private to you. Group spaces are shared with your team. The badge beside each group shows your role there — <strong className="font-medium text-slate-900 dark:text-zinc-100">hover it</strong> to see what you can do.
        </>
      ),
    },
    {
      target: 'new-prompt',
      title: 'Create a prompt',
      body: (
        <>
          Write it once, reuse it everywhere. Add fill-in fields like <code className="rounded bg-brand-50 px-1 font-mono text-[12px] text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">{'{{customer_name}}'}</code> and PromptHold turns them into a simple form.
        </>
      ),
    },
    {
      target: 'nav-groups',
      title: user.is_workspace_admin ? 'Manage groups & access' : 'Work with your team',
      body: user.is_workspace_admin
        ? 'As a workspace admin you can create groups, assign each one an Owner, and adjust anyone’s role.'
        : 'Create a group to share prompts. You’ll be its Owner and can invite teammates by email as Members or Guests.',
    },
    {
      target: 'connect-ai',
      title: 'Connect to AI & custom agents',
      body: 'Connect your desktop AI clients, coding assistants, or custom agents using MCP or the REST API to pull in prompts and save new versions automatically.',
    },
    {
      target: 'price-and-plan',
      title: 'Plans & prompt quotas',
      body: 'Check your current plan, monitor prompt limits, and upgrade to unlock team approval workflows or bring-your-own-storage whenever you are ready.',
    },
    {
      target: 'help',
      title: 'Help is always here',
      body: 'Replay this tour or open the roles guide any time.',
    },
    { title: 'done', body: null },
  ]
}

function measure(target?: string): Rect | null {
  if (!target) return null
  const el = document.querySelector<HTMLElement>(`[data-tour="${target}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return null
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

export default function OnboardingTour({ user, onFinish }: { user: User; onFinish: (next?: 'create') => void }) {
  const steps = buildSteps(user)
  const [index, setIndex] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)
  const step = steps[index]
  const isWelcome = index === 0
  const isDone = index === steps.length - 1
  const tourSteps = steps.length - 2
  const firstName = user.name.split(' ')[0]

  const next = useCallback(() => setIndex(i => Math.min(i + 1, steps.length - 1)), [steps.length])
  const back = useCallback(() => setIndex(i => Math.max(i - 1, 0)), [])

  useLayoutEffect(() => {
    const el = step.target ? document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`) : null
    el?.scrollIntoView({ block: 'nearest' })
    const update = () => setRect(measure(step.target))
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true) }
  }, [step.target])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onFinish()
      if (e.key === 'ArrowRight' && !isDone) next()
      if (e.key === 'ArrowLeft') back()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onFinish, next, back, isDone])

  const pad = 6
  let cardStyle: React.CSSProperties = {}
  const centered = !rect
  if (rect) {
    const vw = window.innerWidth
    const vh = window.innerHeight
    if (rect.left + rect.width + pad + 16 + CARD_W < vw && rect.width < vw / 2) {
      cardStyle = { left: rect.left + rect.width + pad + 16, top: Math.max(16, Math.min(rect.top - 8, vh - 260)) }
    } else {
      const below = rect.top + rect.height + pad + 12
      cardStyle = { left: Math.max(16, Math.min(rect.left + rect.width - CARD_W, vw - CARD_W - 16)), top: below + 220 < vh ? below : Math.max(16, rect.top - pad - 232) }
    }
  }

  const progress = (
    <div className="flex items-center gap-1" aria-label={`Step ${index} of ${tourSteps}`}>
      {Array.from({ length: tourSteps }).map((_, i) => (
        <span key={i} className={`h-1.5 rounded-full transition-all ${i + 1 === index ? 'w-5 bg-brand-600' : i + 1 < index ? 'w-1.5 bg-brand-300 dark:bg-brand-400' : 'w-1.5 bg-slate-200 dark:bg-zinc-800'}`} />
      ))}
    </div>
  )

  return createPortal(
    <div className="fixed inset-0 z-[90]" aria-live="polite">
      {rect ? (
        <div
          aria-hidden
          className="pointer-events-none fixed rounded-xl ring-2 ring-white/80 transition-all duration-300 ease-out"
          style={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2, boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.65)' }}
        />
      ) : (
        <div aria-hidden className="fixed inset-0 animate-fade-in bg-black/60 backdrop-blur-[2px]" />
      )}

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        data-tour-dialog
        style={centered ? undefined : { ...cardStyle, width: CARD_W }}
        className={
          centered
            ? 'fixed left-1/2 top-1/2 w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 animate-pop-in rounded-2xl bg-white shadow-pop dark:border dark:border-zinc-800 dark:bg-zinc-900'
            : 'fixed animate-pop-in rounded-2xl bg-white shadow-pop dark:border dark:border-zinc-800 dark:bg-zinc-900'
        }
      >
        {isWelcome ? (
          <div className="p-7">
            <LogoMark size={40} />
            <h2 id="tour-title" className="mt-5 text-xl font-semibold tracking-tight text-slate-900 dark:text-zinc-100">Welcome to PromptHold, {firstName}</h2>
            <p className="mt-1.5 text-sm leading-6 text-slate-500 dark:text-zinc-400">A shared home for the prompts your team relies on. Here’s the idea in three parts:</p>
            <ul className="mt-5 space-y-3.5">
              {[
                { icon: <Braces size={16} />, title: 'Reusable prompts', text: 'Write a prompt once with fill-in fields, then reuse it in seconds.' },
                { icon: <History size={16} />, title: 'Every change is saved', text: 'Each edit becomes a new version you can compare or switch back to.' },
                { icon: <ShieldCheck size={16} />, title: 'Clear access', text: 'Groups and roles decide who can view, suggest or publish changes.' },
              ].map(item => (
                <li key={item.title} className="flex gap-3">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">{item.icon}</span>
                  <span className="text-sm leading-5">
                    <span className="block font-medium text-slate-900 dark:text-zinc-100">{item.title}</span>
                    <span className="text-slate-500 dark:text-zinc-400">{item.text}</span>
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-7 flex items-center justify-between gap-3">
              <button type="button" data-tour-skip onClick={() => onFinish()} className="btn-ghost -ml-2">Skip for now</button>
              <button type="button" onClick={next} className="btn-primary" autoFocus>Show me around</button>
            </div>
          </div>
        ) : isDone ? (
          <div className="p-7 text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-brand-50 text-brand-700 ring-8 ring-brand-50/50 dark:bg-brand-950/60 dark:text-brand-300 dark:ring-brand-950/40"><Sparkles size={20} /></span>
            <h2 id="tour-title" className="mt-5 text-xl font-semibold tracking-tight text-slate-900 dark:text-zinc-100">You’re all set</h2>
            <p className="mx-auto mt-1.5 max-w-sm text-sm leading-6 text-slate-500 dark:text-zinc-400">A good first step is saving a prompt you already use. It’ll go into your Personal space unless you pick a group.</p>
            <div className="mt-6 flex flex-col-reverse justify-center gap-2.5 sm:flex-row">
              <button type="button" onClick={() => onFinish()} className="btn-secondary">Explore the library</button>
              <button type="button" onClick={() => onFinish('create')} className="btn-primary" autoFocus><Plus size={16} /> Create my first prompt</button>
            </div>
          </div>
        ) : (
          <div className="p-5">
            <div className="flex items-center justify-between">
              {progress}
              <span className="text-xs tabular-nums text-slate-400 dark:text-zinc-500">{index} of {tourSteps}</span>
            </div>
            <h2 id="tour-title" className="mt-4 text-base font-semibold text-slate-900 dark:text-zinc-100">{step.title}</h2>
            <p className="mt-1.5 text-sm leading-6 text-slate-600 dark:text-zinc-300">{step.body}</p>
            <div className="mt-5 flex items-center justify-between">
              <button type="button" data-tour-skip onClick={() => onFinish()} className="text-sm text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200">Skip tour</button>
              <div className="flex gap-2">
                <button type="button" onClick={back} className="btn-secondary btn-sm px-2" aria-label="Previous step"><ArrowLeft size={15} /></button>
                <button type="button" onClick={next} className="btn-primary btn-sm px-3.5" autoFocus>{index === tourSteps ? 'Finish' : 'Next'}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
