import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SUPA = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  try {
    const { orgId, jwt } = JSON.parse(event.body || '{}');
    if (!orgId || !jwt) return json(400, { error: 'orgId and jwt required' });

    const userRes = await fetch(`${SUPA}/auth/v1/user`, {
      headers: { apikey: ANON, Authorization: `Bearer ${jwt}` }
    });
    const user = await userRes.json();
    if (!user.email) return json(401, { error: 'Not authenticated' });

    const check = await fetch(`${SUPA}/rest/v1/users?email=eq.${user.email}&select=is_admin,org_id`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
    });
    const [row] = await check.json();
    if (!row || !row.is_admin || row.org_id !== orgId) return json(403, { error: 'Admin only' });

    const orgRes = await fetch(`${SUPA}/rest/v1/organizations?id=eq.${orgId}&select=stripe_account_id`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
    });
    const [org] = await orgRes.json();
    if (!org || !org.stripe_account_id) return json(400, { error: 'No Stripe account yet' });

    const link = await stripe.accounts.createLoginLink(org.stripe_account_id);
    return json(200, { url: link.url });
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
