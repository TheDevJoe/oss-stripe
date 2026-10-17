// Created by Joseph Foss on 10/17/26
// Our Sunday Schedule — ends someone's Sign in with Apple when they delete their account, as Apple requires.
// The app asks Apple for a one-time code right before deleting, then sends it here. The code only works for the
// person who just confirmed with Face ID or their passcode, so nothing else is needed to trust it.
// Netlify settings it uses: APNS_TEAM_ID (already set), SIWA_KEY_ID and SIWA_KEY_P8 (the Sign in with Apple key).
import jwt from 'jsonwebtoken';

const TEAM_ID = process.env.APNS_TEAM_ID;
const KEY_ID = process.env.SIWA_KEY_ID;
const KEY_P8 = (process.env.SIWA_KEY_P8 || '').replace(/\\n/g, '\n');
/** The app's own ID with Apple. */
const BUNDLE_ID = 'com.josephfoss.Our-Sunday-Schedule';
const APPLE = 'https://appleid.apple.com';

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    if (!TEAM_ID || !KEY_ID || !KEY_P8) return json(500, { error: 'Sign in with Apple key is not set up on Netlify' });
    const { code } = JSON.parse(event.body || '{}');
    if (!code || typeof code !== 'string' || code.length > 1000) return json(400, { error: 'code required' });

    const secret = clientSecret();
    // Trade the one-time code for this person's tokens…
    const tokenRes = await fetch(`${APPLE}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: BUNDLE_ID, client_secret: secret, code, grant_type: 'authorization_code' })
    });
    const tokens = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !(tokens.refresh_token || tokens.access_token)) {
      console.error('apple-revoke: token exchange failed', tokenRes.status, tokens.error);
      return json(400, { error: tokens.error || 'Apple turned the code down' });
    }

    // …then end them.
    const useRefresh = Boolean(tokens.refresh_token);
    const revokeRes = await fetch(`${APPLE}/auth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: BUNDLE_ID,
        client_secret: secret,
        token: useRefresh ? tokens.refresh_token : tokens.access_token,
        token_type_hint: useRefresh ? 'refresh_token' : 'access_token'
      })
    });
    if (!revokeRes.ok) {
      console.error('apple-revoke: revoke failed', revokeRes.status, await revokeRes.text());
      return json(400, { error: 'Apple did not end the sign-in' });
    }
    console.log('apple-revoke: done');
    return json(200, { ok: true });
  } catch (e) {
    console.error('apple-revoke error:', e);
    return json(500, { error: e.message });
  }
};

/** Apple's "client secret": a short-lived token signed with the Sign in with Apple key. */
function clientSecret() {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: TEAM_ID, iat: now, exp: now + 300, aud: APPLE, sub: BUNDLE_ID },
    KEY_P8,
    { algorithm: 'ES256', header: { alg: 'ES256', kid: KEY_ID } }
  );
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
// ;-)
