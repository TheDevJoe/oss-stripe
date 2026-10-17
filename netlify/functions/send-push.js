// Created by Joseph Foss on 10/5/26 · Updated 10/17/26
// Our Sunday Schedule — every push one person's phone sends to others: chat messages, swap and sub requests, "you're
// on the schedule", announcements and SOS, reported messages, church claims, passing the church on, and "someone
// wants to join".
// Church leaders can send their own words to anyone in their church. Everyone else can only reach the people the
// server allows, with words the server writes from what's in the database:
//   chat     → people in that chat, with the message they just sent (never anyone who blocked them)
//   cover    → people in the church, about the spot they just gave up
//   swap     → the swap they just asked for (open to the church, or the one person asked), or "you're covered"
//   assigned → team leaders, to people in the church
//   report   → the church's leaders and the app's owner, after reporting a message
//   claim    → the app's owner, after saying a church is theirs
//   handoff  → the new leader, from the person who just passed the church on
//   join     → that church's leaders, from someone waiting to get in
// Every phone is sent to its own APNs environment (TestFlight or Xcode).
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How recently something must have happened for its push to go out. */
const RECENT_MS = 10 * 60 * 1000;
const SPOT = 'position:positions(name),support_position:support_positions(name),' +
  'service_date:service_dates(org_id,service_date,service_time),event:events(org_id,event_date,event_time)';

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    const user = await signedInUser(event.headers || {});
    if (!user) return json(401, { error: 'Sign in required' });

    const { userIds = [], title, body, kind = 'generic', data = {} } = JSON.parse(event.body || '{}');
    const asked = [...new Set((Array.isArray(userIds) ? userIds : []).map(String))].filter((id) => UUID.test(id));
    const sender = await memberFor(user.email);

    // Not in a church yet: they can ask to be let in, or tell the app's owner a church is theirs.
    if (!sender) {
      if (kind === 'join') return await askLeaders(user.email);
      if (kind === 'claim') return await deliver(await claimPing(user.email, asked), kind);
      return json(401, { error: 'Sign in required' });
    }

    let push;
    switch (kind) {
      case 'chat': push = await chatPing(sender, asked, data); break;
      case 'cover': push = await coverPing(sender, asked, data); break;
      case 'swap': push = await swapPing(sender, asked, data); break;
      case 'report': push = await reportPing(sender, asked); break;
      case 'claim': push = await claimPing(user.email, asked); break;
      case 'handoff': push = await handoffPing(sender, asked); break;
      case 'join': return await askLeaders(user.email);
      case 'assigned': push = await leaderWords(sender, asked, title, body, kind, data, true); break;
      default: push = await leaderWords(sender, asked, title, body, kind, data, false);
    }
    return await deliver(push, kind);
  } catch (e) {
    if (e.statusCode) return json(e.statusCode, { error: e.message });
    console.error('send-push error:', e);
    return json(500, { error: e.message });
  }
};

// ── Who may be told what ─────────────────────────────────────────────────────────────────────────

/** A church leader's own words to people in their church. With `teamLeaders`, a team's leader may send too. */
async function leaderWords(sender, asked, title, body, kind, data, teamLeaders) {
  let allowed = sender.is_admin;
  if (!allowed && teamLeaders) {
    allowed = (await rest(`team_members?user_id=eq.${sender.id}&is_leader=eq.true&select=id&limit=1`)).length > 0;
  }
  if (!allowed) throw httpError(403, 'Only church leaders can send this');
  if (!title) throw httpError(400, 'title required');
  // An announcement with no message still goes out, with its title as the words.
  return { to: await inChurch(sender, asked), title, body: body || title, kind, data: cleanData(data) };
}

/** A chat message: only to people in that chat who haven't blocked the sender, with the message itself. */
async function chatPing(sender, asked, data) {
  const conversationId = String(data.conversation_id || '');
  if (!UUID.test(conversationId)) return none();
  const [conversation] = await rest(`conversations?id=eq.${conversationId}&org_id=eq.${sender.org_id}&select=id,name,is_group`);
  if (!conversation) return none();
  const members = new Set((await rest(`conversation_members?conversation_id=eq.${conversationId}&select=user_id`)).map((m) => m.user_id));
  if (!members.has(sender.id)) return none();
  const [message] = await rest(`messages?conversation_id=eq.${conversationId}&sender_id=eq.${sender.id}&deleted_at=is.null` +
    `&created_at=gte.${since()}&order=created_at.desc&limit=1&select=body`);
  if (!message) return none();
  let to = asked.filter((id) => members.has(id) && id !== sender.id);
  if (to.length) {
    const blockers = new Set((await rest(`chat_blocks?blocked_id=eq.${sender.id}&blocker_id=in.(${to.join(',')})&select=blocker_id`)).map((b) => b.blocker_id));
    to = to.filter((id) => !blockers.has(id));
  }
  const first = firstName(sender.full_name);
  return {
    to,
    title: conversation.is_group ? (conversation.name || 'Group chat') : shortName(sender.full_name),
    body: conversation.is_group ? `${first}: ${message.body}` : message.body,
    kind: 'chat',
    data: { conversation_id: conversationId }
  };
}

