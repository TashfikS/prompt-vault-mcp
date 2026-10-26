import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowLeft, ArrowRight, Braces, CreditCard, GitBranch, LogIn, PlugZap, ShieldCheck, UserPlus } from 'lucide-react'
import { login, register, setSessionToken } from '../api'
import type { PricingPlanId } from '../types'
import { Logo, PromptText } from './ui/Brand'
import RoleBadge from './ui/RoleBadge'
import type { AccessKind } from './ui/RoleBadge'
import { ThemeToggleButton } from '../theme'

type Mode = 'login' | 'register'

const DEMO_ACCOUNTS: { name: string; email: string; role: AccessKind; context: string }[] = [
  { name: 'Alice Morgan', email: 'alice@example.com', role: 'ADMIN', context: 'Workspace Admin' },
  { name: 'Bob Chen', email: 'bob@example.com', role: 'GROUP_MANAGER', context: 'Marketing Owner · Sales Member' },
  { name: 'Charlie Rivera', email: 'charlie@example.com', role: 'MEMBER', context: 'Marketing Member' },
  { name: 'Ian Malcolm', email: 'ian@example.com', role: 'GUEST', context: 'Marketing Guest' },
]

const PLAN_PREVIEWS: { id: PricingPlanId; name: string; price: string; quota: string; badge?: string }[] = [
  { id: 'community', name: 'Community', price: '$0', quota: '20 prompts' },
  { id: 'pro', name: 'Pro', price: '$5/mo', quota: '100 prompts' },
  { id: 'team', name: 'Team', price: '$10/mo', quota: '500 prompts', badge: 'Popular' },
  { id: 'enterprise', name: 'Enterprise', price: 'Custom', quota: 'VPC / SSO' },
]

