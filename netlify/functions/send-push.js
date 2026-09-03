import http2 from 'node:http2';
import jwt from 'jsonwebtoken';

const SUPA = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const KEY_ID = process.env.APNS_KEY_ID;
const TEAM_ID = process.env.APNS_TEAM_ID;
const BUNDLE_ID = process.env.APNS_BUNDLE_ID;
const KEY_P8 = process.env.APNS_KEY_P8;
const PRODUCTION = process.env.APNS_PRODUCTION === 'true';

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  try {
    const { userIds, title, body, kind } = JSON.parse(event.body || '{}');
    if (!Array.isArray(userIds) || userIds.length === 0) return json(400, { error: 'userIds required' });
    if (!title || !body) return json(400, { error: 'title and body required' });

    const ids = userIds.map(id => `"${id}"`).join(',');
    const env = PRODUCTION ? 'production' : 'sandbox';
    const tokRes = await fetch(`${SUPA}/rest/v1/device_tokens?user_id=in.(${ids})&environment=eq.${env}&select=token`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
    });
    const tokens = (await tokRes.json()).map(r => r.token);
    if (tokens.length === 0) return json(200, { sent: 0, failed: 0 });

    const jwtToken = jwt.sign({}, KEY_P8, {
      algorithm: 'ES256',
      header: { alg: 'ES256', kid: KEY_ID },
      issuer: TEAM_ID,
      expiresIn: '1h'
    });

    const host = PRODUCTION ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
    const payload = JSON.stringify({
      aps: { alert: { title, body }, sound: 'default' },
      kind: kind || 'generic'
    });

    let sent = 0, failed = 0;
    const invalidTokens = [];
    for (const token of tokens) {
      const res = await sendOne(host, token, payload, jwtToken);
      if (res.status === 200) sent++;
      else {
        failed++;
        if (res.status === 410 || res.status === 400) invalidTokens.push(token);
      }
    }

    for (const t of invalidTokens) {
      await fetch(`${SUPA}/rest/v1/device_tokens?token=eq.${encodeURIComponent(t)}`, {
        method: 'DELETE',
        headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Prefer: 'return=minimal' }
      });
    }

    return json(200, { sent, failed });
  } catch (e) {
    return json(500, { error: e.message });
  }
};

function sendOne(host, token, payload, jwtToken) {
  return new Promise((resolve) => {
    const client = http2.connect(`https://${host}`);
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; try { client.close(); } catch {} resolve(result); } };
    client.on('error', (err) => done({ status: 0, error: err.message }));
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      'authorization': `bearer ${jwtToken}`,
      'apns-topic': BUNDLE_ID,
      'apns-priority': '10',
      'apns-push-type': 'alert',
      'content-type': 'application/json'
    });
    let status = 0; let bodyText = '';
    req.on('response', (headers) => { status = headers[':status']; });
    req.on('data', (chunk) => { bodyText += chunk; });
    req.on('end', () => done({ status, body: bodyText }));
    req.on('error', (err) => done({ status: 0, error: err.message }));
    req.setTimeout(10000, () => done({ status: 0, error: 'timeout' }));
    req.write(payload);
    req.end();
  });
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
