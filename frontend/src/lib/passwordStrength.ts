// Password rules shared by sign-up, password reset and password change.
// Mirrors backend/services/credential_policy.py: length is the only hard rule; the server
// also rejects passwords found in known data breaches.
import type { ZxcvbnFactory } from '@zxcvbn-ts/core'

export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 200
export const PASSWORD_RULE_TEXT = `At least ${PASSWORD_MIN_LENGTH} characters. Long phrases of a few random words work well.`

export type StrengthScore = 0 | 1 | 2 | 3 | 4

export type StrengthResult = {
  score: StrengthScore
  warning: string | null
  suggestions: string[]
}

let factoryPromise: Promise<ZxcvbnFactory> | null = null

// zxcvbn's dictionaries are ~1 MB, so load them only when someone starts typing a new password.
function loadFactory(): Promise<ZxcvbnFactory> {
  factoryPromise ??= Promise.all([
    import('@zxcvbn-ts/core'),
    import('@zxcvbn-ts/language-common'),
    import('@zxcvbn-ts/language-en'),
  ]).then(([core, common, en]) => new core.ZxcvbnFactory({
    translations: en.translations,
    graphs: common.adjacencyGraphs,
    dictionary: { ...common.dictionary, ...en.dictionary },
  }))
  // Let a later call retry if the chunk failed to load (e.g. a flaky network).
  factoryPromise.catch(() => { factoryPromise = null })
  return factoryPromise
}

/** Estimate strength in the browser; the password never leaves the device. */
export async function checkPasswordStrength(password: string, userInputs: string[] = []): Promise<StrengthResult> {
  const zxcvbn = await loadFactory()
  const r = await zxcvbn.checkAsync(password, userInputs.filter(Boolean))
  return { score: r.score as StrengthScore, warning: r.feedback.warning || null, suggestions: r.feedback.suggestions }
}

export const STRENGTH_LABELS: Record<StrengthScore, string> = {
  0: 'Very weak',
  1: 'Weak',
  2: 'Fair',
  3: 'Strong',
  4: 'Very strong',
}
