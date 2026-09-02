import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SUPA = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  try {
    const { subscriptionId, jwt } = JSON.parse(event.body || '{}');
    if (!subscriptionId || !jwt) return json(400, { error: 'subscriptionId and jwt required' });

    const userRes = await fetch(`${SUPA}/auth/v1/user`, {
      headers: { apikey: ANON, Authorization: `Bearer ${jwt}` }
    });
    const user = await userRes.json();
    if (!user.email) return json(401, { error: 'Not authenticated' });

    const subRes = await fetch(`${SUPA}/rest/v1/donation_subscriptions?id=eq.${subscriptionId}&select=stripe_subscription_id,donor_email,donor_user_id,org_id`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
    });
    const [sub] = await subRes.json();
    if (!sub) return json(404, { error: 'Subscription not found' });

    const isOwner = sub.donor_email === user.email;
    if (!isOwner) {
      const meRes = await fetch(`${SUPA}/rest/v1/users?email=eq.${encodeURIComponent(user.email)}&select=id,is_admin,org_id`, {
        headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
      });
      const [me] = await meRes.json();
      const isDonorById = me && me.id === sub.donor_user_id;
      const isAdmin = me && me.is_admin && me.org_id === sub.org_id;
      if (!isDonorById && !isAdmin) return json(403, { error: 'Not allowed' });
    }

    const orgRes = await fetch(`${SUPA}/rest/v1/organizations?id=eq.${sub.org_id}&select=stripe_account_id`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
    });
    const [org] = await orgRes.json();
    if (!org || !org.stripe_account_id) return json(400, { error: 'Church Stripe account missing' });

    await stripe.subscriptions.cancel(sub.stripe_subscription_id, {}, { stripeAccount: org.stripe_account_id });

    await fetch(`${SUPA}/rest/v1/donation_subscriptions?id=eq.${subscriptionId}`, {
      method: 'PATCH',
      headers: {
        apikey: SERVICE,
        Authorization: `Bearer ${SERVICE}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ status: 'canceled', ended_at: new Date().toISOString() })
    });

    return json(200, { ok: true });
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
