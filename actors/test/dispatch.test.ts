import { describe, expect, test } from "bun:test";
import { budgeted, createDispatcher, DEFAULT_LIMITS, type Deps, type SeatTransport } from "../src/dispatch";
import { clientIp, corsHeaders, isCloudflare, MAX_BODY_BYTES, parseSeatRequest, RateLimiter, seatsAllowed, type RoomSnapshot } from "../src/dispatch-policy";
import type { GameActor } from "../src/types";

const WOLF = "89411bc3-10c6-42ae-b17d-06442dec8b8d";
const ORIGIN = "https://nearwolf.games-dev.makeo.fun";
const room = (n = 1) => n.toString(16).padStart(64, "0");
const freeSnap = (r: string, entrants: string[] = ["0xhuman"], max = 7, extra: Partial<NonNullable<RoomSnapshot>> = {}): RoomSnapshot => ({
  instance: `${WOLF}:live:${r}:free`, free: true, vault: "0x0000000000000000000000000000000000000000",
  terms: { max_players: max, entry_deadline_ms: Date.now() + 600_000 }, view: { phase: "Open", entrants }, ...extra,
});

describe("input validation", () => {
  test("accepts a good request", () => {
    expect(parseSeatRequest(JSON.stringify({ project: WOLF, room: room(), ai: 3 }))).toEqual({ ok: true, value: { project: WOLF, game: "nearwolf", room: room(), ai: 3 } });
  });
  test("refuses unknown projects, including prototype keys", () => {
    for (const project of ["00000000-0000-0000-0000-000000000000", "__proto__", "constructor", "", 5]) expect(parseSeatRequest(JSON.stringify({ project, room: room(), ai: 1 })).ok).toBe(false);
  });
  test("refuses a game that does not match the project", () => {
    expect(parseSeatRequest(JSON.stringify({ project: WOLF, game: "holdem", room: room(), ai: 1 })).ok).toBe(false);
  });
  test("refuses bad room ids", () => {
    for (const r of ["abc", "../../etc/passwd", room(0xabc).toUpperCase(), room() + "0", `${room().slice(0, 63)}/`, 7]) expect(parseSeatRequest(JSON.stringify({ project: WOLF, room: r, ai: 1 })).ok).toBe(false);
  });
  test("ai must be an integer 1..6", () => {
    for (const ai of [0, 7, -1, 2.5, "3", null, 1e9]) expect(parseSeatRequest(JSON.stringify({ project: WOLF, room: room(), ai })).ok).toBe(false);
    expect(parseSeatRequest(JSON.stringify({ project: WOLF, room: room(), ai: 6 })).ok).toBe(true);
  });
  test("refuses non-objects and bad JSON", () => {
    for (const t of ["", "[]", "null", "{", '"x"']) expect(parseSeatRequest(t).ok).toBe(false);
  });
  test("ignores a url or host in the body (no SSRF): the platform is fixed", () => {
    const p = parseSeatRequest(JSON.stringify({ project: WOLF, room: room(), ai: 1, base: "http://169.254.169.254", url: "http://evil" }));
    expect(p.ok && Object.keys(p.value).sort()).toEqual(["ai", "game", "project", "room"]);
  });
});

describe("room checks", () => {
  test("a free open match with empty seats", () => expect(seatsAllowed(freeSnap(room()), WOLF, room(), 5)).toEqual({ ok: true, ai: 5 }));
  test("never more AI than empty seats", () => expect(seatsAllowed(freeSnap(room(), ["a", "b", "c", "d", "e"]), WOLF, room(), 6)).toEqual({ ok: true, ai: 2 }));
  test("keeps a seat for the human when nobody has entered", () => expect(seatsAllowed(freeSnap(room(), [], 4, { view: null }), WOLF, room(), 6)).toEqual({ ok: true, ai: 3 }));
  test("a full match is refused", () => expect(seatsAllowed(freeSnap(room(), ["a", "b"], 2), WOLF, room(), 1).ok).toBe(false));
  test("a started match is refused", () => expect(seatsAllowed(freeSnap(room(), ["a"], 7, { view: { phase: "Night", entrants: ["a"] } }), WOLF, room(), 1).ok).toBe(false));
  test("a paid match is refused", () => {
    expect(seatsAllowed(freeSnap(room(), ["a"], 7, { free: false }), WOLF, room(), 1).ok).toBe(false);
    expect(seatsAllowed(freeSnap(room(), ["a"], 7, { vault: "0x1111111111111111111111111111111111111111" }), WOLF, room(), 1).ok).toBe(false);
  });
  test("a missing room (no snapshot, no terms) is refused", () => {
    expect(seatsAllowed(null, WOLF, room(), 1).ok).toBe(false);
    expect(seatsAllowed({ free: true }, WOLF, room(), 1).ok).toBe(false);
  });
  test("a room of another project or instance is refused", () => expect(seatsAllowed(freeSnap(room(2)), WOLF, room(), 1).ok).toBe(false));
  test("a closed entry deadline is refused", () => expect(seatsAllowed(freeSnap(room(), ["a"], 7, { terms: { max_players: 7, entry_deadline_ms: 1 } }), WOLF, room(), 1).ok).toBe(false));
});

