import type { BillingInterval, PricingTier } from '../types'

export type BillingCycle = 'monthly' | 'annual'

export const cycleToInterval = (cycle: BillingCycle): BillingInterval => (cycle === 'annual' ? 'year' : 'month')

/** Price shown on a plan card, derived only from the catalogue served by GET /api/pricing. */
export function describePrice(tier: PricingTier, cycle: BillingCycle) {
  if (tier.price_monthly === null || tier.price_annual === null) {
    return { amount: 'Custom', unit: '/ quote', note: '' }
  }
  if (tier.price_monthly === 0) {
    return { amount: '$0', unit: '/ forever free', note: '' }
  }
  const unit = tier.per_seat ? '/ editor / mo' : '/ month'
  if (cycle === 'annual') {
    const yearly = tier.price_annual * 12
    return {
      amount: `$${tier.price_annual}`,
      unit,
      note: `Billed $${yearly}${tier.per_seat ? ' per editor' : ''} annually`,
    }
  }
  return { amount: `$${tier.price_monthly}`, unit, note: 'Billed monthly' }
}

/** Largest whole-number percentage saved by paying yearly across paid tiers ("Save up to N%"). */
export function annualSavingsPercent(tiers: PricingTier[]): number {
  const rates = tiers
    .filter(t => t.price_monthly && t.price_annual !== null && t.price_annual < (t.price_monthly ?? 0))
    .map(t => 1 - (t.price_annual as number) / (t.price_monthly as number))
  return rates.length ? Math.round(Math.max(...rates) * 100) : 0
}
