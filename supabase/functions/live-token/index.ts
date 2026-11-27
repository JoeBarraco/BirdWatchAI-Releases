// live-token — hands out tokens for the BirdWatch live relay (community live view).
//
// The relay (live.birdwatchai.com, code in birdwatchai-server/tools/BirdWatch.LiveRelay) only
// trusts tokens signed with RELAY_SECRET. This function is the one place that holds that secret,
// and it decides who gets a token using rules the community already has:
//
//   POST { device_key, write_token }   — a FEEDER asking to publish.
//        Proof of ownership is the feeder's write token (feeder_write_tokens), the same secret
//        that guards its detection writes. Legacy feeders without a claimed token get nothing:
//        live video is not something to hand out on a public device key alone.
//        → { key, expires_at }  a publish key valid for 24 h; the feeder fetches a fresh one
//          every time it connects, so rotating the write token revokes live view too.
//
//   GET ?feeder=<device_key>           — a VIEWER asking to watch.
//        Answered by asking PostgREST, AS THE CALLER (their JWT, or the anon key), whether they
//        can see that feeder's row. The feeders SELECT policy already hides private feeders from
//        non-members, so "can see the row" is exactly "may watch it live".
//        → { token, expires_at }  a viewer token valid for 5 min (only needs to open the socket).
//
// Token format — must match LiveRelayToken.cs on the relay:
//   "<exp>.<base64url(HMAC-SHA256(RELAY_SECRET, '<role>:<device_key>:<exp>'))>"
//
// Deploy with verify_jwt = false: the site calls functions with the publishable key as Bearer
// (not a JWT), and feeders call with no user at all. Authorization is done in here.
//
//   Secret: RELAY_SECRET — the same value as RELAY_SECRET in the relay's .env.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RELAY_SECRET = Deno.env.get("RELAY_SECRET") ?? "";

const PUBLISH_TTL_SECONDS = 24 * 3600;
const VIEW_TTL_SECONDS = 300;
const FEEDER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function mint(role: "pub" | "view", feederId: string, ttlSeconds: number) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(RELAY_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(`${role}:${feederId}:${exp}`)));
  const b64url = btoa(String.fromCharCode(...sig))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { token: `${exp}.${b64url}`, expires_at: new Date(exp * 1000).toISOString() };
}

// Constant-time string compare, so the write-token check can't be timed.
function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function serviceSelect(path: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
  });
  if (!res.ok) throw new Error(`lookup failed: ${res.status}`);
  return await res.json();
}

async function handlePublish(req: Request): Promise<Response> {
  let body: { device_key?: string; write_token?: string };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const deviceKey = (body.device_key ?? "").trim();
  const writeToken = (body.write_token ?? "").trim();
  if (!FEEDER_ID_RE.test(deviceKey) || !writeToken) return json({ error: "device_key and write_token required" }, 400);

  const feeders = await serviceSelect(`feeders?select=id&device_key=eq.${encodeURIComponent(deviceKey)}&limit=1`);
  if (!feeders.length) return json({ error: "unknown feeder" }, 403);
  const tokens = await serviceSelect(`feeder_write_tokens?select=token&feeder_id=eq.${encodeURIComponent(feeders[0].id)}&limit=1`);
  if (!tokens.length || !safeEqual(tokens[0].token, writeToken)) return json({ error: "not authorized" }, 403);

  const { token, expires_at } = await mint("pub", deviceKey, PUBLISH_TTL_SECONDS);
  return json({ key: token, expires_at });
}

async function handleView(req: Request): Promise<Response> {
  const deviceKey = new URL(req.url).searchParams.get("feeder") ?? "";
  if (!FEEDER_ID_RE.test(deviceKey)) return json({ error: "bad feeder" }, 400);

  // Ask as the caller: forward their apikey + Authorization exactly as the site sent them.
  const auth = req.headers.get("Authorization") ?? "";
  const apikey = req.headers.get("apikey") ?? "";
  if (!auth || !apikey) return json({ error: "missing credentials" }, 401);
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/feeders?select=id&device_key=eq.${encodeURIComponent(deviceKey)}&limit=1`,
    { headers: { apikey, Authorization: auth } });
  if (!res.ok) return json({ error: "not authorized" }, res.status === 401 ? 401 : 403);
  const rows = await res.json();
  if (!rows.length) return json({ error: "not found" }, 404); // private and not a member, or no such feeder

  return json(await mint("view", deviceKey, VIEW_TTL_SECONDS));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (RELAY_SECRET.length < 32) return json({ error: "live view not configured" }, 503);
  try {
    if (req.method === "POST") return await handlePublish(req);
    if (req.method === "GET") return await handleView(req);
    return json({ error: "method not allowed" }, 405);
  } catch (e) {
    console.error("live-token:", e);
    return json({ error: "internal error" }, 500);
  }
});
