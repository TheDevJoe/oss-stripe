// Created by Joseph Foss on 9/23/26
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SUPA = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PLATFORM_FEE_CENTS = 150; // what you keep, clean, on every recurring charge

const VALID_INTERVALS = new Set(['week', 'month', 'year']);

// Stripe's card fee (2.9% + 30¢), billed to the platform on destination charges.
const stripeFee = (cents) => Math.round(cents * 0.029) + 30;

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  try {
    // amountCents from the app is the GIFT; the $1.50 is added here so every charge includes it.
    const { orgId, amountCents, interval, donorName, donorEmail } = JSON.parse(event.body || '{}');
    if (!orgId || !amountCents) return json(400, { error: 'orgId and amountCents required' });
    if (!VALID_INTERVALS.has(interval)) return json(400, { error: 'interval must be week, month, or year' });
    if (amountCents < 200) return json(400, { error: 'Minimum recurring donation is $2.00' });

    const orgRes = await fetch(`${SUPA}/rest/v1/organizations?id=eq.${orgId}&select=stripe_account_id,stripe_charges_enabled,name`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
    });
    const [org] = await orgRes.json();
    if (!org) return json(404, { error: 'Church not found' });
    if (!org.stripe_account_id || !org.stripe_charges_enabled) {
      return json(400, { error: 'This church has not set up donations yet' });
    }

    const totalCents = amountCents + PLATFORM_FEE_CENTS;
    // Subscriptions only accept a percentage fee, so convert "$1.50 + Stripe's fee" into the
    // exact percent of this charge (Stripe allows 2 decimals, so it lands within a cent).
    const feePercent = Math.ceil(((PLATFORM_FEE_CENTS + stripeFee(totalCents)) / totalCents) * 10000) / 100;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `Recurring donation to ${org.name}` },
          unit_amount: totalCents,
          recurring: { interval }
        },
        quantity: 1
      }],
      subscription_data: {
        application_fee_percent: feePercent,
        transfer_data: { destination: org.stripe_account_id },
        description: `Recurring donation to ${org.name}`,
        metadata: {
          org_id: orgId,
          donor_name: donorName || '',
          donor_email: donorEmail || '',
          interval,
          gift_cents: String(amountCents)
        }
      },
      customer_email: donorEmail || undefined,
      success_url: 'https://oss-stripe.netlify.app/donate-success',
      cancel_url: 'https://oss-stripe.netlify.app/donate-cancel'
    });

    return json(200, { url: session.url });
  } catch (e) {
    return json(400, { error: e.message });
  }
};

const cors = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
});
const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...cors() },
  body: JSON.stringify(body)
});
// ;-)
