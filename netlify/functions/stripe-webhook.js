import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SUPA = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const supaHeaders = {
  apikey: SERVICE,
  Authorization: `Bearer ${SERVICE}`,
  'Content-Type': 'application/json'
};

export const handler = async (event) => {
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  if (!sig || !WEBHOOK_SECRET) return { statusCode: 400, body: 'Missing signature or secret' };

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    return { statusCode: 400, body: `Webhook signature error: ${err.message}` };
  }

  const connectedAccount = stripeEvent.account || null;

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(stripeEvent.data.object, connectedAccount);
        break;
      case 'invoice.paid':
        await handleInvoicePaid(stripeEvent.data.object, connectedAccount);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(stripeEvent.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(stripeEvent.data.object);
        break;
    }
    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    return { statusCode: 500, body: e.message };
  }
};

async function handleCheckoutCompleted(session, connectedAccount) {
  if (session.payment_status !== 'paid' && session.mode !== 'subscription') return;
  const stripeOpts = connectedAccount ? { stripeAccount: connectedAccount } : undefined;

  if (session.mode === 'subscription' && session.subscription) {
    const sub = await stripe.subscriptions.retrieve(session.subscription, {
      expand: ['items.data.price']
    }, stripeOpts);
    const orgId = sub.metadata?.org_id;
    if (!orgId) return;

    const donorEmail = session.customer_email || session.customer_details?.email || sub.metadata?.donor_email || '';
    const donorUserId = await lookupDonorUserId(donorEmail, orgId);
    const price = sub.items.data[0]?.price;
    const amount = price?.unit_amount || 0;
    const interval = price?.recurring?.interval || sub.metadata?.interval || 'month';

    const row = {
      org_id: orgId,
      donor_user_id: donorUserId,
      donor_email: donorEmail || null,
      donor_name: sub.metadata?.donor_name || null,
      amount_cents: amount,
      interval,
      currency: (price?.currency || 'usd').toLowerCase(),
      status: sub.status === 'active' || sub.status === 'trialing' ? 'active' : sub.status,
      stripe_subscription_id: sub.id,
      stripe_customer_id: sub.customer,
      started_at: new Date((sub.start_date || sub.created) * 1000).toISOString(),
      next_invoice_at: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null
    };
    await upsert('donation_subscriptions', row, 'stripe_subscription_id');
    return;
  }

  if (session.mode === 'payment') {
    const orgId = session.metadata?.org_id;
    let intentOrgId = orgId;
    let paymentIntent = null;
    let receiptUrl = null;
    let feeCents = 0;
    let donorName = '';
    let donorEmail = session.customer_email || session.customer_details?.email || '';

    if (session.payment_intent) {
      paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent, {
        expand: ['latest_charge']
      }, stripeOpts);
      intentOrgId = intentOrgId || paymentIntent.metadata?.org_id;
      feeCents = paymentIntent.application_fee_amount || 0;
      donorName = paymentIntent.metadata?.donor_name || donorName;
      if (!donorEmail) donorEmail = paymentIntent.metadata?.donor_email || paymentIntent.receipt_email || '';
      if (paymentIntent.latest_charge && typeof paymentIntent.latest_charge === 'object') {
        receiptUrl = paymentIntent.latest_charge.receipt_url || null;
      }
    }
    if (!intentOrgId) return;

    const donorUserId = await lookupDonorUserId(donorEmail, intentOrgId);
    if (!donorName && donorUserId) {
      const nameRes = await fetch(`${SUPA}/rest/v1/users?id=eq.${donorUserId}&select=full_name`, { headers: supaHeaders });
      const [u] = await nameRes.json(); if (u) donorName = u.full_name || '';
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
    await upsert('donations', row, 'stripe_session_id');
  }
}

async function handleInvoicePaid(invoice, connectedAccount) {
  if (!invoice.subscription) return;
  const stripeOpts = connectedAccount ? { stripeAccount: connectedAccount } : undefined;

  const sub = await stripe.subscriptions.retrieve(invoice.subscription, {}, stripeOpts);
  const orgId = sub.metadata?.org_id;
  if (!orgId) return;

  const charge = invoice.charge
    ? await stripe.charges.retrieve(invoice.charge, {}, stripeOpts)
    : null;

  const donorEmail = invoice.customer_email || sub.metadata?.donor_email || '';
  const donorUserId = await lookupDonorUserId(donorEmail, orgId);

  const row = {
    org_id: orgId,
    donor_user_id: donorUserId,
    donor_email: donorEmail || null,
    donor_name: sub.metadata?.donor_name || null,
    amount_cents: invoice.amount_paid,
    platform_fee_cents: invoice.application_fee_amount || 0,
    currency: (invoice.currency || 'usd').toLowerCase(),
    status: 'succeeded',
    stripe_session_id: invoice.payment_intent ? null : `invoice_${invoice.id}`,
    stripe_payment_intent: invoice.payment_intent || null,
    stripe_receipt_url: charge?.receipt_url || invoice.hosted_invoice_url || null,
    stripe_subscription_id: sub.id
  };

  const dedupeKey = invoice.payment_intent ? 'stripe_payment_intent' : 'stripe_session_id';
  await upsert('donations', row, dedupeKey);

  await fetch(`${SUPA}/rest/v1/donation_subscriptions?stripe_subscription_id=eq.${sub.id}`, {
    method: 'PATCH', headers: { ...supaHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({
      next_invoice_at: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
      status: sub.status === 'active' || sub.status === 'trialing' ? 'active' : sub.status
    })
  });
}

async function handleSubscriptionDeleted(sub) {
  await fetch(`${SUPA}/rest/v1/donation_subscriptions?stripe_subscription_id=eq.${sub.id}`, {
    method: 'PATCH', headers: { ...supaHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'canceled', ended_at: new Date().toISOString() })
  });
}

async function handleSubscriptionUpdated(sub) {
  const patch = {
    status: sub.status === 'active' || sub.status === 'trialing' ? 'active' : sub.status,
    next_invoice_at: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null
  };
  if (sub.canceled_at) patch.ended_at = new Date(sub.canceled_at * 1000).toISOString();
  await fetch(`${SUPA}/rest/v1/donation_subscriptions?stripe_subscription_id=eq.${sub.id}`, {
    method: 'PATCH', headers: { ...supaHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify(patch)
  });
}

async function lookupDonorUserId(email, orgId) {
  if (!email) return null;
  const res = await fetch(`${SUPA}/rest/v1/users?email=eq.${encodeURIComponent(email)}&org_id=eq.${orgId}&select=id&limit=1`, {
    headers: supaHeaders
  });
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0].id : null;
}

async function upsert(table, row, conflictColumn) {
  const res = await fetch(`${SUPA}/rest/v1/${table}?on_conflict=${conflictColumn}`, {
    method: 'POST',
    headers: { ...supaHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row)
  });
  if (!res.ok) throw new Error(`${table} upsert failed: ${await res.text()}`);
}
