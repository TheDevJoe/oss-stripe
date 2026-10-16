// Created by Joseph Foss on 10/5/26 · Updated 10/16/26
// Our Sunday Schedule — chat, callout, announcement and SOS pushes, and "someone wants to join".
// Only a signed-in church member can send, only to people in their own church, and only admins
// can send SOS or announcements. Someone waiting to get into a church can send one thing: a ping to
// that church's leaders that they're waiting, with words the server picks. A church claim to check and a
// reported message also reach the app's owner, whatever church they come from. Every phone is sent to its
// own APNs environment (TestFlight or Xcode).
import http2 from 'node:http2';
import jwt from 'jsonwebtoken';

const SUPA = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.SUPABASE_ANON_KEY || SERVICE;
const KEY_ID = process.env.APNS_KEY_ID;
const TEAM_ID = process.env.APNS_TEAM_ID;
/** The app's own ID with Apple, from the Xcode project. Apple refuses a push sent under any other. */
const BUNDLE_ID = 'com.josephfoss.Our-Sunday-Schedule';
const KEY_P8 = (process.env.APNS_KEY_P8 || '').replace(/\\n/g, '\n');

const ADMIN_ONLY = new Set(['sos', 'announce']);
/** Pings that also go to the app's owner, from any church. */
const OWNER_PINGS = new Set(['claim', 'report']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    const user = await signedInUser(event.headers || {});
    if (!user) return json(401, { error: 'Sign in required' });

    const { userIds, title, body, kind = 'generic', data = {} } = JSON.parse(event.body || '{}');
    const sender = await memberFor(user.email);
    if (!sender) {
      // Not in a church yet: they can ask to be let in, or tell the app's owner a church is theirs.
      if (kind === 'join') return await askLeaders(user.email);
      if (kind !== 'claim') return json(401, { error: 'Sign in required' });
    }
    if (!Array.isArray(userIds) || userIds.length === 0) return json(400, { error: 'userIds required' });
    if (!title || !body) return json(400, { error: 'title and body required' });
    if (ADMIN_ONLY.has(kind) && !sender?.is_admin) return json(403, { error: 'Only church admins can send this' });

    // Only real IDs (they go into a database filter), only people in the sender's church, and the app's owner
    // for the pings meant for them.
    const ids = [...new Set(userIds.map(String))].filter((id) => UUID.test(id) && id !== sender?.id);
    if (ids.length === 0) return json(200, { sent: 0, failed: 0 });
    const allowed = new Set();
    if (sender) {
      for (const m of await rest(`users?id=in.(${ids.join(',')})&org_id=eq.${sender.org_id}&select=id`)) allowed.add(m.id);
    }
    if (OWNER_PINGS.has(kind)) {
      for (const id of await owners(ids)) allowed.add(id);
    }
    if (allowed.size === 0) return json(200, { sent: 0, failed: 0 });

    const devices = await rest(`device_tokens?user_id=in.(${[...allowed].join(',')})&select=apns_token,environment`);
    if (devices.length === 0) return json(200, { sent: 0, failed: 0, note: 'no devices registered' });

    const results = await sendAll(devices, JSON.stringify(buildPayload(title, body, kind, data)));
    const removed = await forgetDead(results);
    const sent = results.filter((r) => r.status === 200).length;
    console.log(`send-push: kind=${kind} devices=${devices.length} sent=${sent} removed=${removed}`);
    return json(200, { sent, failed: results.length - sent });
  } catch (e) {
    console.error('send-push error:', e);
    return json(500, { error: e.message });
  }
};

/** The signed-in account behind the app's session token, or null. */
async function signedInUser(headers) {
  const auth = headers.authorization || headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  const r = await fetch(`${SUPA}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const user = await r.json();
  return user && user.email ? user : null;
}

/** That account's place in a church, or null when it isn't in one yet. */
async function memberFor(email) {
  const rows = await rest(`users?email=eq.${encodeURIComponent(email)}&select=id,org_id,is_admin&limit=1`);
  return rows[0] || null;
}

/** Which of these people are the app's owner. */
async function owners(ids) {
  const emails = (await rest('app_owners?select=email')).map((o) => `"${o.email}"`);
  if (emails.length === 0) return [];
  const rows = await rest(`users?id=in.(${ids.join(',')})&email=in.(${encodeURIComponent(emails.join(','))})&select=id`);
  return rows.map((r) => r.id);
}

/** Someone waiting to join: tells the church's leaders, with the server's own words and nothing else. */
async function askLeaders(email) {
  const asks = await rest(`join_requests?email=eq.${encodeURIComponent(email)}&select=org_id,full_name&limit=1`);
  if (asks.length === 0) return json(200, { sent: 0, failed: 0 });
  const leaders = await rest(`users?org_id=eq.${asks[0].org_id}&is_admin=eq.true&select=id`);
  if (leaders.length === 0) return json(200, { sent: 0, failed: 0 });
  const devices = await rest(`device_tokens?user_id=in.(${leaders.map((l) => l.id).join(',')})&select=apns_token,environment`);
  if (devices.length === 0) return json(200, { sent: 0, failed: 0, note: 'no devices registered' });
  const name = String(asks[0].full_name || 'Someone').slice(0, 60);
  const payload = buildPayload('Someone wants to join', `${name} is waiting for you to let them in.`, 'join', {});
  const results = await sendAll(devices, JSON.stringify(payload));
  const removed = await forgetDead(results);
  const sent = results.filter((r) => r.status === 200).length;
  console.log(`send-push: kind=join devices=${devices.length} sent=${sent} removed=${removed}`);
  return json(200, { sent, failed: results.length - sent });
}

/** Forgets phones Apple says are gone. Only these two answers mean the token itself is bad. */
async function forgetDead(results) {
  const dead = results.filter((r) => r.status === 410 || (r.status === 400 && /BadDeviceToken/.test(r.body || '')));
  for (const r of dead) {
    await fetch(`${SUPA}/rest/v1/device_tokens?apns_token=eq.${encodeURIComponent(r.token)}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Prefer: 'return=minimal' }
    });
  }
  return dead.length;
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
