import Stripe from 'stripe';
import { db } from './db.js';

// Everything here is a no-op (returns null / does nothing) if
// STRIPE_SECRET_KEY isn't set, so the app keeps working without Stripe
// configured — the dev/testing plan-switch stays usable, real checkout
// links just aren't offered until keys are added in Railway.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;
export const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// Matches the prices shown on the public pricing page (pricing.html):
// Growth is $49/mo billed monthly, or $39/mo ($468/yr) billed annually.
const GROWTH_MONTHLY_AUD_CENTS = 4900;
const GROWTH_ANNUAL_AUD_CENTS = 46800;

// Creates the Growth-plan Product + two Prices (monthly/annual) in Stripe
// the first time the server ever boots with a Stripe key configured, then
// caches the price IDs in the database so every later boot just reuses
// them instead of creating duplicates. Safe to call on every startup.
export async function ensureGrowthPrices() {
  if (!stripe) return;
  await db.read();
  db.data.stripe ||= {};

  const cached = db.data.stripe;
  const upToDate = cached.growthMonthlyPriceId && cached.growthAnnualPriceId
    && cached.growthMonthlyCents === GROWTH_MONTHLY_AUD_CENTS
    && cached.growthAnnualCents === GROWTH_ANNUAL_AUD_CENTS;

  if (upToDate) return; // already created at the current price, nothing to do

  // Either nothing's cached yet, or the price constants above have changed
  // since the last boot. Stripe Price objects are immutable — you can't
  // edit an existing one's amount — so when the price changes we create a
  // brand new Price (attached to the same Product) and just start
  // pointing new checkouts at that one. The old Price object is left
  // alone in Stripe (existing subscribers keep billing at their original
  // rate until they cancel/renew onto the new price some other way) —
  // this only affects what NEW checkouts use going forward.
  console.log('[stripe] Growth prices missing or stale — creating current prices in Stripe...');

  let productId = cached.growthProductId;
  if (!productId) {
    const product = await stripe.products.create({
      name: 'Suggestions Box — Growth',
      description: 'Team notes, trends, priority queue, and team roles — billed per location.',
    });
    productId = product.id;
  }

  const monthly = await stripe.prices.create({
    product: productId,
    currency: 'aud',
    unit_amount: GROWTH_MONTHLY_AUD_CENTS,
    recurring: { interval: 'month' },
    nickname: 'Growth — monthly',
  });

  const annual = await stripe.prices.create({
    product: productId,
    currency: 'aud',
    unit_amount: GROWTH_ANNUAL_AUD_CENTS,
    recurring: { interval: 'year' },
    nickname: 'Growth — annual',
  });

  db.data.stripe.growthProductId = productId;
  db.data.stripe.growthMonthlyPriceId = monthly.id;
  db.data.stripe.growthAnnualPriceId = annual.id;
  db.data.stripe.growthMonthlyCents = GROWTH_MONTHLY_AUD_CENTS;
  db.data.stripe.growthAnnualCents = GROWTH_ANNUAL_AUD_CENTS;
  await db.write();
  console.log(`[stripe] Created Growth prices — monthly: ${monthly.id}, annual: ${annual.id}`);
}

export function growthPriceId(billingPeriod) {
  return billingPeriod === 'annual'
    ? db.data.stripe?.growthAnnualPriceId
    : db.data.stripe?.growthMonthlyPriceId;
}

// Applies a Stripe webhook event to our own data. Kept intentionally
// narrow: only touches plan/status fields, never anything else about the
// business, and only ever looks the business up by the Stripe IDs we
// ourselves stored — never trusts an ID out of the event blindly beyond
// that lookup.
export async function applyStripeEvent(event) {
  await db.read();

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const businessId = session.metadata?.businessId;
      const business = businessId && db.data.businesses.find((b) => b.id === businessId);
      if (!business) break;
      business.stripeCustomerId = session.customer;
      business.stripeSubscriptionId = session.subscription;
      business.plan = 'growth';
      business.planStatus = 'trialing';
      await db.write();
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const business = db.data.businesses.find((b) => b.stripeSubscriptionId === sub.id);
      if (!business) break;
      business.planStatus = sub.status; // trialing | active | past_due | canceled | unpaid | ...
      business.trialEndsAt = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;
      business.currentPeriodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
      business.cancelAtPeriodEnd = !!sub.cancel_at_period_end;
      if (['active', 'trialing'].includes(sub.status)) {
        business.plan = 'growth';
      } else if (['canceled', 'unpaid', 'incomplete_expired'].includes(sub.status)) {
        business.plan = 'starter';
      }
      await db.write();
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const business = db.data.businesses.find((b) => b.stripeSubscriptionId === sub.id);
      if (!business) break;
      business.plan = 'starter';
      business.planStatus = 'canceled';
      business.cancelAtPeriodEnd = false;
      await db.write();
      break;
    }

    default:
      break; // other event types aren't relevant to plan state
  }
}
