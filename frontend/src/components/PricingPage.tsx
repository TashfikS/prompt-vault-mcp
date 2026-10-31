import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Clock, CreditCard, HelpCircle, Loader2, Minus, Plus, Users } from 'lucide-react'
import { createBillingCheckout, getPricing, updatePlan } from '../api'
import type { PricingPlanId, PricingResponse, User } from '../types'
import { annualSavingsPercent, cycleToInterval, describePrice } from '../lib/pricing'
import { ThemeToggleButton } from '../theme'
import { Logo } from './ui/Brand'
import { useToast } from './ui/Toast'


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
  const [loadError, setLoadError] = useState(false)
  const [teamSeats, setTeamSeats] = useState(Math.max(1, activeUser?.billed_seats ?? 1))
  const toast = useToast()

  const currentPlan: PricingPlanId = (activeUser?.plan || pricing?.current_plan || 'community') as PricingPlanId

  const loadPricing = useCallback(() => {
    setLoadError(false)
    getPricing()
      .then(setPricing)
      .catch(() => setLoadError(true))
  }, [])

  useEffect(() => {
    loadPricing()
  }, [loadPricing])

  const tiers = pricing?.tiers ?? []
  const savings = annualSavingsPercent(tiers)

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
      if (tierId === 'pro' || tierId === 'team') {
        const checkout = await createBillingCheckout(tierId, cycleToInterval(billingCycle), tierId === 'team' ? teamSeats : 1)
        if (checkout.checkout_url) {
          window.location.href = checkout.checkout_url
          return
        }
        if (checkout.mode === 'mock') {
          if (activeUser?.is_workspace_admin) {
            const res = await updatePlan(tierId)
            toast(res.message || `Switched to ${tierId.toUpperCase()} plan (Dev Admin Mode)`, { tone: 'success' })
            onPlanUpdated?.(tierId)
          } else {
            toast(checkout.message || 'Polar checkout ready. Configure POLAR_ACCESS_TOKEN in .env to activate live payments.', { tone: 'info' })
          }
          return
        }
      }

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
              className="group -m-1 rounded-lg p-1 text-left transition hover:opacity-80 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 cursor-pointer"
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
                Annual billing{savings > 0 && <span className="ml-1 font-bold text-emerald-600 dark:text-emerald-400">Save up to {savings}%</span>}
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
            <dl className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-600 dark:text-zinc-400 sm:grid-cols-3">
              <div>
                <dt>MCP calls this month</dt>
                <dd className="tabular-nums font-semibold text-slate-900 dark:text-zinc-200">
                  {pricing.usage.mcp_calls.toLocaleString()} / {pricing.usage.mcp_monthly_calls.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt>API keys</dt>
                <dd className="tabular-nums font-semibold text-slate-900 dark:text-zinc-200">
                  {pricing.usage.api_keys} / {pricing.usage.max_api_keys}
                </dd>
              </div>
              {pricing.usage.seats !== undefined && (
                <div>
                  <dt>Editors · guests</dt>
                  <dd className="tabular-nums font-semibold text-slate-900 dark:text-zinc-200">
                    {pricing.usage.editors}/{pricing.usage.seats} · {pricing.usage.guests}/{pricing.usage.max_guests}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        )}

        {!pricing && (
          <div className="mx-auto mt-10 max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
            {loadError ? (
              <>
                <p>We couldn't load the plans right now.</p>
                <button type="button" onClick={loadPricing} className="btn-secondary btn-sm mt-3">Try again</button>
              </>
            ) : (
              <p className="flex items-center justify-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading plans…</p>
            )}
          </div>
        )}

        {/* 4 Cards Grid */}
        <div className="mt-10 pt-3 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {tiers.map(tier => {
            const isCurrent = activeUser ? currentPlan === tier.id : tier.id === 'community'
            const isTeam = tier.id === 'team'
            const price = describePrice(tier, billingCycle)

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
                  <p className="mt-1.5 min-h-15 text-xs leading-5 text-slate-500 dark:text-zinc-400">
                    {tier.tagline}
                  </p>

                  <div className="mt-4 min-h-22 border-t border-slate-200/70 pt-4 dark:border-zinc-800">
                    <div className="flex items-baseline gap-1">
                      <span className="text-3xl font-extrabold text-slate-900 dark:text-zinc-100">{price.amount}</span>
                      <span className="text-xs text-slate-500 dark:text-zinc-400">{price.unit}</span>
                    </div>
                    {price.note && (
                      <span className={`text-xs font-medium ${billingCycle === 'annual' ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-zinc-400'}`}>
                        {price.note}
                      </span>
                    )}
                    {tier.per_seat && tier.id !== 'enterprise' && activeUser && !isCurrent && (
                      <div className="mt-3 flex items-center gap-2 text-xs text-slate-600 dark:text-zinc-400">
                        <span>Editors</span>
                        <button type="button" aria-label="Fewer editors" onClick={() => setTeamSeats(n => Math.max(1, n - 1))} className="grid h-6 w-6 place-items-center rounded-md border border-slate-300 hover:bg-slate-50 dark:border-zinc-700 dark:hover:bg-zinc-800 cursor-pointer">
                          <Minus size={12} />
                        </button>
                        <span className="w-6 text-center tabular-nums font-semibold text-slate-900 dark:text-zinc-100" aria-live="polite">{teamSeats}</span>
                        <button type="button" aria-label="More editors" onClick={() => setTeamSeats(n => Math.min(500, n + 1))} className="grid h-6 w-6 place-items-center rounded-md border border-slate-300 hover:bg-slate-50 dark:border-zinc-700 dark:hover:bg-zinc-800 cursor-pointer">
                          <Plus size={12} />
                        </button>
                        <span className="ml-auto">+{teamSeats * tier.free_guests_per_editor} free guests</span>
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
                      {tier.coming_soon.map(feat => (
                        <li key={feat} className="flex items-start gap-2 text-slate-400 dark:text-zinc-500">
                          <Clock size={15} className="mt-0.5 shrink-0" />
                          <span className="leading-5">{feat} <span className="text-[10px] font-semibold uppercase tracking-wide">Coming soon</span></span>
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
        <div className="mx-auto mt-12 max-w-3xl">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center gap-2.5 text-base font-semibold text-slate-900 dark:text-zinc-100">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
                <Users size={17} />
              </span>
              <span>The "Only Editors Pay" Architecture</span>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-zinc-400">
              Many tools charge for every team member, even people who only read prompts. With PromptHold Team you pay only for editors ($10/mo billed annually, or $12 month to month), and every paid editor includes <strong>2 free read-only guests</strong> who can view, test, and inspect diffs.
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
                When you hit a limit, PromptHold stops new prompts, versions, or API keys and tells you which limit you reached. Existing prompts and versions stay available. MCP calls are counted per calendar month (UTC); if you use them all, MCP tools pause until the 1st or until you upgrade.
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
                <HelpCircle size={15} className="text-brand-600" />
                <span>How do review requests work in Team groups?</span>
              </h3>
              <p className="mt-2 text-xs leading-relaxed text-slate-600 dark:text-zinc-400">
                Group Owners can configure <code className="rounded-sm bg-slate-100 px-1 py-0.5 text-[11px] font-mono dark:bg-zinc-800">required_approvals</code> (e.g. 1 or 2). When team members edit prompts, an edit proposal is submitted. Once enough peers or owners vote to approve, the proposal automatically merges into the next sequential version (vN+1).
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
