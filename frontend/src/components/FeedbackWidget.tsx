import { useState } from 'react'
import { MessageSquarePlus, X, AlertCircle, Bug, Sparkles, Mail, CheckCircle2, ExternalLink, Send } from 'lucide-react'
import { submitFeedback } from '../api'
import type { FeedbackCategory, FeedbackSubmissionResponse, User } from '../types'

interface FeedbackWidgetProps {
  activeUser?: User | null
  externalOpen?: boolean
  onExternalClose?: () => void
}

const CATEGORIES: { id: FeedbackCategory; label: string; badge: string; icon: typeof AlertCircle; activeColor: string }[] = [
  {
    id: 'COMPLAINT',
    label: 'Complaint / Issue',
    badge: 'High Priority Issue',
    icon: AlertCircle,
    activeColor: 'border-rose-500/50 bg-rose-50 text-rose-800 dark:border-rose-800/60 dark:bg-rose-950/50 dark:text-rose-300',
  },
  {
    id: 'BUG',
    label: 'Bug Report',
    badge: 'Bug & Glitch Report',
    icon: Bug,
    activeColor: 'border-amber-500/50 bg-amber-50 text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/50 dark:text-amber-300',
  },
  {
    id: 'FEATURE_REQUEST',
    label: 'Feature Idea',
    badge: 'Feature Suggestion',
    icon: Sparkles,
    activeColor: 'border-brand-500/50 bg-brand-50 text-brand-800 dark:border-brand-800/60 dark:bg-brand-950/50 dark:text-brand-300',
  },
  {
    id: 'CONTACT',
    label: 'Connect With Us',
    badge: 'Direct Team Inquiry',
    icon: Mail,
    activeColor: 'border-emerald-500/50 bg-emerald-50 text-emerald-800 dark:border-emerald-800/60 dark:bg-emerald-950/50 dark:text-emerald-300',
  },
]