describe("client ip", () => {
  test("trusts CF-Connecting-IP only from a Cloudflare edge", () => {
    expect(isCloudflare("172.68.1.1")).toBe(true);
    expect(isCloudflare("2a06:98c1::1")).toBe(true);
    expect(isCloudflare("8.8.8.8")).toBe(false);
    expect(clientIp("172.68.1.1", "203.0.113.9")).toBe("203.0.113.9");
    expect(clientIp("8.8.8.8", "203.0.113.9")).toBe("8.8.8.8");
    expect(clientIp("172.68.1.1", "not-an-ip")).toBe("172.68.1.1");
  });
});

describe("cors", () => {
  test("only the two game pages, never credentials", () => {
    expect(corsHeaders(ORIGIN)["access-control-allow-origin"]).toBe(ORIGIN);
    expect(corsHeaders("https://near-holdem.games-dev.makeo.fun")["access-control-allow-origin"]).toBe("https://near-holdem.games-dev.makeo.fun");
    for (const o of ["https://evil.example", "null", "https://nearwolf.games-dev.makeo.fun.evil.com", null]) expect(corsHeaders(o)["access-control-allow-origin"]).toBeUndefined();
    expect(corsHeaders(ORIGIN)["access-control-allow-credentials"]).toBeUndefined();
  });
});

test("rate limiter window", () => {
  const l = new RateLimiter(2, 1000);
  expect(l.take("a", 0)).toBe(true);
  expect(l.take("a", 10)).toBe(true);
  expect(l.take("a", 20)).toBe(false);
  expect(l.take("b", 20)).toBe(true);
  expect(l.take("a", 1500)).toBe(true);
});

test("budget: moves per hour and the kill switch fall back to scripted (throw)", async () => {
  let calls = 0;
  const inner = { model: "m", complete: async () => { calls++; return { chat_id: "c", json: {}, text: "", request_body: "", response_body: "" }; } };
  let on = true;
  const b = budgeted(inner, 2, () => on);
  await b.complete({ system: "", user: "" });
  await b.complete({ system: "", user: "" });
  await expect(b.complete({ system: "", user: "" })).rejects.toThrow("budget");
  on = false;
  const c = budgeted(inner, 10, () => on);
  await expect(c.complete({ system: "", user: "" })).rejects.toThrow("off");
  expect(calls).toBe(2);
});