/** Can't make it: people in the church, about the spot this person just gave up. */
async function coverPing(sender, asked, data) {
  const slotId = String(data.slot_id || '');
  if (!UUID.test(slotId)) return none();
  const [slot] = await rest(`slots?id=eq.${slotId}&cover_requested_by=eq.${sender.id}&cover_requested_at=gte.${since()}` +
    `&select=id,${SPOT}`);
  if (!slot || spotChurch(slot) !== sender.org_id) return none();
  const spot = describe(slot);
  return {
    to: await inChurch(sender, asked),
    title: `Can you cover ${spot.job}?`,
    body: `${spot.when}. Tap to take it.`,
    kind: 'cover',
    data: { slot_id: slotId }
  };
}

/** A swap: the one this person just asked for, or "you're covered" to whoever's spot they just took. */
async function swapPing(sender, asked, data) {
  const swapId = String(data.swap_id || '');
  if (UUID.test(swapId)) {
    const [swap] = await rest(`swap_requests?id=eq.${swapId}&to_user_id=eq.${sender.id}&status=eq.accepted` +
      `&responded_at=gte.${since()}&select=from_user_id`);
    if (!swap) return none();
    return {
      to: asked.filter((id) => id === swap.from_user_id),
      title: "You're covered",
      body: `${firstName(sender.full_name)} took your spot.`,
      kind: 'swap',
      data: { swap_id: swapId }
    };
  }
  const [swap] = await rest(`swap_requests?from_user_id=eq.${sender.id}&org_id=eq.${sender.org_id}&status=eq.pending` +
    `&created_at=gte.${since()}&order=created_at.desc&limit=1&select=id,to_user_id,slot:slots(${SPOT})`);
  if (!swap || !swap.slot) return none();
  const to = swap.to_user_id ? asked.filter((id) => id === swap.to_user_id) : await inChurch(sender, asked);
  const spot = describe(swap.slot);
  return {
    to,
    title: `Can you take ${spot.job}?`,
    body: `${firstName(sender.full_name)} is asking for a swap on ${spot.when}.`,
    kind: 'swap',
    data: { swap_id: swap.id }
  };
}

/** A reported message: the church's leaders and the app's owner. The message itself stays out of the push. */
async function reportPing(sender, asked) {
  const reported = await rest(`chat_reports?reporter_id=eq.${sender.id}&created_at=gte.${since()}&select=id&limit=1`);
  if (!reported.length) return none();
  const leaders = new Set((await rest(`users?org_id=eq.${sender.org_id}&is_admin=eq.true&select=id`)).map((u) => u.id));
  const owners = new Set(await owners_(asked));
  return {
    to: asked.filter((id) => id !== sender.id && (leaders.has(id) || owners.has(id))),
    title: 'A message was reported',
    body: 'Open Reported Messages in Settings to look at it.',
    kind: 'report',
    data: {}
  };
}

/** "This is my church": the app's owner, about the request this person just sent. */
async function claimPing(email, asked) {
  const [dispute] = await rest(`claim_disputes?email=eq.${encodeURIComponent(email.toLowerCase())}&created_at=gte.${since()}` +
    `&order=created_at.desc&limit=1&select=full_name,listing:church_directory(name,city,state)`);
  if (!dispute) return none();
  const place = [dispute.listing?.city, dispute.listing?.state].filter(Boolean).join(', ');
  return {
    to: await owners_(asked),
    title: 'Church claim to check',
    body: `${dispute.full_name} says ${dispute.listing?.name || 'a church'}${place ? ` in ${place}` : ''} is their church.`,
    kind: 'claim',
    data: {}
  };
}

