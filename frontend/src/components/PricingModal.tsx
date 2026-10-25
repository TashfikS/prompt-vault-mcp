import { useEffect, useState } from 'react'
import { ArrowRight, Check, HardDrive, Loader2, Sparkles, Users } from 'lucide-react'
import Modal from './ui/Modal'
import { getPricing, updatePlan } from '../api'
import type { PricingPlanId, PricingResponse, PricingTier, User } from '../types'
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
    tagline: 'Power prompt crafters & freelancers managing large libraries.',
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
  onClose: () => void
  onPlanUpdated?: (newPlan: PricingPlanId) => void
  onContactSales?: () => void
}

export default function PricingModal({ activeUser, onClose, onPlanUpdated, onContactSales }: Props) {
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
        // Fallback to static data
      })
    return () => {
      mounted = false
    }
  }, [])

  const tiers = pricing?.tiers || FALLBACK_TIERS

  async function handleSelectPlan(tierId: PricingPlanId) {
    if (tierId === currentPlan) return
    if (tierId === 'enterprise') {
      onClose()
      onContactSales?.()
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

  return (
    <Modal
      title={
        <div className="flex items-center gap-2">
          <span>Plans &amp; Pricing</span>
          <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700 dark:bg-brand-950/70 dark:text-brand-300">
            PromptHold
          </span>
        </div>
      }
      description="Simple, predictable pricing. No seat minimums on Team, and 2 free guests included with every paid editor."
      icon={<Sparkles size={20} />}
      size="2xl"
      onClose={onClose}
    >
      <div className="space-y-6">
        {/* Billing cycle toggle */}
        <div className="flex items-center justify-center">
          <div className="inline-flex rounded-xl bg-slate-100 p-1 text-xs font-semibold text-slate-600 dark:bg-zinc-850 dark:text-zinc-300">
            <button
              type="button"
              onClick={() => setBillingCycle('annual')}
              className={`rounded-lg px-3.5 py-1.5 transition ${
                billingCycle === 'annual'
                  ? 'bg-white text-slate-900 shadow-2xs dark:bg-zinc-900 dark:text-zinc-100'
                  : 'hover:text-slate-900 dark:hover:text-zinc-100'
              }`}
            >
              Annual billing <span className="text-emerald-600 dark:text-emerald-400 font-bold ml-1">Save 20%</span>
            </button>
            <button
              type="button"
              onClick={() => setBillingCycle('monthly')}
              className={`rounded-lg px-3.5 py-1.5 transition ${
                billingCycle === 'monthly'
                  ? 'bg-white text-slate-900 shadow-2xs dark:bg-zinc-900 dark:text-zinc-100'
                  : 'hover:text-slate-900 dark:hover:text-zinc-100'
              }`}
            >
              Monthly billing
            </button>
          </div>
        </div>

        {/* Usage bar if available */}
        {pricing?.usage && (
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-xs text-slate-600 dark:border-zinc-800 dark:bg-zinc-850/50 dark:text-zinc-400">
            <div className="flex items-center justify-between mb-1.5 font-medium">
              <span>Workspace Prompt Usage</span>
              <span className="tabular-nums font-semibold text-slate-900 dark:text-zinc-200">
                {pricing.usage.prompts_count} / {pricing.usage.max_prompts} prompts used
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-zinc-700">
              <div
                className={`h-full transition-all ${
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {tiers.map(tier => {
            const isCurrent = currentPlan === tier.id
            const isTeam = tier.id === 'team'
            const price = billingCycle === 'annual' ? tier.price_annual : tier.price_monthly

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
                  <p className="mt-1 min-h-[32px] text-xs leading-4 text-slate-500 dark:text-zinc-400">
                    {tier.tagline}
                  </p>

                  <div className="mt-3 border-t border-slate-100 pt-3 dark:border-zinc-800">
                    {tier.id === 'enterprise' ? (
                      <div className="flex items-baseline gap-1">
                        <span className="text-xl font-bold text-slate-900 dark:text-zinc-100">Custom</span>
                        <span className="text-xs text-slate-500 dark:text-zinc-400">/ quote</span>
                      </div>
                    ) : tier.id === 'community' ? (
                      <div className="flex items-baseline gap-1">
                        <span className="text-2xl font-bold text-slate-900 dark:text-zinc-100">$0</span>
                        <span className="text-xs text-slate-500 dark:text-zinc-400">/ forever</span>
                      </div>
                    ) : tier.id === 'pro' ? (
                      <div>
                        <div className="flex items-baseline gap-1">
                          <span className="text-2xl font-bold text-slate-900 dark:text-zinc-100">
                            ${price}
                          </span>
                          <span className="text-xs text-slate-500 dark:text-zinc-400">/ month</span>
                        </div>
                        {billingCycle === 'annual' && (
                          <span className="text-[11px] text-emerald-600 dark:text-emerald-400">Billed $48 annually</span>
                        )}
                      </div>
                    ) : (
                      <div>
                        <div className="flex items-baseline gap-1">
                          <span className="text-2xl font-bold text-slate-900 dark:text-zinc-100">
                            ${price}
                          </span>
                          <span className="text-xs text-slate-500 dark:text-zinc-400">/ editor / mo</span>
                        </div>
                        {billingCycle === 'annual' ? (
                          <span className="text-[11px] text-emerald-600 dark:text-emerald-400">Billed $120 annually</span>
                        ) : (
                          <span className="text-[11px] text-slate-500 dark:text-zinc-400">Billed monthly</span>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="mt-4 space-y-2">
                    <div className="rounded-lg bg-slate-50 p-2 text-[11px] leading-tight text-slate-600 dark:bg-zinc-850/60 dark:text-zinc-300">
                      <span className="font-semibold text-slate-800 dark:text-zinc-200">
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
                        ? 'bg-brand-600 text-white hover:bg-brand-700 shadow-2xs dark:bg-brand-500 dark:hover:bg-brand-600'
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
        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3.5 text-xs text-slate-600 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-start gap-2">
              <Users size={16} className="mt-0.5 shrink-0 text-brand-600 dark:text-brand-400" />
              <div>
                <p className="font-semibold text-slate-900 dark:text-zinc-100">Only Editors Pay on Team</p>
                <p className="text-slate-500 dark:text-zinc-400">
                  Every paid editor includes 2 free guest seats for read-only reviewers, legal counsel, and clients.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <HardDrive size={16} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <div>
                <p className="font-semibold text-slate-900 dark:text-zinc-100">Bring Your Own Storage (BYOS)</p>
                <p className="text-slate-500 dark:text-zinc-400">
                  Prompts can live directly in your company Google Drive or local folder while PromptHold manages review gates and diffs.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}
