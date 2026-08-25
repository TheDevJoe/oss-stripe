import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SUPA = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RETURN_URL = 'https://oss-stripe.netlify.app/return';
const REFRESH_URL = 'https://oss-stripe.netlify.app/refresh';

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  try {
    const { orgId, jwt } = JSON.parse(event.body || '{}');
    if (!orgId || !jwt) return json(400, { error: 'orgId and jwt required' });

    await requireAdmin(jwt, orgId);

    const orgRes = await fetch(`${SUPA}/rest/v1/organizations?id=eq.${orgId}&select=stripe_account_id,name`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
    });
    const [org] = await orgRes.json();
    if (!org) return json(404, { error: 'Church not found' });

    let accountId = org.stripe_account_id;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true }
        },
        business_profile: { name: org.name, mcc: '8398' }
      });
      accountId = account.id;
      await fetch(`${SUPA}/rest/v1/organizations?id=eq.${orgId}`, {
        method: 'PATCH',
        headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ stripe_account_id: accountId })
      });
    }

    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: REFRESH_URL,
      return_url: RETURN_URL,
      type: 'account_onboarding'
    });

    return json(200, { url: link.url, accountId });
  } catch (e) {
    return json(400, { error: e.message });
  }
};

async function requireAdmin(jwt, orgId) {
  const userRes = await fetch(`${SUPA}/auth/v1/user`, {
    headers: { apikey: ANON, Authorization: `Bearer ${jwt}` }
  });
  const user = await userRes.json();
  if (!user.email) throw new Error('Not authenticated');
  const check = await fetch(`${SUPA}/rest/v1/users?email=eq.${user.email}&select=is_admin,org_id`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
  });
  const [row] = await check.json();
  if (!row || !row.is_admin || row.org_id !== orgId) throw new Error('Admin only');
}

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