/** Passing the church on: the new leader, from the person who just did it. */
async function handoffPing(sender, asked) {
  if (sender.is_admin || !sender.updated_at || Date.parse(sender.updated_at) < Date.now() - RECENT_MS) return none();
  const leaders = new Set((await rest(`users?org_id=eq.${sender.org_id}&is_admin=eq.true&select=id`)).map((u) => u.id));
  const [church] = await rest(`organizations?id=eq.${sender.org_id}&select=name`);
  return {
    to: asked.filter((id) => leaders.has(id)),
    title: `You're now the leader of ${church?.name || 'your church'}`,
    body: `${firstName(sender.full_name)} passed the church on to you.`,
    kind: 'handoff',
    data: {}
  };
}

/** Someone waiting to join: tells the church's leaders, with the server's own words and nothing else. */
async function askLeaders(email) {
  const asks = await rest(`join_requests?email=eq.${encodeURIComponent(email)}&select=org_id,full_name&limit=1`);
  if (asks.length === 0) return json(200, { sent: 0, failed: 0 });
  const leaders = (await rest(`users?org_id=eq.${asks[0].org_id}&is_admin=eq.true&select=id`)).map((l) => l.id);
  const name = String(asks[0].full_name || 'Someone').slice(0, 60);
  return deliver({ to: leaders, title: 'Someone wants to join', body: `${name} is waiting for you to let them in.`, kind: 'join', data: {} }, 'join');
}

// ── Sending ──────────────────────────────────────────────────────────────────────────────────────

async function deliver(push, kind) {
  const to = [...new Set(push.to || [])];
  if (to.length === 0) return json(200, { sent: 0, failed: 0 });
  const devices = await rest(`device_tokens?user_id=in.(${to.join(',')})&select=apns_token,environment`);
  if (devices.length === 0) return json(200, { sent: 0, failed: 0, note: 'no devices registered' });
  const results = await sendAll(devices, JSON.stringify(buildPayload(push.title, push.body, push.kind, push.data)));
  const removed = await forgetDead(results);
  const sent = results.filter((r) => r.status === 200).length;
  console.log(`send-push: kind=${kind} devices=${devices.length} sent=${sent} removed=${removed}`);
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

function buildPayload(title, body, kind, data) {
  const extra = cleanData(data);
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

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

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
  const rows = await rest(`users?email=eq.${encodeURIComponent(email)}&select=id,org_id,is_admin,full_name,updated_at&limit=1`);
  return rows[0] || null;
}

/** Which of these people are in the sender's church, not counting the sender. */
async function inChurch(sender, ids) {
  const others = ids.filter((id) => id !== sender.id);
  if (others.length === 0) return [];
  return (await rest(`users?id=in.(${others.join(',')})&org_id=eq.${sender.org_id}&select=id`)).map((m) => m.id);
}

/** Which of these people are the app's owner. */
async function owners_(ids) {
  if (ids.length === 0) return [];
  const emails = (await rest('app_owners?select=email')).map((o) => `"${o.email}"`);
  if (emails.length === 0) return [];
  const rows = await rest(`users?id=in.(${ids.join(',')})&email=in.(${encodeURIComponent(emails.join(','))})&select=id`);
  return rows.map((r) => r.id);
}

async function rest(path) {
  const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

/** The church a spot belongs to, from its service or event. */
function spotChurch(slot) {
  return slot.service_date?.org_id || slot.event?.org_id || null;
}

/** "Parking Greeter" and "Sun, Oct 18 at 9:00 AM" for a spot. */
function describe(slot) {
  const job = slot.position?.name || slot.support_position?.name || 'a spot';
  const day = slot.service_date?.service_date || slot.event?.event_date;
  const time = slot.service_date?.service_time || slot.event?.event_time || '';
  const date = day
    ? new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
    : 'an upcoming day';
  return { job, when: time ? `${date} at ${time}` : date };
}

function firstName(full) { return String(full || 'Someone').trim().split(/\s+/)[0] || 'Someone'; }

/** A first name and last initial, never a last name. */
function shortName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  while (parts.length > 2 && /^(jr|sr|ii|iii|iv|v)\.?,?$/i.test(parts[parts.length - 1])) parts.pop();
  if (parts.length === 0) return 'New message';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

function since() { return encodeURIComponent(new Date(Date.now() - RECENT_MS).toISOString()); }

function cleanData(data) {
  const extra = {};
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      if (k === 'aps' || k === 'kind') continue;
      if (typeof v === 'string' && k.length <= 40 && v.length <= 200) extra[k] = v;
    }
  }
  return extra;
}

function none() { return { to: [], title: '', body: '', kind: 'none', data: {} }; }

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
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
