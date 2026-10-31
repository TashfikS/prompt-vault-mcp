import { useState } from 'react'
import { MailWarning } from 'lucide-react'
import { resendVerification } from '../api'

export default function VerifyEmailBanner({ email }: { email: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [error, setError] = useState('')

  async function resend() {
    setState('sending')
    try {
      await resendVerification()
      setState('sent')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the email.')
      setState('error')
    }
  }

  return (
    <div role="status" className="mx-auto mt-5 max-w-6xl px-5 sm:px-8">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/50 dark:text-amber-200">
        <MailWarning size={16} className="shrink-0" />
        <span>
          Confirm <strong>{email}</strong> to secure your account and unlock upgrades. Check your inbox for our email.
        </span>
        <span className="ml-auto">
          {state === 'sent' ? (
            <span className="font-medium">Sent. Check your inbox.</span>
          ) : (
            <button type="button" disabled={state === 'sending'} onClick={() => void resend()} className="font-semibold underline cursor-pointer disabled:opacity-60">
              {state === 'sending' ? 'Sending…' : 'Resend email'}
            </button>
          )}
        </span>
        {state === 'error' && <span className="w-full text-xs text-rose-700 dark:text-rose-300">{error}</span>}
      </div>
    </div>
  )
}
