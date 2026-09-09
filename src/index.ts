type JsonRecord = Record<string, unknown>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SESSION_COOKIE = "dc_live_session";

function cors(env: Env, request: Request): HeadersInit {
  const origin = request.headers.get("Origin") || "";
  const allowed = origin === env.APP_ORIGIN ? origin : env.APP_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    Vary: "Origin"
  };
}

function json(env: Env, request: Request, body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: { ...cors(env, request), "Cache-Control": "no-store", ...headers }
  });
}

async function bodyJson(request: Request): Promise<JsonRecord> {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > 64 * 1024) throw new Error("Request is too large.");
  const value: unknown = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required.");
  return value as JsonRecord;
}

function stringValue(value: unknown, maximum = 500): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function integerValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

function randomToken(size = 32): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function passwordHash(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: base64UrlToBytes(salt), iterations: 100_000 },
    key,
    256
  );
  return bytesToBase64Url(new Uint8Array(bits));
}

function cookies(request: Request): Map<string, string> {
  const values = new Map<string, string>();
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) values.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return values;
}

type UserRow = { id: string; email: string; role: string; password_hash: string; password_salt: string };
type EventRow = {
  id: string; slug: string; title: string; description: string; status: string; access_type: string;
  price_cents: number; currency: string; rental_hours: number | null; starts_at: number | null;
  stream_room: string; poster_key: string | null; trailer_key: string | null; created_at: number; updated_at: number;
};

async function currentUser(request: Request, env: Env): Promise<UserRow | null> {
  const token = cookies(request).get(SESSION_COOKIE);
  if (!token) return null;
  return env.DB.prepare(
    `SELECT u.id, u.email, u.role, u.password_hash, u.password_salt
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? LIMIT 1`
  ).bind(await sha256(token), Date.now()).first<UserRow>();
}

async function requireUser(request: Request, env: Env): Promise<UserRow> {
  const user = await currentUser(request, env);
  if (!user) throw new Response("Viewer login required.", { status: 401 });
  return user;
}

async function requireAdmin(request: Request, env: Env): Promise<void> {
  const provided = request.headers.get("X-Admin-Key") || "";
  if (!env.ADMIN_API_KEY || !(await secureEqual(provided, env.ADMIN_API_KEY))) {
    throw new Response("Administrative access required.", { status: 403 });
  }
}

function publicEvent(row: EventRow): JsonRecord {
  return {
    id: row.id, slug: row.slug, title: row.title, description: row.description,
    status: row.status, accessType: row.access_type, priceCents: row.price_cents,
    currency: row.currency, rentalHours: row.rental_hours, startsAt: row.starts_at,
    posterUrl: row.poster_key ? `/assets/${encodeURIComponent(row.poster_key)}` : null,
    trailerUrl: row.trailer_key ? `/assets/${encodeURIComponent(row.trailer_key)}` : null
  };
}

async function register(request: Request, env: Env): Promise<Response> {
  const body = await bodyJson(request);
  const email = stringValue(body.email, 254).toLowerCase();
  const password = stringValue(body.password, 200);
  if (!/^\S+@\S+\.\S+$/.test(email)) return json(env, request, { error: "Valid email required." }, 400);
  if (password.length < 10) return json(env, request, { error: "Password must contain at least 10 characters." }, 400);
  const id = crypto.randomUUID();
  const salt = randomToken(18);
  try {
    await env.DB.prepare(
      "INSERT INTO users (id,email,password_hash,password_salt,created_at) VALUES (?,?,?,?,?)"
    ).bind(id, email, await passwordHash(password, salt), salt, Date.now()).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UNIQUE constraint failed")) {
      return json(env, request, { error: "An account already exists for that email." }, 409);
    }
    console.error(JSON.stringify({ message: "viewer registration failed", error: message }));
    return json(env, request, { error: "Viewer registration could not be completed." }, 500);
  }
  return createSession(request, env, { id, email, role: "viewer" });
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await bodyJson(request);
  const email = stringValue(body.email, 254).toLowerCase();
  const password = stringValue(body.password, 200);
  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ? LIMIT 1").bind(email).first<UserRow>();
  const fallbackSalt = randomToken(18);
  const candidate = await passwordHash(password || "invalid-password", user?.password_salt || fallbackSalt);
  if (!user || !(await secureEqual(candidate, user.password_hash))) {
    return json(env, request, { error: "Email or password is incorrect." }, 401);
  }
  return createSession(request, env, user);
}