export function FeedbackWidget({ activeUser, externalOpen, onExternalClose }: FeedbackWidgetProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const isOpen = externalOpen !== undefined ? externalOpen : internalOpen

  const [category, setCategory] = useState<FeedbackCategory>('COMPLAINT')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [contactName, setContactName] = useState(activeUser?.name ?? '')
  const [contactEmail, setContactEmail] = useState(activeUser?.email ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<FeedbackSubmissionResponse | null>(null)

  const handleOpen = () => {
    if (activeUser) {
      if (!contactName) setContactName(activeUser.name)
      if (!contactEmail) setContactEmail(activeUser.email)
    }
    setError('')
    setResult(null)
    setInternalOpen(true)
  }

  const handleClose = () => {
    setInternalOpen(false)
    onExternalClose?.()
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (subject.trim().length < 3) {
      setError('Please enter a short subject (at least 3 characters).')
      return
    }
    if (message.trim().length < 5) {
      setError('Please describe your complaint, feedback, or inquiry in a bit more detail.')
      return
    }

    setSubmitting(true)
    try {
      const response = await submitFeedback({
        category,
        subject: subject.trim(),
        message: message.trim(),
        contact_name: (contactName || activeUser?.name || '').trim(),
        contact_email: (contactEmail || activeUser?.email || '').trim(),
        page_url: window.location.href,
      })
      setResult(response)
      setSubject('')
      setMessage('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit your feedback. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      {/* Floating bottom-right trigger button */}
      <button
        type="button"
        onClick={handleOpen}
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full border border-slate-300 bg-white/95 px-4 py-2.5 text-xs font-semibold text-slate-800 shadow-card backdrop-blur-md transition hover:border-brand-400 hover:bg-brand-50/60 hover:text-brand-900 dark:border-zinc-800 dark:bg-zinc-900/95 dark:text-zinc-200 dark:shadow-pop dark:hover:border-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-white"
        title="Report a complaint, bug, or connect with us"
      >
        <MessageSquarePlus className="h-4 w-4 text-brand-600 dark:text-brand-400" />
        <span>Feedback &amp; Support</span>
      </button>

      {/* Modal */}
      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs"
          onClick={handleClose}
        >
          <div
            className="relative w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-slate-100 pb-4 dark:border-zinc-800">
              <div>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 px-2.5 py-0.5 text-[11px] font-medium text-brand-700 dark:border-brand-900/60 dark:bg-brand-950/40 dark:text-brand-300">
                  Support &amp; Feedback
                </span>
                <h2 className="mt-1.5 text-lg font-bold text-slate-900 dark:text-zinc-100">
                  Feedback, Complaints &amp; Connect With Us
                </h2>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">
                  Every complaint or report is automatically logged so our team can resolve it fast.
                </p>
              </div>
              <button
                type="button"
                onClick={handleClose}
                className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {result ? (
              <div className="mt-5 space-y-4">
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-50 p-4 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
                  <div className="flex items-start gap-3">
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <div className="space-y-1 text-xs">
                      <p className="text-sm font-semibold text-slate-900 dark:text-zinc-100">Submission Received!</p>
                      <p className="text-emerald-800 dark:text-emerald-200/90">{result.message}</p>
                      {result.github_issue_url && (
                        <a
                          href={result.github_issue_url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-100/70 px-3 py-1.5 font-semibold text-emerald-800 transition hover:bg-emerald-200/80 dark:border-emerald-400/40 dark:bg-emerald-500/20 dark:text-emerald-200 dark:hover:bg-emerald-500/30"
                        >
                          <span>View Tracked Ticket #{result.github_issue_number}</span>
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setResult(null)}
                    className="btn-secondary"
                  >
                    Submit Another
                  </button>
                  <button
                    type="button"
                    onClick={handleClose}
                    className="btn-primary"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="mt-4 space-y-4">
                {error && (
                  <div className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
                    {error}
                  </div>
                )}

                {/* Category pill selector (custom Tailwind pills) */}
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-zinc-300">
                    What would you like to share?
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {CATEGORIES.map(item => {
                      const Icon = item.icon
                      const active = category === item.id
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setCategory(item.id)}
                          className={`flex flex-col items-start rounded-xl border p-2.5 text-left transition ${
                            active
                              ? item.activeColor
                              : 'border-slate-200 bg-slate-50/70 text-slate-600 hover:border-slate-300 hover:text-slate-900 dark:border-zinc-800 dark:bg-zinc-950/50 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-200'
                          }`}
                        >
                          <div className="flex items-center gap-1.5 text-xs font-semibold">
                            <Icon className="h-3.5 w-3.5" />
                            <span>{item.label}</span>
                          </div>
                          <span className="mt-0.5 text-[10px] opacity-80">{item.badge}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* Contact Name & Email */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-700 dark:text-zinc-300">Your Name</label>
                    <input
                      type="text"
                      value={contactName}
                      onChange={e => setContactName(e.target.value)}
                      placeholder="Jane Doe"
                      className="field"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-700 dark:text-zinc-300">
                      Email (for follow-up)
                    </label>
                    <input
                      type="email"
                      value={contactEmail}
                      onChange={e => setContactEmail(e.target.value)}
                      placeholder="you@company.com"
                      className="field"
                    />
                  </div>
                </div>

                {/* Subject */}
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700 dark:text-zinc-300">
                    Subject / Summary *
                  </label>
                  <input
                    type="text"
                    required
                    value={subject}
                    onChange={e => setSubject(e.target.value)}
                    placeholder={
                      category === 'COMPLAINT'
                        ? 'Brief summary of your complaint or issue...'
                        : category === 'BUG'
                          ? 'What broke or behaved unexpectedly?'
                          : category === 'FEATURE_REQUEST'
                            ? 'What feature or improvement would help your team?'
                            : 'How can we connect or collaborate with you?'
                    }
                    className="field"
                  />
                </div>

                {/* Details */}
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700 dark:text-zinc-300">
                    Details *
                  </label>
                  <textarea
                    required
                    rows={4}
                    value={message}
                    onChange={e => setMessage(e.target.value)}
                    placeholder="Provide details, steps to reproduce, or how our team can help..."
                    className="field resize-y font-sans"
                  />
                </div>

                <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-3 dark:border-zinc-800">
                  <span className="text-[11px] text-slate-500 dark:text-zinc-400">
                    Directly routed to Workspace Admin queue
                  </span>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={handleClose}
                      className="btn-secondary"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={submitting}
                      className="btn-primary"
                    >
                      <Send className="h-3.5 w-3.5" />
                      <span>{submitting ? 'Submitting...' : 'Submit'}</span>
                    </button>
                  </div>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  )
}
