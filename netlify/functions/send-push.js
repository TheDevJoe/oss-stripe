// Created by Joseph Foss on 10/5/26 · Updated 10/6/26
// Our Sunday Schedule — chat, callout, announcement and SOS pushes.
// Only a signed-in church member can send, only to people in their own church, and only admins
// can send SOS or announcements. Every phone is sent to its own APNs environment (TestFlight or Xcode).
import http2 from 'node:http2';
import jwt from 'jsonwebtoken';

const SUPA = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.SUPABASE_ANON_KEY || SERVICE;
const KEY_ID = process.env.APNS_KEY_ID;
const TEAM_ID = process.env.APNS_TEAM_ID;
const BUNDLE_ID = process.env.APNS_BUNDLE_ID;
const KEY_P8 = (process.env.APNS_KEY_P8 || '').replace(/\\n/g, '\n');

const ADMIN_ONLY = new Set(['sos', 'announce']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    const sender = await signedInSender(event.headers || {});
    if (!sender) return json(401, { error: 'Sign in required' });

    const { userIds, title, body, kind = 'generic', data = {} } = JSON.parse(event.body || '{}');
    if (!Array.isArray(userIds) || userIds.length === 0) return json(400, { error: 'userIds required' });
    if (!title || !body) return json(400, { error: 'title and body required' });
    if (ADMIN_ONLY.has(kind) && !sender.is_admin) return json(403, { error: 'Only church admins can send this' });

    // Only real IDs (they go into a database filter) and only people in the sender's church.
    const ids = [...new Set(userIds.map(String))].filter((id) => UUID.test(id) && id !== sender.id);
    if (ids.length === 0) return json(200, { sent: 0, failed: 0 });
    const members = await rest(`users?id=in.(${ids.join(',')})&org_id=eq.${sender.org_id}&select=id`);
    if (members.length === 0) return json(200, { sent: 0, failed: 0 });

    const devices = await rest(`device_tokens?user_id=in.(${members.map((m) => m.id).join(',')})&select=apns_token,environment`);
    if (devices.length === 0) return json(200, { sent: 0, failed: 0, note: 'no devices registered' });

    const results = await sendAll(devices, JSON.stringify(buildPayload(title, body, kind, data)));

    // Forget phones Apple says are gone. Only these two answers mean the token itself is bad.
    const dead = results.filter((r) => r.status === 410 || (r.status === 400 && /BadDeviceToken/.test(r.body || '')));
    for (const r of dead) {
      await fetch(`${SUPA}/rest/v1/device_tokens?apns_token=eq.${encodeURIComponent(r.token)}`, {
        method: 'DELETE',
        headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Prefer: 'return=minimal' }
      });
    }
    const sent = results.filter((r) => r.status === 200).length;
    console.log(`send-push: kind=${kind} devices=${devices.length} sent=${sent} removed=${dead.length}`);
    return json(200, { sent, failed: results.length - sent });
  } catch (e) {
    console.error('send-push error:', e);
    return json(500, { error: e.message });
  }
};

/** The church member behind the app's session token, or null. */
async function signedInSender(headers) {
  const auth = headers.authorization || headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  const r = await fetch(`${SUPA}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const user = await r.json();
  if (!user || !user.email) return null;
  const rows = await rest(`users?email=eq.${encodeURIComponent(user.email)}&select=id,org_id,is_admin&limit=1`);
  return rows[0] || null;
}

async function rest(path) {
  const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

function buildPayload(title, body, kind, data) {
  const extra = {};
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      if (k === 'aps' || k === 'kind') continue;
      if (typeof v === 'string' && k.length <= 40 && v.length <= 200) extra[k] = v;
    }
  }
  return {
    aps: {
      alert: { title: String(title).slice(0, 120), body: String(body).slice(0, 1000) },
      sound: 'default',
      'thread-id': extra.conversation_id || kind
    },
    kind,
    ...extra
  };
}

// One signing token per 30-minute window, so warm and cold starts share it and APNs
// never sees the token churn it rejects with TooManyProviderTokenUpdates.
let cachedJwt = null;
function apnsJwt() {
  const now = Math.floor(Date.now() / 1000);
  const issuedAt = now - (now % 1800);
  if (!cachedJwt || cachedJwt.iat !== issuedAt) {
    const token = jwt.sign({ iss: TEAM_ID, iat: issuedAt }, KEY_P8, { algorithm: 'ES256', header: { alg: 'ES256', kid: KEY_ID } });
    cachedJwt = { iat: issuedAt, token };
  }
  return cachedJwt.token;
}

/** One HTTP/2 connection per APNs environment, 20 pushes in flight at a time. */
async function sendAll(devices, payload) {
  const byHost = new Map();
  for (const d of devices) {
    const host = d.environment === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(d.apns_token);
  }
  const bearer = apnsJwt();
  const results = [];
  for (const [host, tokens] of byHost) {
    const client = http2.connect(`https://${host}`);
    client.on('error', () => {});
    try {
      for (let i = 0; i < tokens.length; i += 20) {
        const batch = tokens.slice(i, i + 20);
        results.push(...await Promise.all(batch.map((t) => sendOne(client, t, payload, bearer))));
      }
    } finally {
      try { client.close(); } catch {}
    }
  }
  return results;
}

function sendOne(client, token, payload, bearer) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve({ token, ...r }); } };
    let req;
    try {
      req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        authorization: `bearer ${bearer}`,
        'apns-topic': BUNDLE_ID,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json'
      });
    } catch (e) {
      return done({ status: 0, error: e.message });
    }
    let status = 0;
    let text = '';
    req.setEncoding('utf8');
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (c) => { text += c; });
    req.on('end', () => done({ status, body: text }));
    req.on('error', (e) => done({ status: 0, error: e.message }));
    req.setTimeout(8000, () => { try { req.close(); } catch {} done({ status: 0, error: 'timeout' }); });
    req.end(payload);
  });
}

const cors = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
});
const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...cors() },
  body: JSON.stringify(body)
});
// ;-)
