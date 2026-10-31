import { ArrowLeft } from 'lucide-react'
import { Logo } from './ui/Brand'
import { ThemeToggleButton } from '../theme'

// Keep in sync with TERMS_VERSION in backend/plans.py (sign-ups record which version they accepted).
export const TERMS_VERSION = '2026-10-31'

type Section = { heading: string; body: string[] }

// DRAFT TEXT: have this reviewed by a lawyer before launch and fill in the bracketed details.
const TERMS: Section[] = [
  { heading: 'Who we are', body: ['PromptFolders ("we", "us") is operated by [legal entity name, registered address]. Contact: [support email].'] },
  { heading: 'Your account', body: [
    'You must give accurate information and keep your password secure. You are responsible for activity under your account and API keys.',
    'You must be at least 16 years old, or the age of digital consent where you live.',
  ] },
  { heading: 'Your content', body: [
    'You own the prompts and other content you store. You give us permission to host, process, and display it only to provide the service to you and the people you share it with.',
    'You must not store unlawful content or content you do not have the right to use.',
  ] },
  { heading: 'Plans and billing', body: [
    'Paid plans are billed in advance, monthly or yearly, through our payment partner Polar.sh, which acts as merchant of record. Team plans are billed per editor seat.',
    'You can cancel at any time from the billing portal; access to paid features continues until the end of the paid period. Refunds follow [refund policy].',
    'Usage limits (prompts, versions, API keys, MCP calls) are listed on the pricing page and enforced automatically.',
  ] },
  { heading: 'Acceptable use', body: ['No attempts to break, overload, or gain unauthorised access to the service, other accounts, or other people\'s data.'] },
  { heading: 'Availability and liability', body: [
    'We work to keep the service available but provide it "as is" without guarantees of uninterrupted operation, except where an Enterprise agreement says otherwise.',
    'To the extent permitted by law, our liability is limited to the amount you paid us in the 12 months before the claim.',
  ] },
  { heading: 'Ending the agreement', body: ['You can delete your account at any time. We may suspend accounts that break these terms. [Data retention period after closure.]'] },
  { heading: 'Changes', body: ['We will tell you by email before material changes take effect. Governing law: [jurisdiction].'] },
]

const PRIVACY: Section[] = [
  { heading: 'What we collect', body: [
    'Account data: name, email address, a hashed password (or your Google/GitHub sign-in), and the date you accepted these terms.',
    'Content you store: prompts, versions, comments, and files you upload.',
    'Usage and security data: sign-in times, IP addresses in security logs, and counts of MCP calls for plan limits.',
    'Billing data is collected and processed by Polar.sh; we receive your plan, seat count, and customer ID, not your card details.',
  ] },
  { heading: 'Why we use it', body: [
    'To provide the service and enforce plan limits (contract).',
    'To keep accounts secure and prevent abuse (legitimate interests).',
    'To send product updates and tips only if you opted in (consent). You can withdraw consent any time from your profile.',
  ] },
  { heading: 'Who we share it with', body: [
    'Service providers that host or run parts of PromptFolders: [list, e.g. Supabase, Neon, Cloudflare, Google (Gemini embeddings, Firebase sign-in), Resend (email), Polar.sh (billing)].',
    'We do not sell personal data.',
  ] },
  { heading: 'Retention', body: ['We keep account data while your account is open and [period] after it closes, unless the law requires longer.'] },
  { heading: 'Your rights', body: ['You can access, correct, export, or delete your data, and object to or restrict processing. Contact [privacy email]. You can also complain to your local data-protection authority.'] },
  { heading: 'International transfers', body: ['[Describe where data is stored and the safeguards used, e.g. Standard Contractual Clauses.]'] },
]

export default function LegalPage({ kind }: { kind: 'terms' | 'privacy' }) {
  const sections = kind === 'terms' ? TERMS : PRIVACY
  const title = kind === 'terms' ? 'Terms of Service' : 'Privacy Policy'
  return (
    <div className="min-h-screen bg-[#f6f7f9] px-4 py-8 text-slate-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center justify-between">
          <a href="/" aria-label="PromptFolders home"><Logo /></a>
          <ThemeToggleButton />
        </div>
        <article className="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-xs dark:border-zinc-800 dark:bg-zinc-900 sm:p-8">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">Version {TERMS_VERSION}</p>
          {sections.map(section => (
            <section key={section.heading} className="mt-6">
              <h2 className="text-base font-semibold">{section.heading}</h2>
              {section.body.map(p => (
                <p key={p} className="mt-2 text-sm leading-6 text-slate-600 dark:text-zinc-300">{p}</p>
              ))}
            </section>
          ))}
          <p className="mt-8 text-sm">
            See also the {kind === 'terms' ? <a className="text-brand-700 underline dark:text-brand-400" href="/privacy">Privacy Policy</a> : <a className="text-brand-700 underline dark:text-brand-400" href="/terms">Terms of Service</a>}.
          </p>
        </article>
        <a href="/" className="mt-6 inline-flex items-center gap-1.5 text-sm text-slate-600 hover:underline dark:text-zinc-400">
          <ArrowLeft size={14} /> Back to PromptFolders
        </a>
      </div>
    </div>
  )
}
