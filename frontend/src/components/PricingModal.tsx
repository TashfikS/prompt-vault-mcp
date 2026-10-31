import { useEffect, useState } from 'react'
import { ArrowRight, Check, Clock, CreditCard, Loader2, Users } from 'lucide-react'
import Modal from './ui/Modal'
import { createBillingCheckout, getPricing, openBillingPortal, updatePlan } from '../api'
import type { PricingPlanId, PricingResponse, User } from '../types'
import { annualSavingsPercent, cycleToInterval, describePrice } from '../lib/pricing'
import { useToast } from './ui/Toast'


type Props = {
  activeUser: User | null
  onClose: () => void
  onPlanUpdated?: (newPlan: PricingPlanId) => void
  onContactSales?: () => void
  onViewFullPage?: () => void
}

export default function PricingModal({ activeUser, onClose, onPlanUpdated, onContactSales, onViewFullPage }: Props) {
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'annual'>('annual')
  const [pricing, setPricing] = useState<PricingResponse | null>(null)
  const [loadingTier, setLoadingTier] = useState<PricingPlanId | null>(null)
  const [loadError, setLoadError] = useState(false)
  const toast = useToast()

  const currentPlan: PricingPlanId = (activeUser?.plan || pricing?.current_plan || 'community') as PricingPlanId

  useEffect(() => {
    let mounted = true
    getPricing()
      .then(res => {
        if (mounted) setPricing(res)
      })
      .catch(() => {
        if (mounted) setLoadError(true)
      })
    return () => {
      mounted = false
    }
  }, [])

  const tiers = pricing?.tiers ?? []
  const savings = annualSavingsPercent(tiers)

  async function handleSelectPlan(tierId: PricingPlanId) {
    if (tierId === currentPlan) return
    if (tierId === 'enterprise') {
      onClose()
      onContactSales?.()
      return
    }
    if (tierId === 'team' && onViewFullPage) {
      // The full page has the editor-seat picker.
      onClose()
      onViewFullPage()
      return
    }

    setLoadingTier(tierId)
    try {
      if (tierId === 'pro' || tierId === 'team') {
        const checkout = await createBillingCheckout(tierId, cycleToInterval(billingCycle), Math.max(1, activeUser?.billed_seats ?? 1))
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

  async function handleOpenPortal() {
    try {
      const res = await openBillingPortal()
      if (res.portal_url) {
        window.location.href = res.portal_url
      } else {
        toast(res.message || 'Billing portal not yet available.', { tone: 'info' })
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not open billing portal.', { tone: 'error' })
    }
  }

  return (
    <Modal
      title="Plans &amp; Pricing"
      description="Simple, predictable pricing. No seat minimums on Team, and 2 free guests included with every paid editor."
      icon={<CreditCard size={20} />}
      iconWrapper={true}
      size="2xl"
      onClose={onClose}
    >
      <div className="space-y-6">
        {/* Billing cycle toggle */}
        <div className="flex items-center justify-center">
          <div className="inline-flex rounded-xl bg-slate-100 p-1 text-xs font-semibold text-slate-600 dark:bg-zinc-950 dark:border dark:border-zinc-800 dark:text-zinc-400">
            <button
              type="button"
              onClick={() => setBillingCycle('annual')}
              className={`rounded-lg px-3.5 py-1.5 transition ${
                billingCycle === 'annual'
                  ? 'bg-white text-slate-900 shadow-xs dark:bg-zinc-800 dark:text-zinc-100 dark:shadow-sm'
                  : 'text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              Annual billing{savings > 0 && <span className="text-emerald-600 dark:text-emerald-400 font-bold ml-1">Save up to {savings}%</span>}
            </button>
            <button
              type="button"
              onClick={() => setBillingCycle('monthly')}
              className={`rounded-lg px-3.5 py-1.5 transition ${
                billingCycle === 'monthly'
                  ? 'bg-white text-slate-900 shadow-xs dark:bg-zinc-800 dark:text-zinc-100 dark:shadow-sm'
                  : 'text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              Monthly billing
            </button>
          </div>
        </div>

        {/* Usage bar if available */}
        {pricing?.usage && (
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-xs text-slate-600 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-400">
            <div className="flex items-center justify-between mb-1.5 font-medium">
              <span className="text-slate-600 dark:text-zinc-400">Workspace Prompt Usage</span>
              <span className="tabular-nums font-semibold text-slate-900 dark:text-zinc-200">
                {pricing.usage.prompts_count} / {pricing.usage.max_prompts} prompts used
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-zinc-800">
              <div
                className={`h-full transition-all ${
                  pricing.usage.prompts_count >= pricing.usage.max_prompts
                    ? 'bg-rose-500'
                    : pricing.usage.prompts_count >= pricing.usage.max_prompts * 0.8
                    ? 'bg-amber-500'
                    : 'bg-brand-600 dark:bg-brand-500'
                }`}
                style={{
                  width: `${Math.min(100, (pricing.usage.prompts_count / Math.max(1, pricing.usage.max_prompts)) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}

        {!pricing && (
          <p className="text-center text-xs text-slate-500 dark:text-zinc-400">
            {loadError ? "We couldn't load the plans right now. Please try again shortly." : 'Loading plans…'}
          </p>
        )}

        {/* 4 Cards Grid */}
        <div className="grid grid-cols-1 gap-4 pt-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {tiers.map(tier => {
            const isCurrent = currentPlan === tier.id
            const isTeam = tier.id === 'team'
            const price = describePrice(tier, billingCycle)

            return (
              <div
                key={tier.id}
                className={`relative flex flex-col justify-between rounded-2xl border p-4 transition ${
                  isCurrent
                    ? 'border-brand-500 ring-2 ring-brand-500/20 bg-brand-50/20 dark:border-brand-500/60 dark:bg-brand-950/20'
                    : isTeam
                    ? 'border-brand-300 dark:border-brand-700/60 bg-white dark:bg-zinc-900 shadow-sm'
                    : 'border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60'
                }`}
              >
                {tier.badge && (
                  <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-brand-600 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white shadow-2xs">
                    {tier.badge}
                  </span>
                )}

                <div>
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-slate-900 dark:text-zinc-100">{tier.name}</h3>
                    {isCurrent && (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300">
                        Current
                      </span>
                    )}
                  </div>
                  <p className="mt-1 min-h-12 text-xs leading-4 text-slate-500 dark:text-zinc-400">
                    {tier.tagline}
                  </p>

                  <div className="mt-3 min-h-17 border-t border-slate-200/70 pt-3 dark:border-zinc-800">
                    <div className="flex items-baseline gap-1">
                      <span className="text-2xl font-bold text-slate-900 dark:text-zinc-100">{price.amount}</span>
                      <span className="text-xs text-slate-500 dark:text-zinc-400">{price.unit}</span>
                    </div>
                    {price.note && (
                      <span className={`text-[11px] ${billingCycle === 'annual' ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-zinc-400'}`}>
                        {price.note}
                      </span>
                    )}
                  </div>

                  <div className="mt-4 space-y-2">
                    <div className="rounded-lg border border-slate-200/70 bg-slate-50 p-2 text-[11px] leading-tight text-slate-600 dark:border-zinc-800/80 dark:bg-zinc-950/60 dark:text-zinc-300">
                      <span className="font-semibold text-slate-800 dark:text-zinc-100">
                        {tier.max_prompts} prompts
                      </span>{' '}
                      • {tier.max_versions_per_prompt} versions/prompt
                    </div>

                    <ul className="space-y-1.5 pt-1 text-[12px] text-slate-600 dark:text-zinc-300">
                      {tier.features.map((feat, i) => (
                        <li key={i} className="flex items-start gap-1.5">
                          <Check size={14} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                          <span>{feat}</span>
                        </li>
                      ))}
                      {tier.coming_soon.map(feat => (
                        <li key={feat} className="flex items-start gap-1.5 text-slate-400 dark:text-zinc-500">
                          <Clock size={14} className="mt-0.5 shrink-0" />
                          <span>{feat} (coming soon)</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="mt-5 pt-3">
                  <button
                    type="button"
                    disabled={isCurrent || loadingTier === tier.id}
                    onClick={() => void handleSelectPlan(tier.id)}
                    className={`w-full rounded-xl py-2 px-3 text-xs font-semibold transition flex items-center justify-center gap-1.5 ${
                      isCurrent
                        ? 'cursor-default border border-slate-200 bg-slate-100 text-slate-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400'
                        : isTeam
                        ? 'bg-brand-600 text-white hover:bg-brand-700 shadow-xs dark:bg-brand-500 dark:hover:bg-brand-600'
                        : tier.id === 'enterprise'
                        ? 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700'
                        : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700'
                    }`}
                  >
                    {loadingTier === tier.id ? (
                      <>
                        <Loader2 size={13} className="animate-spin" />
                        <span>Updating…</span>
                      </>
                    ) : isCurrent ? (
                      'Current Plan'
                    ) : tier.id === 'enterprise' ? (
                      <>
                        <span>Contact Sales</span>
                        <ArrowRight size={13} />
                      </>
                    ) : (
                      <>
                        <span>Choose {tier.name}</span>
                        <ArrowRight size={13} />
                      </>
                    )}
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        {/* Feature highlight callout */}
        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3.5 text-xs text-slate-600 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-300">
          <div className="grid gap-3">
            <div className="flex items-start gap-2">
              <Users size={16} className="mt-0.5 shrink-0 text-brand-600 dark:text-brand-400" />
              <div>
                <p className="font-semibold text-slate-900 dark:text-zinc-100">Only Editors Pay on Team</p>
                <p className="text-slate-500 dark:text-zinc-400">
                  Every paid editor includes 2 free guest seats for read-only reviewers, legal counsel, and clients.
                </p>
              </div>
            </div>
          </div>
        </div>

        {onViewFullPage && (
          <div className="flex items-center justify-between border-t border-slate-100 pt-3 text-xs dark:border-zinc-800">
            <span className="text-slate-500 dark:text-zinc-400">
              Need detailed feature breakdowns &amp; FAQ?
            </span>
            <div className="flex items-center gap-4">
              {(currentPlan === 'pro' || currentPlan === 'team') && (
                <button
                  type="button"
                  onClick={handleOpenPortal}
                  className="font-medium text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200 cursor-pointer underline"
                >
                  Manage Billing
                </button>
              )}
              <button
                type="button"
                onClick={onViewFullPage}
                className="inline-flex items-center gap-1.5 font-semibold text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300 cursor-pointer"
              >
                <span>View Full Comparison Page</span>
                <ArrowRight size={13} />
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
