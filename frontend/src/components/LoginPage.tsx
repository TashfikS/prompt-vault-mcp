import { useState } from 'react'
import type { FormEvent } from 'react'
import { Braces, GitBranch, LogIn, PlugZap, ShieldCheck, UserPlus } from 'lucide-react'
import { login, register, setSessionToken } from '../api'
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

export default function LoginPage({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [mode, setMode] = useState<Mode>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

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
        const res = await register(name, email, password)
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
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-slate-200/80 bg-white p-10 xl:p-14 lg:flex dark:border-zinc-800 dark:bg-zinc-950">
        <div>
          <Logo subtitle="Enterprise prompt governance & version control" />

          <div className="mt-12 max-w-lg">
            <h2 className="text-3xl font-semibold tracking-tight text-slate-950 dark:text-zinc-50">
              Prompts your team can version, review, and trust.
            </h2>
            <p className="mt-3 text-base leading-7 text-slate-600 dark:text-zinc-400">
              Give every team a shared library of verified prompts with sequential version history, role-based review workflows, and direct MCP connection to your AI assistants and agents.
            </p>
          </div>

          {/* Live artifact preview card */}
          <div className="mt-8 max-w-lg rounded-2xl border border-slate-200 bg-slate-50/70 p-5 shadow-card dark:border-zinc-800 dark:bg-zinc-900/80">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/80 pb-3.5 dark:border-zinc-800">
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
            <p className="mt-3.5 rounded-xl border border-slate-200/90 bg-white p-3.5 font-mono text-xs leading-6 text-slate-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
              <PromptText text="Create an upbeat campaign for {{product}} aimed at {{audience}}. Use a warm, helpful tone and include one clear call to action." />
            </p>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-zinc-400">
              <span>5 immutable versions · 2 fields detected</span>
              <span className="text-slate-400 dark:text-zinc-500">Hover any role badge to inspect permissions</span>
            </div>
          </div>
        </div>

        <dl className="mt-10 grid max-w-lg grid-cols-3 gap-4 border-t border-slate-200 pt-6 text-xs dark:border-zinc-800">
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
      <main className="relative grid place-items-center px-5 py-10 sm:px-8">
        <div className="absolute right-5 top-5">
          <ThemeToggleButton />
        </div>

        <div className="w-full max-w-md">
          <div className="mb-7 lg:hidden">
            <Logo subtitle="Prompts your team can trust" />
          </div>

          <div className="card p-7 sm:p-8">
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

            <form onSubmit={e => void submit(e)} className="mt-6 space-y-4">
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

              <button disabled={busy} className="btn-primary mt-2 h-10 w-full">
                {mode === 'login' ? <LogIn size={16} /> : <UserPlus size={16} />}
                {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
              </button>
            </form>



            <p className="mt-5 text-center text-sm text-slate-500 dark:text-zinc-400">
              {mode === 'login' ? 'New to PromptHold? ' : 'Already have an account? '}
              <button
                type="button"
                onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}
                className="font-semibold text-brand-700 hover:underline dark:text-brand-400"
              >
                {mode === 'login' ? 'Create an account' : 'Sign in'}
              </button>
            </p>
          </div>

          {/* Quick Demo Access with interactive RoleBadges */}
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
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-xs font-semibold text-slate-900 dark:text-zinc-100">{acct.name}</span>
                    <span className="block truncate text-[11px] text-slate-500 dark:text-zinc-400">{acct.context}</span>
                  </button>
                  <RoleBadge kind={acct.role} size="sm" side="top" showIcon={false} />
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
