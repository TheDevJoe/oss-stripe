import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SUPA = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

export const handler = async (event) => {
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  if (!sig || !WEBHOOK_SECRET) return { statusCode: 400, body: 'Missing signature or secret' };

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    return { statusCode: 400, body: `Webhook signature error: ${err.message}` };
  }

  try {
    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data.object;
      if (session.mode !== 'payment') return { statusCode: 200, body: 'ignored non-payment' };
      if (session.payment_status !== 'paid') return { statusCode: 200, body: 'ignored unpaid' };

      const orgId = session.metadata?.org_id || session.payment_intent_data?.metadata?.org_id;
      let intentOrgId = orgId;
      let paymentIntent = null;
      let receiptUrl = null;
      let feeCents = 0;
      let donorName = '';
      let donorEmail = session.customer_email || session.customer_details?.email || '';

      if (session.payment_intent) {
        paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent, {
          expand: ['latest_charge']
        });
        intentOrgId = intentOrgId || paymentIntent.metadata?.org_id;
        feeCents = paymentIntent.application_fee_amount || 0;
        donorName = paymentIntent.metadata?.donor_name || donorName;
        if (!donorEmail) donorEmail = paymentIntent.metadata?.donor_email || paymentIntent.receipt_email || '';
        if (paymentIntent.latest_charge && typeof paymentIntent.latest_charge === 'object') {
          receiptUrl = paymentIntent.latest_charge.receipt_url || null;
        }
      }

      if (!intentOrgId) {
        return { statusCode: 200, body: 'ignored: no org_id in metadata' };
      }

      let donorUserId = null;
      if (donorEmail) {
        const userRes = await fetch(`${SUPA}/rest/v1/users?email=eq.${encodeURIComponent(donorEmail)}&org_id=eq.${intentOrgId}&select=id,full_name&limit=1`, {
          headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
        });
        const [u] = await userRes.json();
        if (u) {
          donorUserId = u.id;
          if (!donorName) donorName = u.full_name;
        }
      }

      const row = {
        org_id: intentOrgId,
        donor_user_id: donorUserId,
        donor_email: donorEmail || null,
        donor_name: donorName || null,
        amount_cents: session.amount_total,
        platform_fee_cents: feeCents,
        currency: (session.currency || 'usd').toLowerCase(),
        status: 'succeeded',
        stripe_session_id: session.id,
        stripe_payment_intent: paymentIntent ? paymentIntent.id : null,
        stripe_receipt_url: receiptUrl
      };

      const upsertRes = await fetch(`${SUPA}/rest/v1/donations?on_conflict=stripe_session_id`, {
        method: 'POST',
        headers: {
          apikey: SERVICE,
          Authorization: `Bearer ${SERVICE}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(row)
      });
      if (!upsertRes.ok) {
        const t = await upsertRes.text();
        return { statusCode: 500, body: `Supabase insert error: ${t}` };
      }
    }

    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    return { statusCode: 500, body: e.message };
  }
};