async function createSession(request: Request, env: Env, user: Pick<UserRow, "id" | "email" | "role">): Promise<Response> {
  const token = randomToken();
  const hours = Math.max(1, Number(env.SESSION_HOURS || 720));
  const expires = Date.now() + hours * 60 * 60 * 1000;
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)"
  ).bind(await sha256(token), user.id, expires, Date.now()).run();
  return json(env, request, { ok: true, user: { id: user.id, email: user.email, role: user.role } }, 200, {
    "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${hours * 3600}`
  });
}

async function logout(request: Request, env: Env): Promise<Response> {
  const token = cookies(request).get(SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return json(env, request, { ok: true }, 200, {
    "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  });
}

async function saveEvent(request: Request, env: Env, existingId?: string): Promise<Response> {
  await requireAdmin(request, env);
  const body = await bodyJson(request);
  const slug = stringValue(body.slug, 80).toLowerCase();
  const title = stringValue(body.title, 160);
  const streamRoom = stringValue(body.streamRoom, 80);
  if (!/^[a-z0-9-]{2,80}$/.test(slug) || !title || !/^[A-Za-z0-9_-]{1,80}$/.test(streamRoom)) {
    return json(env, request, { error: "Valid slug, title, and streamRoom are required." }, 400);
  }
  const status = stringValue(body.status, 20) || "draft";
  const accessType = stringValue(body.accessType, 20) || "free";
  if (!["draft", "scheduled", "live", "ended"].includes(status) || !["free", "paid"].includes(accessType)) {
    return json(env, request, { error: "Invalid event status or access type." }, 400);
  }
  const id = existingId || crypto.randomUUID();
  const now = Date.now();
  const values = [
    id, slug, title, stringValue(body.description, 5000), status, accessType,
    Math.max(0, integerValue(body.priceCents)), stringValue(body.currency, 3).toLowerCase() || "usd",
    body.rentalHours == null ? null : Math.max(1, integerValue(body.rentalHours, 48)),
    body.startsAt == null ? null : integerValue(body.startsAt), streamRoom,
    stringValue(body.posterKey, 500) || null, stringValue(body.trailerKey, 500) || null, now, now
  ];
  await env.DB.prepare(
    `INSERT INTO events (id,slug,title,description,status,access_type,price_cents,currency,rental_hours,starts_at,stream_room,poster_key,trailer_key,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET slug=excluded.slug,title=excluded.title,description=excluded.description,status=excluded.status,
       access_type=excluded.access_type,price_cents=excluded.price_cents,currency=excluded.currency,rental_hours=excluded.rental_hours,
       starts_at=excluded.starts_at,stream_room=excluded.stream_room,poster_key=excluded.poster_key,trailer_key=excluded.trailer_key,updated_at=excluded.updated_at`
  ).bind(...values).run();
  const event = await env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(id).first<EventRow>();
  return json(env, request, { ok: true, event: event ? publicEvent(event) : null }, existingId ? 200 : 201);
}

async function hasAccess(env: Env, userId: string | null, event: EventRow): Promise<boolean> {
  if (event.access_type === "free") return true;
  if (!userId) return false;
  const row = await env.DB.prepare(
    `SELECT id FROM entitlements WHERE user_id=? AND event_id=? AND revoked_at IS NULL
     AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`
  ).bind(userId, event.id, Date.now()).first<{ id: string }>();
  return Boolean(row);
}

async function checkout(request: Request, env: Env, event: EventRow): Promise<Response> {
  const user = await requireUser(request, env);
  if (event.access_type === "free") return json(env, request, { error: "This event is free." }, 400);
  if (!env.STRIPE_SECRET_KEY) return json(env, request, { error: "Stripe test payments are not connected yet." }, 503);
  const purchaseId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO purchases (id,user_id,event_id,amount_cents,currency,status,created_at) VALUES (?,?,?,?,?,'pending',?)"
  ).bind(purchaseId, user.id, event.id, event.price_cents, event.currency, Date.now()).run();

  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", `${env.APP_ORIGIN}/events/${event.slug}?payment=success`);
  form.set("cancel_url", `${env.APP_ORIGIN}/events/${event.slug}?payment=cancelled`);
  form.set("customer_email", user.email);
  form.set("client_reference_id", purchaseId);
  form.set("line_items[0][price_data][currency]", event.currency);
  form.set("line_items[0][price_data][unit_amount]", String(event.price_cents));
  form.set("line_items[0][price_data][product_data][name]", event.title);
  form.set("line_items[0][quantity]", "1");
  form.set("metadata[purchase_id]", purchaseId);
  form.set("metadata[event_id]", event.id);
  form.set("metadata[user_id]", user.id);

  const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form
  });
  const session: unknown = await stripeResponse.json();
  if (!stripeResponse.ok || !session || typeof session !== "object") {
    await env.DB.prepare("UPDATE purchases SET status='failed' WHERE id=?").bind(purchaseId).run();
    return json(env, request, { error: "Stripe could not create checkout." }, 502);
  }
  const stripeId = "id" in session ? stringValue(session.id, 200) : "";
  const checkoutUrl = "url" in session ? stringValue(session.url, 2000) : "";
  if (!stripeId || !checkoutUrl) return json(env, request, { error: "Stripe returned an incomplete checkout." }, 502);
  await env.DB.prepare("UPDATE purchases SET stripe_checkout_session_id=? WHERE id=?").bind(stripeId, purchaseId).run();
  return json(env, request, { ok: true, purchaseId, checkoutUrl }, 201);
}

