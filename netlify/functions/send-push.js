// Created by Joseph Foss on 10/16/26
// Our Sunday Schedule — send-reminders. Supabase runs it every 15 minutes: a "Can you still serve?" reminder 48 hours
// before each spot, with I'll be there and Can't make it right on it, and "Serving in 2 hours" before it starts, which
// also starts the serving-day Live Activity on the Lock Screen with its I'm here button. Each reminder goes to every
// phone the person is signed in on. It's claimed in the database before it's sent, so nobody ever gets the same one
// twice, and Apple's answer is saved with it. Phones Apple says are gone are forgotten.
// Secrets it uses (already set): APNS_TEAM_ID, APNS_KEY_ID and APNS_PRIVATE_KEY. Supabase provides SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY. Deploy with Verify JWT off, the way it is now, since the schedule calls it without one.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TEAM_ID = Deno.env.get("APNS_TEAM_ID") ?? "";
const KEY_ID = Deno.env.get("APNS_KEY_ID") ?? "";
const PRIVATE_KEY = (Deno.env.get("APNS_PRIVATE_KEY") ?? Deno.env.get("APNS_KEY_P8") ?? "").replace(/\\n/g, "\n");
/** The app's own ID with Apple, from the Xcode project. Apple refuses a reminder sent under any other. */
const BUNDLE_ID = "com.josephfoss.Our-Sunday-Schedule";
/** The Live Activity's name in the app (ServingDay.swift). Apple starts nothing if it doesn't match. */
const LIVE_ACTIVITY = "ServingDay";
/** Only for trying this out somewhere other than Apple; never set in Supabase. */
const APNS_ORIGIN = Deno.env.get("APNS_ORIGIN");

type Kind = "reminder_48h" | "reminder_2h";

interface Phone {
  token: string;
  environment: string;
}

/** One person's spot that's due, with every phone they're signed in on. */
interface Due {
  slot_id: string;
  user_id: string;
  church: string | null;
  service_date: string;
  service_time: string;
  position_name: string;
  campus_name: string | null;
  starts_at: string;
  phones: Phone[] | null;
  live_phones: Phone[] | null;
}

interface Tally {
  kind: Kind;
  due: number;
  sent: number;
  failed: number;
  skipped: number;
  started: number;
  problem?: string;
  live_problem?: string;
}

interface Answer {
  status: number;
  reason?: string;
  appleId?: string;
}

interface Push {
  headers: Record<string, string>;
  body: string;
}

/** One request to the database, with the service key on it, tried again if it's turned away or fails. */
async function database(path: string, init: RequestInit = {}): Promise<Response> {
  let last: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((done) => setTimeout(done, 500 * attempt));
    try {
      last = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...init,
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
      if (last.status !== 401 && last.status < 500) return last;
    } catch (_) {
      // A dropped connection gets another try.
    }
  }
  return last ?? new Response("no answer from the database", { status: 503 });
}

// ── Signing in to Apple ───────────────────────────────────────────────────────────────────────

let signingKey: CryptoKey | null = null;
let token: { value: string; madeAt: number } | null = null;

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function appleToken(): Promise<string> {
  // Apple wants a new one at most every 20 minutes and at least every hour.
  if (token && Date.now() - token.madeAt < 40 * 60 * 1000) return token.value;
  if (!signingKey) {
    const body = PRIVATE_KEY.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
    signingKey = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  }
  const now = Math.floor(Date.now() / 1000);
  const words = new TextEncoder();
  const head = base64url(words.encode(JSON.stringify({ alg: "ES256", kid: KEY_ID })));
  const claims = base64url(words.encode(JSON.stringify({ iss: TEAM_ID, iat: now })));
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, words.encode(`${head}.${claims}`));
  token = { value: `${head}.${claims}.${base64url(new Uint8Array(signature))}`, madeAt: Date.now() };
  return token.value;
}

// ── What gets sent ────────────────────────────────────────────────────────────────────────────

/** "Sunday at 10:00 AM", from "2026-10-18" and "10:00 AM". */
function when(date: string, time: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return `${weekday} at ${time}`;
}

/** "Greeter · Sunday at 10:00 AM · North" */
function line(row: Due): string {
  return `${row.position_name} · ${when(row.service_date, row.service_time)}${row.campus_name ? ` · ${row.campus_name}` : ""}`;
}

function startsAt(row: Due): number {
  return Math.floor(Date.parse(row.starts_at) / 1000);
}

/** The notification. Apple drops it if the phone can't get it in time, so nobody gets it after it matters. */
function reminder(row: Due, kind: Kind): Push {
  const soon = kind === "reminder_2h";
  return {
    headers: {
      "apns-topic": BUNDLE_ID,
      "apns-push-type": "alert",
      "apns-priority": soon ? "10" : "5",
      "apns-expiration": String(soon ? startsAt(row) : startsAt(row) - 2 * 3600),
    },
    body: JSON.stringify({
      aps: {
        alert: { title: soon ? "Serving in 2 hours" : "Can you still serve?", body: line(row) },
        sound: "default",
        "thread-id": row.slot_id,
        // The 48-hour reminder carries I'll be there and Can't make it.
        ...(soon ? {} : { category: "SERVE_CONFIRM" }),
      },
      slot_id: row.slot_id,
      kind,
    }),
  };
}