export default function LoginPage({
  onAuthenticated,
  onOpenPricing,
  initialMode = 'login',
  selectedPlan = 'community',
}: {
  onAuthenticated: () => void
  onOpenPricing?: () => void
  initialMode?: Mode
  selectedPlan?: PricingPlanId
}) {
  const [mode, setMode] = useState<Mode>(initialMode)
  const [planChoice, setPlanChoice] = useState<PricingPlanId>(selectedPlan)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setPlanChoice(selectedPlan)
  }, [selectedPlan])

  function switchMode(next: Mode) {
    setMode(next)
    setError('')
    setPassword('')
    setConfirm('')
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    if (mode === 'register' && password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    setBusy(true)
    try {
      if (mode === 'login') {
        const res = await login(email, password)
        setSessionToken(res.token)
      } else {
        const res = await register(name, email, password, planChoice)
        setSessionToken(res.token)
      }
      onAuthenticated()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Authentication failed. Please check your details.')
    } finally {
      setBusy(false)
    }
  }

  async function signInWith(demoEmail: string, demoPassword: string) {
    setError('')
    setBusy(true)
    try {
      const res = await login(demoEmail, demoPassword)
      setSessionToken(res.token)
      onAuthenticated()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Demo sign-in failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-screen bg-[#f6f7f9] text-slate-900 dark:bg-zinc-950 dark:text-zinc-100 lg:grid-cols-[1.08fr_1fr]">
      {/* Left showcase panel */}
      <aside className="relative hidden flex-col justify-between overflow-y-auto border-r border-slate-200/80 bg-white p-10 xl:p-14 lg:flex dark:border-zinc-800 dark:bg-zinc-950 custom-scrollbar">
        <div>
          <Logo subtitle="Enterprise prompt governance & version control" />

          <div className="mt-10 max-w-lg">
            <h2 className="text-3xl font-semibold tracking-tight text-slate-950 dark:text-zinc-50">
              Prompts your team can version, review, and trust.
            </h2>
            <p className="mt-3 text-base leading-7 text-slate-600 dark:text-zinc-400">
              Give every team a shared library of verified prompts with sequential version history, role-based review workflows, and direct MCP connection to your AI assistants and agents.
            </p>
          </div>

          {/* Live artifact preview card */}
          <div className="mt-7 max-w-lg rounded-2xl border border-slate-200 bg-slate-50/70 p-4.5 shadow-card dark:border-zinc-800 dark:bg-zinc-900/80">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/80 pb-3 dark:border-zinc-800">
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-brand-600 px-2 py-0.5 text-[11px] font-semibold text-white dark:bg-brand-700">Marketing</span>
                <span className="text-sm font-semibold text-slate-900 dark:text-zinc-100">Seasonal campaign writer</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-950/60 dark:text-emerald-300 dark:ring-emerald-500/30">
                  Active · v5
                </span>
                <RoleBadge kind="GROUP_MANAGER" size="sm" side="bottom" />
              </div>
            </div>
            <p className="mt-3 rounded-xl border border-slate-200/90 bg-white p-3 font-mono text-xs leading-6 text-slate-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
              <PromptText text="Create an upbeat campaign for {{product}} aimed at {{audience}}. Use a warm, helpful tone and include one clear call to action." />
            </p>
            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-zinc-400">
              <span>5 immutable versions · 2 fields detected</span>
              <span className="text-slate-400 dark:text-zinc-500">Hover role badge to inspect permissions</span>
            </div>
          </div>

          {/* Dedicated Plans & Pricing Showcase Section */}
          <section aria-label="Plans & Pricing Preview" className="mt-6 max-w-lg rounded-2xl border border-slate-200/90 bg-white p-4.5 shadow-card dark:border-zinc-800 dark:bg-zinc-900/90">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="grid h-6 w-6 place-items-center rounded-md bg-brand-50 text-brand-600 dark:bg-brand-950/80 dark:text-brand-300">
                  <CreditCard size={13} />
                </span>
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-zinc-300">
                  Plans &amp; Pricing
                </h3>
              </div>
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-950/80 dark:text-emerald-300">
                Zero Seat-Inflation
              </span>
            </div>

            <p className="mt-2 text-xs font-medium leading-5 text-slate-600 dark:text-zinc-300">
              Start free forever in your private Personal space, or upgrade to collaborate with team review gates. Only active editors pay; read-only reviewers are always free.
            </p>

            {/* 4 Mini Plan Cards */}
            <div className="mt-4 pt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="flex flex-col justify-between rounded-xl border border-slate-200/80 bg-slate-50/70 p-2.5 text-center transition hover:border-slate-300 dark:border-zinc-800 dark:bg-zinc-950/60 dark:hover:border-zinc-700">
                <div>
                  <span className="block text-[11px] font-bold text-slate-800 dark:text-zinc-200">Community</span>
                  <div className="mt-1 flex h-6 items-baseline justify-center gap-0.5">
                    <span className="text-base font-extrabold text-slate-950 dark:text-zinc-50">$0</span>
                  </div>
                </div>
                <div className="mt-1 flex min-h-[28px] items-center justify-center">
                  <span className="text-[10px] leading-tight text-slate-500 dark:text-zinc-400">20 prompts · FastMCP</span>
                </div>
              </div>

              <div className="flex flex-col justify-between rounded-xl border border-slate-200/80 bg-slate-50/70 p-2.5 text-center transition hover:border-slate-300 dark:border-zinc-800 dark:bg-zinc-950/60 dark:hover:border-zinc-700">
                <div>
                  <span className="block text-[11px] font-bold text-slate-800 dark:text-zinc-200">Pro</span>
                  <div className="mt-1 flex h-6 items-baseline justify-center gap-0.5">
                    <span className="text-base font-extrabold text-slate-950 dark:text-zinc-50">$5</span>
                    <span className="text-[10px] font-normal text-slate-500">/mo</span>
                  </div>
                </div>
                <div className="mt-1 flex min-h-[28px] items-center justify-center">
                  <span className="text-[10px] leading-tight text-slate-500 dark:text-zinc-400">100 prompts · BYOS</span>
                </div>
              </div>

              <div className="relative flex flex-col justify-between rounded-xl border border-brand-300 bg-brand-50/40 p-2.5 text-center shadow-2xs dark:border-brand-700/60 dark:bg-brand-950/30">
                <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-brand-600 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-white shadow-2xs">
                  Popular
                </span>
                <div>
                  <span className="block text-[11px] font-bold text-brand-900 dark:text-brand-200">Team</span>
                  <div className="mt-1 flex h-6 items-baseline justify-center gap-0.5">
                    <span className="text-base font-extrabold text-brand-950 dark:text-brand-100">$10</span>
                    <span className="text-[10px] font-normal text-brand-700/80 dark:text-brand-300/80">/ed/mo</span>
                  </div>
                </div>
                <div className="mt-1 flex min-h-[28px] items-center justify-center">
                  <span className="text-[10px] leading-tight font-semibold text-emerald-700 dark:text-emerald-400">+2 Free Guests</span>
                </div>
              </div>

              <div className="flex flex-col justify-between rounded-xl border border-slate-200/80 bg-slate-50/70 p-2.5 text-center transition hover:border-slate-300 dark:border-zinc-800 dark:bg-zinc-950/60 dark:hover:border-zinc-700">
                <div>
                  <span className="block text-[11px] font-bold text-slate-800 dark:text-zinc-200">Enterprise</span>
                  <div className="mt-1 flex h-6 items-baseline justify-center gap-0.5">
                    <span className="text-base font-extrabold text-slate-950 dark:text-zinc-50">Custom</span>
                  </div>
                </div>
                <div className="mt-1 flex min-h-[28px] items-center justify-center">
                  <span className="text-[10px] leading-tight text-slate-500 dark:text-zinc-400">VPC · SAML SSO</span>
                </div>
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2.5 text-xs dark:border-zinc-800">
              <span className="text-[11px] text-slate-500 dark:text-zinc-400">
                Need more seats or custom quotas?
              </span>
              {onOpenPricing && (
                <button
                  type="button"
                  onClick={onOpenPricing}
                  className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline dark:text-brand-400 cursor-pointer"
                >
                  <span>Compare plan details &amp; quotas</span>
                  <ArrowRight size={11} />
                </button>
              )}
            </div>
          </section>
        </div>

        <dl className="mt-8 grid max-w-lg grid-cols-3 gap-4 border-t border-slate-200 pt-5 text-xs dark:border-zinc-800">
          <div>
            <dt className="flex items-center gap-1.5 font-semibold text-slate-900 dark:text-zinc-100">
              <GitBranch size={14} className="text-brand-600 dark:text-brand-400" /> Sequential history
            </dt>
            <dd className="mt-1 leading-5 text-slate-500 dark:text-zinc-400">Every edit creates an immutable snapshot you can diff or restore.</dd>
          </div>
          <div>
            <dt className="flex items-center gap-1.5 font-semibold text-slate-900 dark:text-zinc-100">
              <ShieldCheck size={14} className="text-brand-600 dark:text-brand-400" /> Role boundaries
            </dt>
            <dd className="mt-1 leading-5 text-slate-500 dark:text-zinc-400">Owners publish directly; Members submit proposals; Guests view only.</dd>
          </div>
          <div>
            <dt className="flex items-center gap-1.5 font-semibold text-slate-900 dark:text-zinc-100">
              <PlugZap size={14} className="text-brand-600 dark:text-brand-400" /> Live MCP server
            </dt>
            <dd className="mt-1 leading-5 text-slate-500 dark:text-zinc-400">Pull and fill prompts straight inside your connected AI assistants and chat tools.</dd>
          </div>
        </dl>
      </aside>

      {/* Right authentication panel */}
      <main className="relative flex flex-col justify-between px-5 py-6 sm:px-8 overflow-y-auto">
        {/* Top Header bar with Plans & Pricing pill and theme toggle */}
        <header className="mx-auto flex w-full max-w-md items-center justify-between gap-3 pb-4">
          <div className="lg:hidden">
            <Logo subtitle="Prompt governance" />
          </div>
          <div className="hidden lg:block text-xs font-medium text-slate-500 dark:text-zinc-400">
            PromptHold Workspace Access
          </div>
          <div className="flex items-center gap-2 ml-auto">
            {onOpenPricing && (
              <button
                type="button"
                onClick={onOpenPricing}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-2xs transition hover:border-brand-300 hover:text-brand-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-700 dark:hover:text-brand-300 cursor-pointer"
              >
                <CreditCard size={13} className="text-brand-600 dark:text-brand-400" />
                <span>Plans &amp; Pricing</span>
                <span className="rounded-full bg-emerald-50 px-1.5 py-0.2 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                  From $0
                </span>
              </button>
            )}
            <ThemeToggleButton />
          </div>
        </header>

        <div className="mx-auto my-auto w-full max-w-md py-4">
          <div className="card p-7 sm:p-8">
            {onOpenPricing && (
              <button
                type="button"
                onClick={onOpenPricing}
                className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 transition hover:text-brand-700 dark:text-zinc-400 dark:hover:text-brand-300 cursor-pointer"
              >
                <ArrowLeft size={13} />
                <span>Back to Plans &amp; Pricing</span>
              </button>
            )}

            <div className="flex items-center justify-between gap-2">
              <h1 className="text-2xl font-semibold tracking-tight text-slate-950 dark:text-zinc-50">
                {mode === 'login' ? 'Sign in to PromptHold' : 'Create your account'}
              </h1>
            </div>
            <p className="mt-1.5 text-sm leading-6 text-slate-500 dark:text-zinc-400">
              {mode === 'login'
                ? 'Enter your workspace credentials to access your personal and team spaces.'
                : 'You’ll get a private Personal space right away, and can create or join team groups.'}
            </p>

            {/* Interactive Plan Selector in Register Mode */}
            {mode === 'register' && (
              <div className="mt-4">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-slate-700 dark:text-zinc-300">
                    Choose your plan:
                  </span>
                  {onOpenPricing && (
                    <button
                      type="button"
                      onClick={onOpenPricing}
                      className="text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-400 cursor-pointer"
                    >
                      Compare all tiers
                    </button>
                  )}
                </div>
                <div className="pt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {PLAN_PREVIEWS.map(opt => {
                    const active = planChoice === opt.id
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setPlanChoice(opt.id)}
                        className={`relative rounded-xl border p-2.5 text-center transition cursor-pointer ${
                          active
                            ? 'border-brand-600 bg-brand-50/60 ring-2 ring-brand-500/20 dark:border-brand-500 dark:bg-brand-950/40'
                            : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-zinc-800 dark:bg-zinc-900/60 dark:hover:border-zinc-700'
                        }`}
                      >
                        {opt.badge && (
                          <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-brand-600 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-white shadow-2xs">
                            {opt.badge}
                          </span>
                        )}
                        <span className={`block text-xs font-bold ${active ? 'text-brand-950 dark:text-brand-100' : 'text-slate-900 dark:text-zinc-100'}`}>
                          {opt.name}
                        </span>
                        <div className="my-0.5 flex h-5 items-baseline justify-center">
                          <span className="text-xs font-extrabold text-slate-900 dark:text-zinc-100">
                            {opt.price}
                          </span>
                        </div>
                        <span className="block text-[10px] text-slate-500 dark:text-zinc-400 truncate">
                          {opt.quota}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <form onSubmit={e => void submit(e)} className="mt-5 space-y-4">
              {mode === 'register' && (
                <div>
                  <label className="field-label" htmlFor="auth-name">Full name</label>
                  <input id="auth-name" required autoComplete="name" value={name} onChange={e => setName(e.target.value)} placeholder="Alex Rivera" className="field" />
                </div>
              )}
              <div>
                <label className="field-label" htmlFor="auth-email">Work email</label>
                <input id="auth-email" required type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" className="field" />
              </div>
              <div>
                <label className="field-label" htmlFor="auth-password">Password</label>
                <input
                  id="auth-password"
                  required
                  type="password"
                  minLength={mode === 'register' ? 8 : undefined}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder={mode === 'register' ? 'At least 8 characters' : '••••••••'}
                  className="field"
                />
              </div>
              {mode === 'register' && (
                <div>
                  <label className="field-label" htmlFor="auth-confirm">Confirm password</label>
                  <input id="auth-confirm" required type="password" minLength={8} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="Repeat password" className="field" />
                </div>
              )}

              {error && (
                <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/60 dark:text-rose-300">
                  {error}
                </p>
              )}

              <button disabled={busy} className="btn-primary mt-2 h-10 w-full cursor-pointer">
                {mode === 'login' ? <LogIn size={16} /> : <UserPlus size={16} />}
                {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : `Create ${planChoice.toUpperCase()} account`}
              </button>
            </form>

            <p className="mt-5 text-center text-sm text-slate-500 dark:text-zinc-400">
              {mode === 'login' ? 'New to PromptHold? ' : 'Already have an account? '}
              <button
                type="button"
                onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}
                className="font-semibold text-brand-700 hover:underline dark:text-brand-400 cursor-pointer"
              >
                {mode === 'login' ? 'Create an account' : 'Sign in'}
              </button>
            </p>
          </div>

          {/* Dedicated Plans & Pricing Section in Auth Panel */}
          <section
            aria-label="PromptHold Plans & Pricing"
            className="mt-5 rounded-2xl border border-slate-200/90 bg-white p-4.5 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900/90"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="grid h-6 w-6 place-items-center rounded-md bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-500/20 dark:bg-brand-950/80 dark:text-brand-300 dark:ring-brand-500/30">
                  <CreditCard size={13} />
                </span>
                <h2 className="text-xs font-bold text-slate-950 dark:text-zinc-50">
                  Transparent Plans &amp; Pricing
                </h2>
              </div>
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-950/80 dark:text-emerald-300">
                Free Forever $0
              </span>
            </div>

            <p className="mt-1.5 text-[11px] text-slate-500 dark:text-zinc-400">
              No credit card needed to get started on Community.
            </p>

            <div className="mt-3.5 pt-2.5 grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => {
                  setPlanChoice('community')
                  switchMode('register')
                }}
                className="flex flex-col items-center justify-between rounded-xl border border-slate-200 bg-slate-50/70 p-2.5 text-center transition hover:border-brand-400 hover:bg-white dark:border-zinc-800 dark:bg-zinc-950/60 dark:hover:border-zinc-700 dark:hover:bg-zinc-900 cursor-pointer"
              >
                <span className="text-xs font-bold text-slate-800 dark:text-zinc-200">Community</span>
                <div className="my-1 flex h-5 items-baseline justify-center gap-0.5">
                  <span className="text-sm font-extrabold text-slate-900 dark:text-zinc-100">$0</span>
                </div>
                <span className="text-[10px] text-slate-500 dark:text-zinc-400">20 prompts</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setPlanChoice('pro')
                  switchMode('register')
                }}
                className="flex flex-col items-center justify-between rounded-xl border border-slate-200 bg-slate-50/70 p-2.5 text-center transition hover:border-brand-400 hover:bg-white dark:border-zinc-800 dark:bg-zinc-950/60 dark:hover:border-zinc-700 dark:hover:bg-zinc-900 cursor-pointer"
              >
                <span className="text-xs font-bold text-slate-800 dark:text-zinc-200">Pro</span>
                <div className="my-1 flex h-5 items-baseline justify-center gap-0.5">
                  <span className="text-sm font-extrabold text-slate-900 dark:text-zinc-100">$5</span>
                  <span className="text-[10px] font-normal text-slate-500">/mo</span>
                </div>
                <span className="text-[10px] text-slate-500 dark:text-zinc-400">100 prompts</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setPlanChoice('team')
                  switchMode('register')
                }}
                className="relative flex flex-col items-center justify-between rounded-xl border border-brand-300 bg-brand-50/30 p-2.5 text-center transition hover:border-brand-500 hover:bg-brand-50/60 dark:border-brand-700/60 dark:bg-brand-950/30 dark:hover:border-brand-600 cursor-pointer"
              >
                <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-brand-600 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-white shadow-2xs">
                  Popular
                </span>
                <span className="text-xs font-bold text-brand-900 dark:text-brand-200">Team</span>
                <div className="my-1 flex h-5 items-baseline justify-center gap-0.5">
                  <span className="text-sm font-extrabold text-brand-950 dark:text-brand-100">$10</span>
                  <span className="text-[10px] font-normal text-brand-700/80 dark:text-brand-300/80">/ed</span>
                </div>
                <span className="text-[10px] font-medium text-emerald-700 dark:text-emerald-400">+2 Free Guests</span>
              </button>
            </div>

            <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2.5 text-xs dark:border-zinc-800">
              <span className="text-[11px] text-slate-500 dark:text-zinc-400">
                Only editors pay · Free read-only guests
              </span>
              {onOpenPricing && (
                <button
                  type="button"
                  onClick={onOpenPricing}
                  className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline dark:text-brand-400 cursor-pointer"
                >
                  <span>Compare all tiers</span>
                  <ArrowRight size={11} />
                </button>
              )}
            </div>
          </section>

          {/* Quick Demo Access with interactive RoleBadges - only shown in development mode */}
          {Boolean(import.meta.env.DEV || import.meta.env.VITE_SHOW_DEMO_ACCOUNTS === 'true') && (
            <section aria-label="Demo accounts" className="mt-5 rounded-xl border border-slate-200/90 bg-white/80 p-4 dark:border-zinc-800 dark:bg-zinc-900/80">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-zinc-200">
                  <Braces size={13} className="text-brand-600 dark:text-brand-400" /> Quick demo sign-in
                </span>
                <span className="text-[11px] text-slate-400 dark:text-zinc-500">Password: <code className="font-mono text-slate-600 dark:text-zinc-300">demo1234</code></span>
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">
                Click any account to sign in immediately, or hover its role badge to see what it can do.
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {DEMO_ACCOUNTS.map(acct => (
                  <div
                    key={acct.email}
                    className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50/70 px-2.5 py-2 transition hover:border-brand-300 hover:bg-white dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700 dark:hover:bg-zinc-850"
                  >
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setEmail(acct.email)
                        setPassword('demo1234')
                        void signInWith(acct.email, 'demo1234')
                      }}
                      className="min-w-0 flex-1 text-left cursor-pointer"
                    >
                      <span className="block truncate text-xs font-semibold text-slate-900 dark:text-zinc-100">{acct.name}</span>
                      <span className="block truncate text-[11px] text-slate-500 dark:text-zinc-400">{acct.context}</span>
                    </button>
                    <RoleBadge kind={acct.role} size="sm" side="top" showIcon={false} />
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Footer */}
        <footer className="mx-auto w-full max-w-md pt-4 text-center text-[11px] text-slate-400 dark:text-zinc-500">
          PromptHold &middot; Granular Prompt Version Control &amp; RBAC &middot; FastMCP
        </footer>
      </main>
    </div>
  )
}
