// The dispatcher's safety rules, kept pure so each one has a test (test/dispatch.test.ts).
// Nothing here reads the network, the disk or a shell; dispatch.ts wires them to the real room.

/** The only games the dispatcher serves: project id -> game name. Anything else is refused. */
export const PROJECTS: Readonly<Record<string, string>> = Object.freeze({
  "89411bc3-10c6-42ae-b17d-06442dec8b8d": "nearwolf",
  "795650a8-2999-4971-b388-469c19b9c362": "holdem",
});
/** The only pages that may call it from a browser. */
export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set(["https://nearwolf.games-dev.makeo.fun", "https://near-holdem.games-dev.makeo.fun"]);
/** The only platform it talks to. Fixed here; never taken from a request. */
export const PLATFORM_BASE = "https://app-dev.makeo.fun";

export const MAX_BODY_BYTES = 1024;
export const MAX_AI = 6;
/** Free match room ids are 32 random bytes in hex. */
export const ROOM_RE = /^[0-9a-f]{64}$/;

export type SeatRequest = { project: string; game: string; room: string; ai: number };

/** Validates a POST /seat body (already size-limited text). Unknown fields are ignored, never used. */
export function parseSeatRequest(text: string): { ok: true; value: SeatRequest } | { ok: false; error: string } {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return { ok: false, error: "body must be JSON" }; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const project = typeof b.project === "string" ? b.project : "";
  const game = PROJECTS[project];
  if (!game || !Object.hasOwn(PROJECTS, project)) return { ok: false, error: "that project is not served here" };
  if (b.game !== undefined && b.game !== game) return { ok: false, error: "game does not match project" };
  const room = typeof b.room === "string" ? b.room : "";
  if (!ROOM_RE.test(room)) return { ok: false, error: "room must be a free match room id" };
  const ai = b.ai === undefined ? 3 : b.ai;
  if (typeof ai !== "number" || !Number.isInteger(ai) || ai < 1 || ai > MAX_AI) return { ok: false, error: `ai must be an integer 1..${MAX_AI}` };
  return { ok: true, value: { project, game, room, ai } };
}

/** The room's public paid snapshot as the platform streams it (only the fields the checks read). */
export type RoomSnapshot = {
  instance?: string;
  free?: boolean;
  vault?: string;
  terms?: { max_players?: number; entry_deadline_ms?: number | null } | null;
  view?: { phase?: string; entrants?: string[] } | null;
} | null;

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Decides how many AI seats may join: only a live free match of this project that has not started
 * and has empty seats, never more AI than empty seats, and one seat kept for a human when nobody has
 * entered yet. Paid rooms (a vault, or free !== true) are always refused: agents never sign a paid entry.
 */
export function seatsAllowed(snap: RoomSnapshot, project: string, room: string, wanted: number, now = Date.now()): { ok: true; ai: number } | { ok: false; error: string } {
  if (!snap || !snap.terms) return { ok: false, error: "no live match in that room" };
  if (snap.free !== true || (snap.vault && snap.vault.toLowerCase() !== ZERO)) return { ok: false, error: "NEAR AI seats only join free matches" };
  if (snap.instance !== `${project}:live:${room}:free`) return { ok: false, error: "that room is not a free match of this game" };
  const phase = snap.view?.phase;
  if (snap.view && phase !== "Open") return { ok: false, error: "that match has already started" };
  if (typeof snap.terms.entry_deadline_ms === "number" && snap.terms.entry_deadline_ms < now) return { ok: false, error: "that match is closed to new players" };
  const max = Number(snap.terms.max_players ?? 0);
  if (!Number.isInteger(max) || max < 1) return { ok: false, error: "no live match in that room" };
  const entrants = snap.view?.entrants?.length ?? 0;
  const empty = max - entrants - (entrants === 0 ? 1 : 0);
  if (empty < 1) return { ok: false, error: "that match has no empty seats" };
  return { ok: true, ai: Math.min(wanted, empty) };
}

/** Sliding-window counter: at most `limit` events per `windowMs` per key. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(readonly limit: number, readonly windowMs: number, private readonly maxKeys = 10_000) {}
  private fresh(key: string, now: number) {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.hits.set(key, list); else this.hits.delete(key);
    return list;
  }
  /** Would one more event be allowed now? (Does not record it.) */
  allows(key: string, now = Date.now()) { return this.fresh(key, now).length < this.limit; }
  /** Records an event if allowed; returns whether it was. */
  take(key: string, now = Date.now()) {
    const list = this.fresh(key, now);
    if (list.length >= this.limit) return false;
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) this.hits.delete(this.hits.keys().next().value!);
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
}

/** Cloudflare's published edge ranges (https://www.cloudflare.com/ips/, 2026-11-14). */
const CF_V4 = ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22"];
const CF_V6 = ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"];

const v4 = (ip: string) => {
  const p = ip.split(".");
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
  return p.reduce((a, x) => (a << 8n) | BigInt(Number(x)), 0n);
};
const v6 = (ip: string) => {
  if (!/^[0-9a-f:]+$/i.test(ip) || ip.split("::").length > 2) return null;
  const [head, tail] = ip.includes("::") ? ip.split("::") : [ip, undefined];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  if (fill < 0) return null;
  const parts = [...h, ...Array(fill).fill("0"), ...t];
  if (parts.length !== 8 || parts.some((x) => !/^[0-9a-f]{1,4}$/i.test(x))) return null;
  return parts.reduce((a, x) => (a << 16n) | BigInt(parseInt(x, 16)), 0n);
};
const inRange = (ip: string, cidrs: string[], parse: (s: string) => bigint | null, bits: number) => {
  const n = parse(ip);
  if (n === null) return false;
  return cidrs.some((c) => {
    const [net, len] = c.split("/");
    const m = parse(net!)!;
    const shift = BigInt(bits - Number(len));
    return n >> shift === m >> shift;
  });
};
export const isCloudflare = (ip: string) => {
  const s = ip.replace(/^::ffff:(?=\d+\.)/, "");
  return s.includes(":") ? inRange(s, CF_V6, v6, 128) : inRange(s, CF_V4, v4, 32);
};

/**
 * The client IP for rate limits. Caddy passes the peer it saw (X-Agents-Peer, never from the client:
 * Caddy overwrites it) and Cloudflare's CF-Connecting-IP (X-Agents-Client). The Cloudflare value is
 * trusted only when the peer is a Cloudflare edge; otherwise the peer itself is the client.
 */
export function clientIp(peer: string, cfClient: string | null) {
  const p = peer.trim();
  const c = (cfClient ?? "").trim();
  if (c && isCloudflare(p) && (v4(c) !== null || v6(c) !== null)) return c;
  return p || "unknown";
}

/** CORS headers: the allowed origin echoed back, nothing for any other; never credentials. */
export function corsHeaders(origin: string | null): Record<string, string> {
  const base: Record<string, string> = { "cache-control": "no-store", vary: "origin", "x-content-type-options": "nosniff" };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    base["access-control-allow-origin"] = origin;
    base["access-control-allow-methods"] = "GET, POST, OPTIONS";
    base["access-control-allow-headers"] = "content-type";
    base["access-control-max-age"] = "600";
  }
  return base;
}

/** Reads a body up to `max` bytes; null if larger (stops reading as soon as it is). */
export async function readLimited(req: Request, max = MAX_BODY_BYTES): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { void reader.cancel(); return null; }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