async function stripeWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) return json(env, request, { error: "Webhook secret is not configured." }, 503);
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > 1024 * 1024) return json(env, request, { error: "Webhook is too large." }, 413);
  const raw = await request.text();
  if (raw.length > 1024 * 1024) return json(env, request, { error: "Webhook is too large." }, 413);
  const header = request.headers.get("Stripe-Signature") || "";
  const parts = Object.fromEntries(header.split(",").map(item => item.split("=", 2) as [string, string]));
  const timestamp = Number(parts.t || 0);
  const expected = await hmacHex(env.STRIPE_WEBHOOK_SECRET, `${timestamp}.${raw}`);
  const received = parts.v1 || "";
  if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > 300 || !(await secureEqual(received, expected))) {
    return json(env, request, { error: "Invalid Stripe signature." }, 400);
  }
  const payload: unknown = JSON.parse(raw);
  if (!payload || typeof payload !== "object" || !("id" in payload) || !("type" in payload)) {
    return json(env, request, { error: "Invalid Stripe event." }, 400);
  }
  const eventId = stringValue(payload.id, 200);
  const eventType = stringValue(payload.type, 200);
  const exists = await env.DB.prepare("SELECT id FROM stripe_events WHERE id=?").bind(eventId).first<{ id: string }>();
  if (exists) return json(env, request, { received: true, duplicate: true });

  if (eventType === "checkout.session.completed" && "data" in payload && payload.data && typeof payload.data === "object") {
    const data = payload.data as JsonRecord;
    const object = data.object && typeof data.object === "object" ? data.object as JsonRecord : {};
    const metadata = object.metadata && typeof object.metadata === "object" ? object.metadata as JsonRecord : {};
    const purchaseId = stringValue(metadata.purchase_id, 100);
    const userId = stringValue(metadata.user_id, 100);
    const dcEventId = stringValue(metadata.event_id, 100);
    const paymentStatus = stringValue(object.payment_status, 40);
    if (purchaseId && userId && dcEventId && paymentStatus === "paid") {
      const dcEvent = await env.DB.prepare("SELECT * FROM events WHERE id=?").bind(dcEventId).first<EventRow>();
      if (dcEvent) {
        const paidAt = Date.now();
        const expiresAt = dcEvent.rental_hours ? paidAt + dcEvent.rental_hours * 60 * 60 * 1000 : null;
        await env.DB.batch([
          env.DB.prepare("UPDATE purchases SET status='paid',paid_at=?,stripe_payment_intent_id=? WHERE id=?")
            .bind(paidAt, stringValue(object.payment_intent, 200) || null, purchaseId),
          env.DB.prepare(
            `INSERT INTO entitlements (id,user_id,event_id,purchase_id,starts_at,expires_at,created_at) VALUES (?,?,?,?,?,?,?)
             ON CONFLICT(user_id,event_id) DO UPDATE SET purchase_id=excluded.purchase_id,starts_at=excluded.starts_at,
             expires_at=excluded.expires_at,revoked_at=NULL`
          ).bind(crypto.randomUUID(), userId, dcEventId, purchaseId, paidAt, expiresAt, paidAt),
          env.DB.prepare("INSERT INTO stripe_events (id,event_type,processed_at) VALUES (?,?,?)")
            .bind(eventId, eventType, paidAt)
        ]);
        return json(env, request, { received: true });
      }
    }
  }
  if (eventType === "checkout.session.expired" && "data" in payload && payload.data && typeof payload.data === "object") {
    const data = payload.data as JsonRecord;
    const object = data.object && typeof data.object === "object" ? data.object as JsonRecord : {};
    const metadata = object.metadata && typeof object.metadata === "object" ? object.metadata as JsonRecord : {};
    const purchaseId = stringValue(metadata.purchase_id, 100);
    if (purchaseId) {
      await env.DB.prepare("UPDATE purchases SET status='failed' WHERE id=? AND status='pending'").bind(purchaseId).run();
    }
  }
  if ((eventType === "charge.refunded" || eventType === "charge.dispute.created") &&
      "data" in payload && payload.data && typeof payload.data === "object") {
    const data = payload.data as JsonRecord;
    const object = data.object && typeof data.object === "object" ? data.object as JsonRecord : {};
    const paymentIntent = stringValue(object.payment_intent, 200);
    if (paymentIntent) {
      const purchase = await env.DB.prepare(
        "SELECT id FROM purchases WHERE stripe_payment_intent_id=? LIMIT 1"
      ).bind(paymentIntent).first<{ id: string }>();
      if (purchase) {
        const now = Date.now();
        await env.DB.batch([
          env.DB.prepare("UPDATE purchases SET status='refunded' WHERE id=?").bind(purchase.id),
          env.DB.prepare("UPDATE entitlements SET revoked_at=? WHERE purchase_id=?").bind(now, purchase.id)
        ]);
      }
    }
  }
  await env.DB.prepare("INSERT INTO stripe_events (id,event_type,processed_at) VALUES (?,?,?)")
    .bind(eventId, eventType, Date.now()).run();
  return json(env, request, { received: true });
}