// ---- The HTTP handler, with a fake room ----
const actor = { persona: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }, { name: "E" }, { name: "F" }] } as unknown as GameActor;
function make(over: Partial<Deps> = {}, snap: (r: string) => RoomSnapshot = (r) => freeSnap(r)) {
  const plays: string[] = [];
  const finish = new Map<string, () => void>();
  const d = createDispatcher({
    enabled: true, limits: { ...DEFAULT_LIMITS, maxLive: 10, roomsPerHour: 10, ipSeatsPer10Min: 50 }, actors: { nearwolf: actor, holdem: actor }, model: "m",
    connect: (_p, r): SeatTransport => ({ snapshot: async () => snap(r), close: () => {} }),
    play: (r) => { plays.push(r.room); return new Promise<void>((res) => finish.set(r.room, () => { r.receipts.add({ reasoning: "secret plan" } as never); r.finished = true; r.receipts.publish("i"); res(); })); },
    probeMs: 200,
    ...over,
  });
  return { d, plays, finish };
}
const post = (body: unknown, headers: Record<string, string> = {}) => new Request("http://x/seat", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const get = (path: string) => new Request(`http://x${path}`, { headers: { origin: ORIGIN } });

describe("dispatcher http", () => {
  test("seats into a free match and is idempotent per room", async () => {
    const { d, plays } = make();
    const a = await d.fetch(post({ project: WOLF, room: room(), ai: 3 }), "1.1.1.1");
    expect(a.status).toBe(200);
    expect((await a.json()).ai).toBe(3);
    const b = await d.fetch(post({ project: WOLF, room: room(), ai: 6 }), "1.1.1.1");
    expect(b.status).toBe(200);
    expect(plays).toEqual([room()]);
    const other = await d.fetch(post({ project: "795650a8-2999-4971-b388-469c19b9c362", room: room(), ai: 1 }), "1.1.1.1");
    expect(other.status).toBe(409);
  });
  test("refuses missing or foreign origins, and answers CORS only for allowed ones", async () => {
    const { d } = make();
    expect((await d.fetch(post({ project: WOLF, room: room(), ai: 1 }, { origin: "https://evil.example" }), "1.1.1.1")).status).toBe(403);
    expect((await d.fetch(new Request("http://x/seat", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), "1.1.1.1")).status).toBe(403);
    const pre = await d.fetch(new Request("http://x/seat", { method: "OPTIONS", headers: { origin: "https://evil.example" } }), "1.1.1.1");
    expect(pre.status).toBe(403);
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  });
  test("refuses an oversized body", async () => {
    const { d } = make();
    const res = await d.fetch(post(JSON.stringify({ project: WOLF, room: room(), ai: 1, pad: "x".repeat(MAX_BODY_BYTES) })), "1.1.1.1");
    expect(res.status).toBe(413);
  });
  test("refuses a paid or missing room without playing", async () => {
    const { d, plays } = make({}, (r) => freeSnap(r, ["a"], 7, { free: false }));
    expect((await d.fetch(post({ project: WOLF, room: room(), ai: 1 }), "1.1.1.1")).status).toBe(409);
    const slow = make({}, () => new Promise(() => {}) as never);
    expect((await slow.d.fetch(post({ project: WOLF, room: room(), ai: 1 }), "1.1.1.1")).status).toBe(409);
    expect(plays).toEqual([]);
  });
  test("per-IP rate limit", async () => {
    const { d } = make({ limits: { ...DEFAULT_LIMITS, maxLive: 10, roomsPerHour: 10, ipSeatsPer10Min: 2 } });
    expect((await d.fetch(post({ project: WOLF, room: room(1), ai: 1 }), "9.9.9.9")).status).toBe(200);
    expect((await d.fetch(post({ project: WOLF, room: room(2), ai: 1 }), "9.9.9.9")).status).toBe(200);
    expect((await d.fetch(post({ project: WOLF, room: room(3), ai: 1 }), "9.9.9.9")).status).toBe(429);
    expect((await d.fetch(post({ project: WOLF, room: room(3), ai: 1 }), "8.8.4.4")).status).toBe(200);
  });
  test("a spoofed CF-Connecting-IP from a non-Cloudflare peer does not dodge the limit", async () => {
    const { d } = make({ limits: { ...DEFAULT_LIMITS, maxLive: 10, roomsPerHour: 10, ipSeatsPer10Min: 1 } });
    expect((await d.fetch(post({ project: WOLF, room: room(1), ai: 1 }, { "x-agents-client": "1.2.3.4" }), "9.9.9.9")).status).toBe(200);
    expect((await d.fetch(post({ project: WOLF, room: room(2), ai: 1 }, { "x-agents-client": "5.6.7.8" }), "9.9.9.9")).status).toBe(429);
  });
  test("global caps: concurrent rooms and rooms per hour", async () => {
    const live = make({ limits: { ...DEFAULT_LIMITS, maxLive: 1, roomsPerHour: 10, ipSeatsPer10Min: 50 } });
    expect((await live.d.fetch(post({ project: WOLF, room: room(1), ai: 1 }), "1.1.1.1")).status).toBe(200);
    expect((await live.d.fetch(post({ project: WOLF, room: room(2), ai: 1 }), "1.1.1.2")).status).toBe(429);
    live.finish.get(room(1))!();
    await Bun.sleep(5);
    expect((await live.d.fetch(post({ project: WOLF, room: room(2), ai: 1 }), "1.1.1.2")).status).toBe(200);
    const hour = make({ limits: { ...DEFAULT_LIMITS, maxLive: 10, roomsPerHour: 1, ipSeatsPer10Min: 50 } });
    expect((await hour.d.fetch(post({ project: WOLF, room: room(1), ai: 1 }), "1.1.1.1")).status).toBe(200);
    expect((await hour.d.fetch(post({ project: WOLF, room: room(2), ai: 1 }), "1.1.1.2")).status).toBe(429);
  });
  test("hard run time per room", async () => {
    const m = make({ limits: { ...DEFAULT_LIMITS, maxLive: 10, roomsPerHour: 10, ipSeatsPer10Min: 50, roomMs: 20 } });
    await m.d.fetch(post({ project: WOLF, room: room(), ai: 1 }), "1.1.1.1");
    await Bun.sleep(50);
    expect(m.d.rooms.get(room())!.endedAt).not.toBeNull();
    expect(m.d.rooms.get(room())!.finished).toBe(false);
  });
  test("kill switch", async () => {
    const { d, plays } = make({ enabled: false });
    expect((await d.fetch(post({ project: WOLF, room: room(), ai: 1 }), "1.1.1.1")).status).toBe(503);
    expect(plays).toEqual([]);
  });
  test("receipts only after the game ends; status leaks nothing private", async () => {
    const { d, finish } = make();
    await d.fetch(post({ project: WOLF, room: room(), ai: 2 }), "1.1.1.1");
    expect((await d.fetch(get(`/receipts?room=${room()}`), "1.1.1.1")).status).toBe(409);
    const st = JSON.stringify(await (await d.fetch(get(`/status?room=${room()}`), "1.1.1.1")).json());
    expect(st).not.toMatch(/reason|prompt|key|\/Users|\/app/i);
    finish.get(room())!();
    await Bun.sleep(5);
    const res = await d.fetch(get(`/receipts?room=${room()}`), "1.1.1.1");
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain("secret plan");
  });
  test("health and prefix paths, no server paths or keys", async () => {
    process.env.NEAR_AI_API_KEY ??= "sk-test-never-shown";
    const { d } = make();
    const h = await d.fetch(get("/api/near-agents/health"), "1.1.1.1");
    const text = await h.text();
    expect(h.status).toBe(200);
    expect(text).not.toContain(process.env.NEAR_AI_API_KEY!);
    expect(text).not.toMatch(/\/Users|\/app|receipts/);
  });
});
