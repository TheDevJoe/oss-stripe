import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SUPA = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  try {
    const { orgId } = JSON.parse(event.body || '{}');
    if (!orgId) return json(400, { error: 'orgId required' });

    const orgRes = await fetch(`${SUPA}/rest/v1/organizations?id=eq.${orgId}&select=stripe_account_id`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
    });
    const [org] = await orgRes.json();
    if (!org || !org.stripe_account_id) return json(200, { ready: false, chargesEnabled: false });

    const account = await stripe.accounts.retrieve(org.stripe_account_id);
    const ready = account.charges_enabled && account.details_submitted;

    await fetch(`${SUPA}/rest/v1/organizations?id=eq.${orgId}`, {
      method: 'PATCH',
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stripe_charges_enabled: ready })
    });

    return json(200, {
      ready,
      chargesEnabled: account.charges_enabled,
      detailsSubmitted: account.details_submitted,
      payoutsEnabled: account.payouts_enabled
    });
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