async function playback(request: Request, env: Env, event: EventRow): Promise<Response> {
  const user = await currentUser(request, env);
  if (!(await hasAccess(env, user?.id || null, event))) return json(env, request, { error: "Purchase or rental required." }, 402);
  if (!env.PLAYBACK_SIGNING_KEY) return json(env, request, { error: "Playback signing is not configured." }, 503);
  const expires = Date.now() + Math.max(5, Number(env.PLAYBACK_TOKEN_MINUTES || 240)) * 60 * 1000;
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify({ eventId: event.id, expires })));
  const signature = await hmac(env.PLAYBACK_SIGNING_KEY, payload);
  return json(env, request, {
    ok: true,
    expiresAt: expires,
    playbackUrl: `/media/${encodeURIComponent(event.slug)}/index.m3u8?token=${payload}.${signature}`
  });
}

async function verifyPlaybackToken(env: Env, token: string, eventId: string): Promise<boolean> {
  const [payload, signature] = token.split(".", 2);
  if (!payload || !signature || !env.PLAYBACK_SIGNING_KEY) return false;
  if (!(await secureEqual(signature, await hmac(env.PLAYBACK_SIGNING_KEY, payload)))) return false;
  try {
    const value: unknown = JSON.parse(decoder.decode(base64UrlToBytes(payload)));
    return Boolean(value && typeof value === "object" && "eventId" in value && "expires" in value &&
      value.eventId === eventId && Number(value.expires) > Date.now());
  } catch {
    return false;
  }
}

