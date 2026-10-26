import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, CreditCard, HardDrive, HelpCircle, Loader2, Users } from 'lucide-react'
import { getPricing, updatePlan } from '../api'
import type { PricingPlanId, PricingResponse, PricingTier, User } from '../types'
import { ThemeToggleButton } from '../theme'
import { Logo } from './ui/Brand'
import { useToast } from './ui/Toast'

const FALLBACK_TIERS: PricingTier[] = [
  {
    id: 'community',
    name: 'Community',
    tagline: 'Individual developers exploring version-controlled prompts & MCP.',
    price_monthly: 0,
    price_annual: 0,
    price_label: '$0',
    max_prompts: 20,
    max_versions_per_prompt: 10,
    max_groups: 1,
    free_guests_per_editor: 0,
    mcp_monthly_calls: 1000,
    storage_type: 'Free Cloud Database',
    features: [
      '1 User (Private Personal Space)',
      'Up to 20 active prompts',
      'Last 10 versions per prompt',
      'Direct Save (instant v1 → v2)',
      'FastMCP In-Chat Drawer & Personal Key',
      'Word & sentence basic diff viewer',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'Power prompt crafters & freelancers managing large prompt libraries.',
    price_monthly: 5,
    price_annual: 4,
    price_label: '$5/mo',
    max_prompts: 100,
    max_versions_per_prompt: 50,
    max_groups: 1,
    free_guests_per_editor: 0,
    mcp_monthly_calls: 10000,
    storage_type: 'Cloud DB + Bring Your Own Storage',
    features: [
      'Everything in Community',
      'Up to 100 active prompts',
      'Up to 50 versions per prompt',
      'Word & Sentence Diff Viewer (Split & Inline)',
      'Shareable Zero-Config Diff Links',
      'Batch File Upload (.txt, .md, .csv, .json)',
      'Bring Your Own Storage (Google Drive / local)',
    ],
  },
  {
    id: 'team',
    name: 'Team',
    badge: 'Most Popular',
    tagline: 'Startups and product teams collaborating with approval workflows.',
    price_monthly: 12,
    price_annual: 10,
    price_label: '$10/editor/mo',
    max_prompts: 500,
    max_versions_per_prompt: 100,
    max_groups: 5,
    free_guests_per_editor: 2,
    mcp_monthly_calls: 50000,
    storage_type: 'Team Cloud DB + Google Drive Sync',
    features: [
      'Everything in Pro',
      'No seat minimums (starts at 1 editor)',
      '2 Free Read-Only Guests per paid editor',
      'Up to 500 prompts across 5 Team Groups',
      'Proposal & Approval Workflow (required_approvals)',
      'Central Review Requests Inbox & auto-merge',
      '3 Team MCP API Keys for automated agents',
      'Team Cloud & Google Drive Sync',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    tagline: 'Organizations requiring self-hosting, strict compliance & VPC scale.',
    price_monthly: null,
    price_annual: null,
    price_label: 'Contact Us',
    max_prompts: 10000,
    max_versions_per_prompt: 1000,
    max_groups: 100,
    free_guests_per_editor: 10,
    mcp_monthly_calls: 1000000,
    storage_type: 'Self-Hosted Docker / VPC / Private PostgreSQL',
    features: [
      'Everything in Team',
      'Self-Hosted Deployment (Docker / VPC / On-Prem)',
      'Dedicated PostgreSQL or custom DB cluster',
      'SSO / SAML 2.0 (Okta, Google Workspace, Azure AD)',
      'Custom prompt & version quotas',
      'Full Compliance & Audit Logs Export',
      'Dedicated SLA & onboarding support',
    ],
  },
]

type Props = {
  activeUser: User | null
  onBackToApp?: () => void
  onPlanUpdated?: (newPlan: PricingPlanId) => void
  onContactSales?: () => void
  onSignIn?: () => void
  onSelectPlan?: (tierId: PricingPlanId) => void
  onHome?: () => void
}

export default function PricingPage({
  activeUser,
  onBackToApp,
  onPlanUpdated,
  onContactSales,
  onSignIn,
  onSelectPlan,
  onHome,
}: Props) {
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'annual'>('annual')
  const [pricing, setPricing] = useState<PricingResponse | null>(null)
  const [loadingTier, setLoadingTier] = useState<PricingPlanId | null>(null)
  const toast = useToast()

  const currentPlan: PricingPlanId = (activeUser?.plan || pricing?.current_plan || 'community') as PricingPlanId

  useEffect(() => {
    let mounted = true
    getPricing()
      .then(res => {
        if (mounted) setPricing(res)
      })
      .catch(() => {
        // Fallback to static tiers
      })
    return () => {
      mounted = false
    }
  }, [])

  const tiers = pricing?.tiers || FALLBACK_TIERS

  async function handleSelectPlan(tierId: PricingPlanId) {
    if (activeUser && tierId === currentPlan) return
    if (tierId === 'enterprise') {
      onContactSales?.()
      return
    }

    if (!activeUser) {
      if (onSelectPlan) {
        onSelectPlan(tierId)
      } else {
        window.location.href = `/?auth=register&plan=${tierId}`
      }
      return
    }

    setLoadingTier(tierId)
    try {
      const res = await updatePlan(tierId)
      toast(res.message || `Switched to ${tierId.toUpperCase()} plan!`, { tone: 'success' })
      onPlanUpdated?.(tierId)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not change plan.', { tone: 'error' })
    } finally {
      setLoadingTier(null)
    }
  }

  function handleGoHome() {
    if (onHome) {
      onHome()
      return
    }
    if (activeUser && onBackToApp) {
      onBackToApp()
      return
    }
    if (onSignIn) {
      onSignIn()
      return
    }
    window.location.href = activeUser ? '/' : '/?auth=login'
  }

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#f6f7f9] text-slate-900 dark:bg-zinc-950 dark:text-zinc-100">
      {/* Top Header */}
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 px-5 py-4 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-900/90 sm:px-8">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleGoHome}
              aria-label="PromptHold home"
              className="group -m-1 rounded-lg p-1 text-left transition hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 cursor-pointer"
            >
              <Logo />
            </button>
            <span className="text-slate-300 dark:text-zinc-600">/</span>
            <span className="text-sm font-medium text-slate-600 dark:text-zinc-400">Plans &amp; Pricing</span>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <ThemeToggleButton />
            {activeUser ? (
              onBackToApp ? (
                <button type="button" onClick={onBackToApp} className="btn-secondary btn-sm flex items-center gap-1.5">
                  <ArrowLeft size={14} />
                  <span>Dashboard</span>
                </button>
              ) : (
                <a href="/" className="btn-secondary btn-sm flex items-center gap-1.5">
                  <ArrowLeft size={14} />
                  <span>Open Workspace</span>
                </a>
              )
            ) : onSignIn ? (
              <button type="button" onClick={onSignIn} className="btn-primary btn-sm flex items-center gap-1.5 shadow-2xs">
                <span>Sign In</span>
                <ArrowRight size={14} />
              </button>
            ) : (
              <a href="/?auth=login" className="btn-primary btn-sm flex items-center gap-1.5 shadow-2xs">
                <span>Sign In</span>
                <ArrowRight size={14} />
              </a>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
        {/* Hero Section */}
        <div className="mx-auto max-w-3xl text-center">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50/70 px-3 py-1 text-xs font-semibold text-brand-700 dark:border-brand-900/60 dark:bg-brand-950/40 dark:text-brand-300">
            <CreditCard size={13} />
            <span>Predictable, Developer-Friendly Pricing</span>
          </div>
          <h1 className="mt-4 text-3xl font-extrabold tracking-tight text-slate-950 dark:text-zinc-50 sm:text-5xl">
            Prompt management with zero seat-inflation.
          </h1>
          <p className="mt-3.5 text-base text-slate-600 dark:text-zinc-400 sm:text-lg">
            Start free on Community, scale with Pro, or collaborate with approval gates on Team. Only active editors pay; read-only reviewers are always free.
          </p>

          {/* Billing Cycle Toggle */}
          <div className="mt-8 flex items-center justify-center">
            <div className="inline-flex rounded-xl bg-slate-200/70 p-1 text-xs font-semibold text-slate-600 dark:bg-zinc-950 dark:border dark:border-zinc-800 dark:text-zinc-400">
              <button
                type="button"
                onClick={() => setBillingCycle('annual')}
                className={`rounded-lg px-4 py-2 transition ${
                  billingCycle === 'annual'
                    ? 'bg-white text-slate-900 shadow-xs dark:bg-zinc-800 dark:text-zinc-100 dark:shadow-sm'
                    : 'text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200'
                }`}
              >
                Annual billing <span className="ml-1 font-bold text-emerald-600 dark:text-emerald-400">Save 20%</span>
              </button>
              <button
                type="button"
                onClick={() => setBillingCycle('monthly')}
                className={`rounded-lg px-4 py-2 transition ${
                  billingCycle === 'monthly'
                    ? 'bg-white text-slate-900 shadow-xs dark:bg-zinc-800 dark:text-zinc-100 dark:shadow-sm'
                    : 'text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200'
                }`}
              >
                Monthly billing
              </button>
            </div>
          </div>
        </div>

        {/* Usage banner if user is authenticated */}
        {activeUser && pricing?.usage && (
          <div className="mx-auto mt-8 max-w-2xl rounded-2xl border border-slate-200 bg-white p-4 shadow-xs dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center justify-between text-xs font-medium text-slate-600 dark:text-zinc-400">
              <span>Your Prompt Storage Quota</span>
              <span className="tabular-nums font-semibold text-slate-900 dark:text-zinc-200">
                {pricing.usage.prompts_count} / {pricing.usage.max_prompts} prompts used
              </span>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-zinc-800">
              <div
                className={`h-full transition-all duration-300 ${
                  pricing.usage.prompts_count >= pricing.usage.max_prompts
                    ? 'bg-rose-500'
                    : pricing.usage.prompts_count >= pricing.usage.max_prompts * 0.8
                    ? 'bg-amber-500'
                    : 'bg-brand-600'
                }`}
                style={{
                  width: `${Math.min(100, (pricing.usage.prompts_count / Math.max(1, pricing.usage.max_prompts)) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* 4 Cards Grid */}
        <div className="mt-10 pt-3 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {tiers.map(tier => {
            const isCurrent = activeUser ? currentPlan === tier.id : tier.id === 'community'
            const isTeam = tier.id === 'team'
            const price = billingCycle === 'annual' ? tier.price_annual : tier.price_monthly

            return (
              <div
                key={tier.id}
                className={`relative flex flex-col justify-between rounded-3xl border p-6 transition-all duration-200 ${
                  isCurrent
                    ? 'border-brand-500 ring-2 ring-brand-500/20 bg-brand-50/20 dark:border-brand-500/60 dark:bg-brand-950/20 shadow-md'
                    : isTeam
                    ? 'border-brand-300 dark:border-brand-700/60 bg-white dark:bg-zinc-900 shadow-lg'
                    : 'border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 shadow-xs'
                }`}
              >
                {tier.badge && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-brand-600 px-3 py-0.5 text-[11px] font-bold uppercase tracking-wider text-white shadow-2xs">
                    {tier.badge}
                  </span>
                )}

                <div>
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-bold text-slate-900 dark:text-zinc-100">{tier.name}</h3>
                    {isCurrent && (
                      <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300">
                        Active
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 min-h-[36px] text-xs leading-5 text-slate-500 dark:text-zinc-400">
                    {tier.tagline}
                  </p>

                  <div className="mt-4 border-t border-slate-100 pt-4 dark:border-zinc-800">
                    {tier.id === 'enterprise' ? (
                      <div className="flex items-baseline gap-1">
                        <span className="text-2xl font-extrabold text-slate-900 dark:text-zinc-100">Custom</span>
                        <span className="text-xs text-slate-500 dark:text-zinc-400">/ quote</span>
                      </div>
                    ) : tier.id === 'community' ? (
                      <div className="flex items-baseline gap-1">
                        <span className="text-3xl font-extrabold text-slate-900 dark:text-zinc-100">$0</span>
                        <span className="text-xs text-slate-500 dark:text-zinc-400">/ forever free</span>
                      </div>
                    ) : tier.id === 'pro' ? (
                      <div>
                        <div className="flex items-baseline gap-1">
                          <span className="text-3xl font-extrabold text-slate-900 dark:text-zinc-100">${price}</span>
                          <span className="text-xs text-slate-500 dark:text-zinc-400">/ month</span>
                        </div>
                        {billingCycle === 'annual' && (
                          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Billed $48 annually</span>
                        )}
                      </div>
                    ) : (
                      <div>
                        <div className="flex items-baseline gap-1">
                          <span className="text-3xl font-extrabold text-slate-900 dark:text-zinc-100">${price}</span>
                          <span className="text-xs text-slate-500 dark:text-zinc-400">/ editor / mo</span>
                        </div>
                        {billingCycle === 'annual' ? (
                          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Billed $120 annually</span>
                        ) : (
                          <span className="text-xs text-slate-500 dark:text-zinc-400">Billed monthly</span>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="mt-5 space-y-3">
                    <div className="rounded-xl border border-slate-200/70 bg-slate-50 p-2.5 text-xs text-slate-700 dark:border-zinc-800/80 dark:bg-zinc-950/60 dark:text-zinc-300">
                      <span className="font-semibold text-slate-900 dark:text-zinc-100">{tier.max_prompts} Prompts</span>
                      {' • '}
                      <span>{tier.max_versions_per_prompt} versions/prompt</span>
                    </div>

                    <ul className="space-y-2 text-xs text-slate-600 dark:text-zinc-300">
                      {tier.features.map((feat, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <Check size={15} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                          <span className="leading-5">{feat}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="mt-6 pt-4 border-t border-slate-100 dark:border-zinc-800">
                  <button
                    type="button"
                    disabled={isCurrent || loadingTier === tier.id}
                    onClick={() => void handleSelectPlan(tier.id)}
                    className={`w-full rounded-xl py-2.5 px-4 text-xs font-semibold transition flex items-center justify-center gap-1.5 ${
                      isCurrent
                        ? 'cursor-default border border-slate-200 bg-slate-100 text-slate-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400'
                        : isTeam
                        ? 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm dark:bg-brand-500 dark:hover:bg-brand-600'
                        : tier.id === 'enterprise'
                        ? 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700'
                        : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700'
                    }`}
                  >
                    {loadingTier === tier.id ? (
                      <>
                        <Loader2 size={14} className="animate-spin" />
                        <span>Updating…</span>
                      </>
                    ) : isCurrent ? (
                      'Current Plan'
                    ) : tier.id === 'enterprise' ? (
                      <>
                        <span>Contact Enterprise</span>
                        <ArrowRight size={14} />
                      </>
                    ) : activeUser ? (
                      <>
                        <span>Upgrade to {tier.name}</span>
                        <ArrowRight size={14} />
                      </>
                    ) : (
                      <>
                        <span>Get Started with {tier.name}</span>
                        <ArrowRight size={14} />
                      </>
                    )}
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        {/* Feature Explanations */}
        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center gap-2.5 text-base font-semibold text-slate-900 dark:text-zinc-100">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
                <Users size={17} />
              </span>
              <span>The "Only Editors Pay" Architecture</span>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-zinc-400">
              Many SaaS platforms charge $20–$30/seat for every team member who simply reads or views prompts. With PromptHold Team, you only pay for active editors ($10/mo billed annually). Every editor includes <strong>2 free guest seats</strong> with read-only view, testing, and diff inspection rights.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center gap-2.5 text-base font-semibold text-slate-900 dark:text-zinc-100">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                <HardDrive size={17} />
              </span>
              <span>Bring Your Own Storage (BYOS)</span>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-zinc-400">
              Never worry about vendor lock-in or database storage quotas. On Pro and Team plans, you can connect your existing company Google Drive or local folder sync. PromptHold acts as your intelligent version-control dashboard, approval reviewer, and FastMCP server while your files stay safely in your cloud.
            </p>
          </div>
        </div>

        {/* FAQ Section */}
        <div className="mt-14">
          <h2 className="text-xl font-bold tracking-tight text-slate-950 dark:text-zinc-50 text-center">
            Frequently Asked Questions
          </h2>
          <div className="mt-6 mx-auto max-w-3xl space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
                <HelpCircle size={15} className="text-brand-600" />
                <span>Can I start on Community without entering a credit card?</span>
              </h3>
              <p className="mt-2 text-xs leading-relaxed text-slate-600 dark:text-zinc-400">
                Yes! Every new user is automatically provisioned a private Personal space on the Community plan ($0 forever). You can create up to 20 prompts, save sequential versions, and connect your AI chat client via FastMCP completely free.
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
                <HelpCircle size={15} className="text-brand-600" />
                <span>What happens when I reach my prompt quota?</span>
              </h3>
              <p className="mt-2 text-xs leading-relaxed text-slate-600 dark:text-zinc-400">
                When you hit your tier's limit, PromptHold cleanly prevents new prompt creation and notifies you with an upgrade prompt. Your existing prompts, versions, and MCP access remain 100% active and accessible. You can upgrade at any time to instantly unlock more capacity.
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
                <HelpCircle size={15} className="text-brand-600" />
                <span>How do review requests work in Team groups?</span>
              </h3>
              <p className="mt-2 text-xs leading-relaxed text-slate-600 dark:text-zinc-400">
                Group Owners can configure <code className="rounded bg-slate-100 px-1 py-0.5 text-[11px] font-mono dark:bg-zinc-800">required_approvals</code> (e.g. 1 or 2). When team members edit prompts, an edit proposal is submitted. Once enough peers or owners vote to approve, the proposal automatically merges into the next sequential version (vN+1).
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
