import apn from 'apn';

const SUPA = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const provider = new apn.Provider({
  token: {
    key: process.env.APNS_KEY_P8,
    keyId: process.env.APNS_KEY_ID,
    teamId: process.env.APNS_TEAM_ID
  },
  production: process.env.APNS_PRODUCTION === 'true'
});

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  try {
    const { userIds, title, body, kind } = JSON.parse(event.body || '{}');
    if (!Array.isArray(userIds) || userIds.length === 0) return json(400, { error: 'userIds required' });
    if (!title || !body) return json(400, { error: 'title and body required' });

    const ids = userIds.map(id => `"${id}"`).join(',');
    const env = process.env.APNS_PRODUCTION === 'true' ? 'production' : 'sandbox';
    const tokRes = await fetch(`${SUPA}/rest/v1/device_tokens?user_id=in.(${ids})&environment=eq.${env}&select=token`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
    });
    const tokens = (await tokRes.json()).map(r => r.token);
    if (tokens.length === 0) return json(200, { sent: 0, failed: 0 });

    const note = new apn.Notification();
    note.expiry = Math.floor(Date.now() / 1000) + 3600;
    note.sound = 'default';
    note.alert = { title, body };
    note.topic = process.env.APNS_BUNDLE_ID;
    note.payload = { kind: kind || 'generic' };
    if (kind === 'sos') note.sound = 'default';

    const result = await provider.send(note, tokens);

    for (const failed of result.failed || []) {
      const reason = failed.response?.reason;
      if (failed.status === '410' || reason === 'BadDeviceToken' || reason === 'Unregistered') {
        await fetch(`${SUPA}/rest/v1/device_tokens?token=eq.${encodeURIComponent(failed.device)}`, {
          method: 'DELETE',
          headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Prefer: 'return=minimal' }
        });
      }
    }

    return json(200, { sent: result.sent.length, failed: result.failed.length });
  } catch (e) {
    return json(500, { error: e.message });
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