async function proxyMedia(request: Request, env: Env, event: EventRow, asset: string, token: string): Promise<Response> {
  if (!(await verifyPlaybackToken(env, token, event.id))) return new Response("Playback authorization required.", { status: 401 });
  if (!/^[A-Za-z0-9_.-]+$/.test(asset)) return new Response("Invalid media path.", { status: 400 });
  const origin = env.MEDIA_ORIGIN.replace(/\/+$/, "");
  const upstream = await fetch(`${origin}/hls/live/${encodeURIComponent(event.stream_room)}/${asset}`);
  if (!upstream.ok || !upstream.body) return new Response("Live program is not available.", { status: upstream.status });
  const headers = new Headers(upstream.headers);
  headers.set("Cache-Control", asset.endsWith(".m3u8") ? "no-store" : "private, max-age=6");
  if (asset.endsWith(".m3u8")) {
    const playlist = await upstream.text();
    const rewritten = playlist.split("\n").map(line =>
      line && !line.startsWith("#") ? `${line}?token=${encodeURIComponent(token)}` : line
    ).join("\n");
    return new Response(rewritten, { status: 200, headers });
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function router(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env, request) });
  if (url.pathname === "/health") return json(env, request, {
    ok: true, service: "DC Live API", database: true, media: true,
    stripeConfigured: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET)
  });
  if (url.pathname === "/api/auth/register" && request.method === "POST") return register(request, env);
  if (url.pathname === "/api/auth/login" && request.method === "POST") return login(request, env);
  if (url.pathname === "/api/auth/logout" && request.method === "POST") return logout(request, env);
  if (url.pathname === "/api/auth/me" && request.method === "GET") {
    const user = await currentUser(request, env);
    return json(env, request, { user: user ? { id: user.id, email: user.email, role: user.role } : null });
  }
  if (url.pathname === "/api/library" && request.method === "GET") {
    const user = await requireUser(request, env);
    const rows = await env.DB.prepare(
      `SELECT e.* FROM entitlements x JOIN events e ON e.id=x.event_id
       WHERE x.user_id=? AND x.revoked_at IS NULL AND (x.expires_at IS NULL OR x.expires_at>?)
       ORDER BY x.created_at DESC`
    ).bind(user.id, Date.now()).all<EventRow>();
    return json(env, request, { events: rows.results.map(publicEvent) });
  }
  if (url.pathname === "/api/events" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT * FROM events WHERE status!='draft' ORDER BY starts_at DESC").all<EventRow>();
    return json(env, request, { events: rows.results.map(publicEvent) });
  }
  if (url.pathname === "/api/admin/events" && request.method === "POST") return saveEvent(request, env);
  const adminEvent = url.pathname.match(/^\/api\/admin\/events\/([0-9a-f-]+)$/);
  if (adminEvent && request.method === "PATCH") return saveEvent(request, env, adminEvent[1]);
  const eventMatch = url.pathname.match(/^\/api\/events\/([a-z0-9-]+)(?:\/(checkout|playback))?$/);
  if (eventMatch) {
    const event = await env.DB.prepare("SELECT * FROM events WHERE slug=? LIMIT 1").bind(eventMatch[1]).first<EventRow>();
    if (!event || (event.status === "draft" && !eventMatch[2])) return json(env, request, { error: "Event not found." }, 404);
    if (!eventMatch[2] && request.method === "GET") return json(env, request, { event: publicEvent(event) });
    if (eventMatch[2] === "checkout" && request.method === "POST") return checkout(request, env, event);
    if (eventMatch[2] === "playback" && request.method === "POST") return playback(request, env, event);
  }
  if (url.pathname === "/api/webhooks/stripe" && request.method === "POST") return stripeWebhook(request, env);
  const mediaMatch = url.pathname.match(/^\/media\/([a-z0-9-]+)\/([A-Za-z0-9_.-]+)$/);
  if (mediaMatch && request.method === "GET") {
    const event = await env.DB.prepare("SELECT * FROM events WHERE slug=? LIMIT 1").bind(mediaMatch[1]).first<EventRow>();
    if (!event) return new Response("Event not found.", { status: 404 });
    return proxyMedia(request, env, event, mediaMatch[2], url.searchParams.get("token") || "");
  }
  const assetMatch = url.pathname.match(/^\/assets\/(.+)$/);
  if (assetMatch && request.method === "GET") {
    const object = await env.MEDIA.get(decodeURIComponent(assetMatch[1]));
    if (!object) return new Response("Asset not found.", { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    headers.set("Cache-Control", "public, max-age=3600");
    return new Response(object.body, { headers });
  }
  const adminAsset = url.pathname.match(/^\/api\/admin\/assets\/(.+)$/);
  if (adminAsset && request.method === "PUT") {
    await requireAdmin(request, env);
    if (!request.body) return json(env, request, { error: "Asset body required." }, 400);
    const key = decodeURIComponent(adminAsset[1]);
    if (!/^[A-Za-z0-9/_-]+\.(jpg|jpeg|png|webp|mp4)$/i.test(key)) return json(env, request, { error: "Invalid asset key." }, 400);
    await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: request.headers.get("Content-Type") || "application/octet-stream" } });
    return json(env, request, { ok: true, key, url: `/assets/${encodeURIComponent(key)}` }, 201);
  }
  return json(env, request, { error: "Not found." }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await router(request, env);
    } catch (error) {
      if (error instanceof Response) return json(env, request, { error: await error.text() }, error.status);
      console.error(JSON.stringify({ message: "request failed", error: error instanceof Error ? error.message : String(error), path: new URL(request.url).pathname }));
      return json(env, request, { error: "Internal server error." }, 500);
    }
  }
} satisfies ExportedHandler<Env>;
