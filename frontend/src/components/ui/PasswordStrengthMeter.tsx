import { useEffect, useState } from 'react'
import { checkPasswordStrength, PASSWORD_MIN_LENGTH, STRENGTH_LABELS, type StrengthResult } from '../../lib/passwordStrength'

const BAR_COLORS = ['bg-rose-500', 'bg-orange-500', 'bg-amber-500', 'bg-emerald-500', 'bg-emerald-600'] as const
const TEXT_COLORS = [
  'text-rose-700 dark:text-rose-400',
  'text-orange-700 dark:text-orange-400',
  'text-amber-700 dark:text-amber-400',
  'text-emerald-700 dark:text-emerald-400',
  'text-emerald-700 dark:text-emerald-400',
] as const

type Props = {
  password: string
  /** Name, email, etc. — passwords built from these are scored as weak. */
  userInputs?: string[]
  id?: string
}

/** Live strength bar for a new password. Runs entirely in the browser. */
export default function PasswordStrengthMeter({ password, userInputs = [], id }: Props) {
  const [result, setResult] = useState<StrengthResult | null>(null)
  const [failed, setFailed] = useState(false)
  const inputsKey = userInputs.join('\u0000')

  useEffect(() => {
    if (!password) { setResult(null); return }
    let cancelled = false
    // Short debounce so fast typing doesn't queue a check per keystroke.
    const t = window.setTimeout(() => {
      checkPasswordStrength(password, inputsKey ? inputsKey.split('\u0000') : [])
        .then(r => { if (!cancelled) { setResult(r); setFailed(false) } })
        .catch(() => { if (!cancelled) setFailed(true) })
    }, 120)
    return () => { cancelled = true; window.clearTimeout(t) }
  }, [password, inputsKey])

  if (!password) return null

  const tooShort = password.length < PASSWORD_MIN_LENGTH
  // A short password is never shown as better than "Weak", whatever zxcvbn says.
  const score = result ? (tooShort ? Math.min(result.score, 1) : result.score) : 0
  const label = result ? STRENGTH_LABELS[score as keyof typeof STRENGTH_LABELS] : 'Checking…'
  const hint = tooShort
    ? `${password.length}/${PASSWORD_MIN_LENGTH} characters — keep going.`
    : result?.warning || result?.suggestions[0] || (score >= 3 ? 'Nice — hard to guess.' : 'Add another word or two to make it stronger.')

  return (
    <div id={id} className="mt-2" aria-live="polite">
      <div className="flex gap-1" aria-hidden>
        {[0, 1, 2, 3].map(i => (
          <span
            key={i}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              result && !failed && i < Math.max(score, 1) ? BAR_COLORS[score] : 'bg-slate-200 dark:bg-zinc-800'
            }`}
          />
        ))}
      </div>
      <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-xs">
        {failed ? (
          <span className="text-slate-500 dark:text-zinc-400">{tooShort ? hint : `Use at least ${PASSWORD_MIN_LENGTH} characters.`}</span>
        ) : (
          <>
            <span className={`font-semibold ${result ? TEXT_COLORS[score] : 'text-slate-500 dark:text-zinc-400'}`}>{label}</span>
            <span className="text-slate-500 dark:text-zinc-400">{hint}</span>
          </>
        )}
      </p>
    </div>
  )
}