/** Starts the Live Activity. It lights up quietly, since the notification already makes the sound. */
function liveActivity(row: Due): Push {
  const start = startsAt(row);
  return {
    headers: {
      "apns-topic": `${BUNDLE_ID}.push-type.liveactivity`,
      "apns-push-type": "liveactivity",
      "apns-priority": "10",
      "apns-expiration": String(start),
    },
    body: JSON.stringify({
      aps: {
        timestamp: Math.floor(Date.now() / 1000),
        event: "start",
        "attributes-type": LIVE_ACTIVITY,
        attributes: {
          slotId: row.slot_id,
          church: row.church ?? "",
          position: row.position_name,
          campus: row.campus_name,
          time: row.service_time,
          startsAt: start,
        },
        "content-state": { checkedIn: false },
        "stale-date": start + 3 * 3600,
        alert: { title: "Serving in 2 hours", body: line(row) },
      },
    }),
  };
}

async function send(phone: Phone, push: Push): Promise<Answer> {
  const origin = APNS_ORIGIN ??
    (phone.environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com");
  try {
    const res = await fetch(`${origin}/3/device/${phone.token}`, {
      method: "POST",
      headers: { authorization: `bearer ${await appleToken()}`, "content-type": "application/json", ...push.headers },
      body: push.body,
    });
    const appleId = res.headers.get("apns-id") ?? undefined;
    const text = await res.text();
    if (res.ok) return { status: res.status, appleId };
    return { status: res.status, reason: `${res.status} ${text}`, appleId };
  } catch (e) {
    return { status: 0, reason: String(e) };
  }
}

/** Only these two answers mean the phone's token itself is gone. */
function gone(answer: Answer): boolean {
  return answer.status === 410 || (answer.status === 400 && /BadDeviceToken/.test(answer.reason ?? ""));
}

async function forget(table: "device_tokens" | "live_tokens", column: string, phones: Phone[], answers: Answer[]) {
  for (let i = 0; i < phones.length; i++) {
    if (!gone(answers[i])) continue;
    await database(`${table}?${column}=eq.${encodeURIComponent(phones[i].token)}`, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    });
  }
}

/** Claims a reminder by saving it first; if it's already saved, someone else has it. */
async function claim(row: Due, kind: Kind): Promise<string | null> {
  const res = await database("notifications", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ user_id: row.user_id, slot_id: row.slot_id, notification_type: kind }),
  });
  if (res.status !== 201) {
    await res.body?.cancel();
    return null;
  }
  const rows = await res.json();
  return rows?.[0]?.id ?? null;
}

async function remind(kind: Kind): Promise<Tally> {
  const tally: Tally = { kind, due: 0, sent: 0, failed: 0, skipped: 0, started: 0 };
  const res = await database("rpc/reminders_due", { method: "POST", body: JSON.stringify({ p_kind: kind }) });
  if (!res.ok) {
    tally.problem = `couldn't read what's due: ${res.status} ${(await res.text()).slice(0, 200)}`;
    return tally;
  }
  const due = (await res.json()) as Due[];
  tally.due = due.length;
  for (const row of due) {
    const id = await claim(row, kind);
    if (!id) { tally.skipped++; continue; }

    const phones = row.phones ?? [];
    const note = reminder(row, kind);
    const answers = await Promise.all(phones.map((phone) => send(phone, note)));
    const livePhones = kind === "reminder_2h" ? row.live_phones ?? [] : [];
    const start = liveActivity(row);
    const liveAnswers = await Promise.all(livePhones.map((phone) => send(phone, start)));

    const all = [...answers, ...liveAnswers];
    const delivered = all.some((a) => a.status === 200);
    const trouble = all.find((a) => a.status !== 200)?.reason ?? null;
    await database(`notifications?id=eq.${id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ delivered, error: trouble, apns_message_id: all.find((a) => a.status === 200)?.appleId ?? null }),
    });
    await forget("device_tokens", "apns_token", phones, answers);
    await forget("live_tokens", "token", livePhones, liveAnswers);

    if (delivered) {
      tally.sent++;
    } else {
      tally.failed++;
      tally.problem ??= trouble ?? undefined;
    }
    tally.started += liveAnswers.filter((a) => a.status === 200).length;
    tally.live_problem ??= liveAnswers.find((a) => a.status !== 200)?.reason;
  }
  return tally;
}

Deno.serve(async () => {
  const missing = [["SUPABASE_URL", SUPABASE_URL], ["SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY], ["APNS_TEAM_ID", TEAM_ID],
    ["APNS_KEY_ID", KEY_ID], ["APNS_PRIVATE_KEY", PRIVATE_KEY]].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    return Response.json({ ok: false, error: `missing secrets: ${missing.join(", ")}` }, { status: 500 });
  }
  try {
    // One kind at a time.
    const results = [await remind("reminder_48h"), await remind("reminder_2h")];
    return Response.json({ ok: results.every((r) => !r.problem && !r.live_problem), results, at: new Date().toISOString() });
  } catch (e) {
    console.error("send-reminders:", e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
// ;-)
