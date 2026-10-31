import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { CheckCircle2, KeyRound, Loader2, MailCheck, XCircle } from 'lucide-react'
import { resetPassword, verifyEmail } from '../api'
import { Logo } from './ui/Brand'
import { ThemeToggleButton } from '../theme'
import PasswordStrengthMeter from './ui/PasswordStrengthMeter'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PASSWORD_RULE_TEXT } from '../lib/passwordStrength'

/** Landing screen for the links in account emails: ?verify_token=… and ?reset_token=… */
export default function AccountLinkPage({ kind, token, onDone }: { kind: 'verify' | 'reset'; token: string; onDone: () => void }) {
  return (
    <div className="grid min-h-screen place-items-center bg-[#f6f7f9] px-4 text-slate-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="absolute right-4 top-4">
        <ThemeToggleButton />
      </div>
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xs dark:border-zinc-800 dark:bg-zinc-900">
        <Logo />
        <div className="mt-6">
          {kind === 'verify' ? <VerifyEmail token={token} onDone={onDone} /> : <ResetPassword token={token} onDone={onDone} />}
        </div>
      </div>
    </div>
  )
}

function VerifyEmail({ token, onDone }: { token: string; onDone: () => void }) {
  const [state, setState] = useState<'working' | 'ok' | 'error'>('working')
  const [message, setMessage] = useState('')
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return // StrictMode runs effects twice; the token is single-use
    started.current = true
    verifyEmail(token)
      .then(res => {
        setState('ok')
        setMessage(`${res.email} is confirmed.`)
      })
      .catch(e => {
        setState('error')
        setMessage(e instanceof Error ? e.message : 'This confirmation link is invalid or has expired.')
      })
  }, [token])

  return (
    <div className="text-center">
      {state === 'working' && <Loader2 className="mx-auto animate-spin text-brand-600" size={28} />}
      {state === 'ok' && <MailCheck className="mx-auto text-emerald-600" size={28} />}
      {state === 'error' && <XCircle className="mx-auto text-rose-600" size={28} />}
      <h1 className="mt-3 text-lg font-semibold">
        {state === 'working' ? 'Confirming your email…' : state === 'ok' ? 'Email confirmed' : 'Link not valid'}
      </h1>
      {message && <p className="mt-1.5 text-sm text-slate-600 dark:text-zinc-400">{message}</p>}
      {state !== 'working' && (
        <button type="button" onClick={onDone} className="btn-primary mt-5 h-10 w-full cursor-pointer">
          Continue to PromptFolders
        </button>
      )}
    </div>
  )
}

function ResetPassword({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`)
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    setBusy(true)
    try {
      await resetPassword(token, password)
      setDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reset your password.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="text-center">
        <CheckCircle2 className="mx-auto text-emerald-600" size={28} />
        <h1 className="mt-3 text-lg font-semibold">Password updated</h1>
        <p className="mt-1.5 text-sm text-slate-600 dark:text-zinc-400">
          For your security, you've been signed out everywhere. Sign in with your new password.
        </p>
        <button type="button" onClick={onDone} className="btn-primary mt-5 h-10 w-full cursor-pointer">
          Go to sign in
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={e => void submit(e)} className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <KeyRound size={18} className="text-brand-600" /> Choose a new password
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-zinc-400">{PASSWORD_RULE_TEXT}</p>
      </div>
      <div>
        <label className="field-label" htmlFor="reset-password">New password</label>
        <input id="reset-password" required type="password" minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} aria-describedby="reset-password-strength" className="field" />
        <PasswordStrengthMeter id="reset-password-strength" password={password} userInputs={['promptfolders', 'promptvault']} />
      </div>
      <div>
        <label className="field-label" htmlFor="reset-confirm">Confirm new password</label>
        <input id="reset-confirm" required type="password" minLength={PASSWORD_MIN_LENGTH} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} className="field" />
      </div>
      {error && (
        <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/60 dark:text-rose-300">
          {error}
        </p>
      )}
      <button disabled={busy} className="btn-primary h-10 w-full cursor-pointer">
        {busy ? 'Saving…' : 'Update password'}
      </button>
    </form>
  )
}
