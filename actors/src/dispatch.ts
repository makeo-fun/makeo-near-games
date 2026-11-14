#!/usr/bin/env bun
// "Play with NEAR AI": a small public HTTP service a game page calls after opening a free match. It
// seats up to N NEAR AI agents in that room (each a normal player with fresh throwaway keys, joined
// through free-entry under its persona's name, never in a pot) and runs them until the game ends.
//
//   bun actors/src/dispatch.ts            (PORT, default 8790; listens on HOST, default 127.0.0.1)
//
//   POST /seat     {project, room, ai}  -> {ok, room, ai, seats: [{name, model}]}  (seating continues in the background)
//   GET  /status?room=                   -> {room, game, wanted, seated, seats: [{name, wallet, model}], finished}
//   GET  /receipts?room=                 -> the room's receipts, only once its game is over
//   GET  /health                         -> {ok, enabled, games, live}
//
// The safety rules live in dispatch-policy.ts and are listed in actors/README.md ("Security").
// Env: NEAR_AI_API_KEY (secret; never logged or returned), NEAR_AI_MODEL, DISPATCH_DISABLED=1 (kill
// switch), DISPATCH_MAX_LIVE, DISPATCH_ROOMS_PER_HOUR, DISPATCH_MOVES_PER_HOUR, DISPATCH_ROOM_MINUTES,
// DISPATCH_IP_SEATS_PER_10MIN, RECEIPTS_DIR (optional; receipts are kept in memory otherwise).
import { createNearAiVerifier } from "../../verify/nearai";
import * as holdem from "../../games/holdem/actor";
import * as nearwolf from "../../games/nearwolf/actor";
import { clientIp, corsHeaders, parseSeatRequest, PLATFORM_BASE, PROJECTS, RateLimiter, readLimited, seatsAllowed, type RoomSnapshot } from "./dispatch-policy";
import { MakeoTransport } from "./makeo-transport";
import { nearAiFromEnv, type Inference } from "./nearai";
import { pickPersonas } from "./personas";
import { ReceiptStore } from "./receipts";
import { ActorSeat } from "./runner";
import type { GameActor, Persona } from "./types";

export type Limits = { maxLive: number; roomsPerHour: number; movesPerHour: number; roomMs: number; ipSeatsPer10Min: number; ipRequestsPerMin: number };
export const DEFAULT_LIMITS: Limits = { maxLive: 2, roomsPerHour: 6, movesPerHour: 900, roomMs: 45 * 60_000, ipSeatsPer10Min: 4, ipRequestsPerMin: 120 };

/** One seat's live connection; the real one is MakeoTransport. */
export type SeatTransport = { snapshot(): Promise<RoomSnapshot>; close(): void };
export type Deps = {
  enabled: boolean;
  limits: Limits;
  actors: Record<string, GameActor>;
  model: string;
  /** Opens a seat's connection to the room (fixed platform; project and room already validated). */
  connect: (project: string, room: string, name: string) => SeatTransport;
  /** Seats the personas and plays to the end; `first` is already connected. Resolves when done. */
  play: (room: Room, first: SeatTransport, personas: Persona[]) => Promise<void>;
  probeMs?: number;
  log?: (line: string) => void;
  now?: () => number;
};

export type Room = {
  project: string; game: string; room: string; wanted: number;
  seats: Array<{ name: string; wallet: string | null; model: string }>;
  receipts: ReceiptStore; finished: boolean; startedAt: number; endedAt: number | null; stop: () => void;
};

const short = (room: string) => room.slice(0, 8);

export function createDispatcher(deps: Deps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const rooms = new Map<string, Room>();
  const pending = new Set<string>();
  const roomsHour = new RateLimiter(deps.limits.roomsPerHour, 3600_000);
  const ipSeats = new RateLimiter(deps.limits.ipSeatsPer10Min, 600_000);
  const ipRequests = new RateLimiter(deps.limits.ipRequestsPerMin, 60_000);

  const live = () => [...rooms.values()].filter((r) => r.endedAt === null).length + pending.size;
  const prune = () => {
    // Forget ended rooms after 6 hours, and keep at most 500 records.
    for (const [id, r] of rooms) if (r.endedAt !== null && (now() - r.endedAt > 6 * 3600_000 || rooms.size > 500)) rooms.delete(id);
  };
  const status = (r: Room) => ({
    room: r.room, game: r.game, wanted: r.wanted, seated: r.seats.filter((s) => s?.wallet).length,
    seats: r.seats.filter(Boolean).map((s) => ({ name: s.name, wallet: s.wallet, model: s.model })), finished: r.finished,
  });

  async function seat(text: string, ip: string, cors: Record<string, string>) {
    const json = (body: unknown, code = 200) => Response.json(body, { status: code, headers: cors });
    const parsed = parseSeatRequest(text);
    if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);
    const { project, game, room, ai } = parsed.value;
    const existing = rooms.get(room);
    if (existing) return json({ ok: true, ai: existing.wanted, ...status(existing) }); // one dispatch per room
    if (pending.has(room)) return json({ ok: false, error: "already seating NEAR AI in that room" }, 409);
    if (!deps.enabled) return json({ ok: false, error: "NEAR AI seats are switched off right now" }, 503);
    if (!ipSeats.take(ip, now())) return json({ ok: false, error: "too many requests; try again in a few minutes" }, 429);
    if (live() >= deps.limits.maxLive) return json({ ok: false, error: "NEAR AI is already playing at its limit of tables; try again soon" }, 429);
    if (!roomsHour.allows("all", now())) return json({ ok: false, error: "NEAR AI seats are limited this hour; try again later" }, 429);
    const actor = deps.actors[game];
    if (!actor) return json({ ok: false, error: "that game is not available" }, 503);

    pending.add(room);
    const personas = pickPersonas(ai, actor.persona?.length ? actor.persona : undefined);
    const first = deps.connect(project, room, personas[0]!.name);
    let snap: RoomSnapshot = null;
    try {
      snap = await Promise.race([first.snapshot(), new Promise<null>((res) => setTimeout(() => res(null), deps.probeMs ?? 12_000))]);
    } catch { snap = null; }
    const verdict = seatsAllowed(snap, project, room, ai, now());
    if (!verdict.ok || !roomsHour.take("all", now())) {
      pending.delete(room);
      first.close();
      return json({ ok: false, error: verdict.ok ? "NEAR AI seats are limited this hour; try again later" : verdict.error }, verdict.ok ? 429 : 409);
    }
    const chosen = personas.slice(0, verdict.ai);
    const r: Room = { project, game, room, wanted: verdict.ai, seats: [], receipts: new ReceiptStore(process.env.RECEIPTS_DIR || undefined), finished: false, startedAt: now(), endedAt: null, stop: () => {} };
    rooms.set(room, r);
    pending.delete(room);
    log(`[${short(room)}] seating ${verdict.ai} NEAR AI for ${game}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((res) => { timer = setTimeout(() => { log(`[${short(room)}] hard time limit`); res(); }, deps.limits.roomMs); });
    void Promise.race([deps.play(r, first, chosen), deadline])
      .catch((e) => log(`[${short(room)}] failed: ${(e as Error).name}`))
      .finally(() => { clearTimeout(timer); r.stop(); first.close(); r.endedAt = now(); prune(); log(`[${short(room)}] ended (${r.finished ? "game over" : "stopped"})`); });
    return json({ ok: true, room, ai: verdict.ai, seats: chosen.map((p) => ({ name: p.name, model: deps.model })) });
  }

  async function fetch(req: Request, peer: string): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get("origin");
    const cors = corsHeaders(origin);
    const json = (body: unknown, code = 200) => Response.json(body, { status: code, headers: cors });
    const ip = clientIp(peer, req.headers.get("x-agents-client"));
    if (!ipRequests.take(ip, now())) return json({ error: "too many requests" }, 429);
    // Routes may arrive with or without the public prefix Caddy strips.
    const path = url.pathname.replace(/^\/api\/near-agents(?=\/)/, "");
    if (req.method === "OPTIONS") return new Response(null, { status: cors["access-control-allow-origin"] ? 204 : 403, headers: cors });
    if (req.method === "GET" && path === "/health") return json({ ok: true, enabled: deps.enabled, games: Object.keys(deps.actors), live: live() });
    if (req.method === "GET" && (path === "/status" || path === "/receipts")) {
      const r = rooms.get(url.searchParams.get("room") ?? "");
      if (!r) return json({ error: "no NEAR AI seats in that room" }, 404);
      if (path === "/status") return json(status(r));
      // Receipts (reasoning, prompts with the seat's private view) only once the game is over.
      if (!r.finished) return json({ error: "receipts are published when the game ends" }, 409);
      return json({ room: r.room, game: r.game, finished: true, seats: status(r).seats, receipts: r.receipts.list() });
    }
    if (req.method === "POST" && path === "/seat") {
      // Browsers must come from the two game pages; no Origin (curl, servers) is refused too.
      if (!origin || !cors["access-control-allow-origin"]) return json({ ok: false, error: "origin not allowed" }, 403);
      if (!(req.headers.get("content-type") ?? "").startsWith("application/json") && !(req.headers.get("content-type") ?? "").startsWith("text/plain")) return json({ ok: false, error: "content-type must be application/json" }, 415);
      const text = await readLimited(req);
      if (text === null) return json({ ok: false, error: "body too large" }, 413);
      return seat(text, ip, cors);
    }
    return json({ error: "not found" }, 404);
  }

  return { fetch, rooms, stopAll: () => rooms.forEach((r) => r.stop()) };
}

/** NEAR AI with a global hourly move budget and the kill switch: over budget, seats play scripted moves. */
export function budgeted(inner: Inference, movesPerHour: number, enabled: () => boolean, now = Date.now): Inference {
  const moves = new RateLimiter(movesPerHour, 3600_000);
  return {
    model: inner.model,
    complete: (prompt) => {
      if (!enabled()) return Promise.reject(new Error("NEAR AI switched off"));
      if (!moves.take("all", now())) return Promise.reject(new Error("hourly NEAR AI budget reached"));
      return inner.complete(prompt);
    },
  };
}

const envInt = (name: string, fallback: number, max: number) => {
  const n = Number(process.env[name] ?? fallback);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
};

if (import.meta.main) {
  const enabled = process.env.DISPATCH_DISABLED !== "1";
  const limits: Limits = {
    maxLive: envInt("DISPATCH_MAX_LIVE", DEFAULT_LIMITS.maxLive, 6),
    roomsPerHour: envInt("DISPATCH_ROOMS_PER_HOUR", DEFAULT_LIMITS.roomsPerHour, 30),
    movesPerHour: envInt("DISPATCH_MOVES_PER_HOUR", DEFAULT_LIMITS.movesPerHour, 5000),
    roomMs: envInt("DISPATCH_ROOM_MINUTES", 45, 90) * 60_000,
    ipSeatsPer10Min: envInt("DISPATCH_IP_SEATS_PER_10MIN", DEFAULT_LIMITS.ipSeatsPer10Min, 20),
    ipRequestsPerMin: DEFAULT_LIMITS.ipRequestsPerMin,
  };
  const ts = () => new Date().toISOString().slice(11, 19);
  const log = (line: string) => console.log(`${ts()} ${line}`);
  const apiKey = process.env.NEAR_AI_API_KEY;
  const raw = nearAiFromEnv();
  const inference = raw ? budgeted(raw, limits.movesPerHour, () => enabled) : null;
  const verify = raw && apiKey ? createNearAiVerifier({ apiKey, model: raw.model }) : null;
  const model = raw?.model ?? "scripted";
  const actors: Record<string, GameActor> = { nearwolf: nearwolf as unknown as GameActor, holdem: holdem as unknown as GameActor };
  // The seat's own logs can name wallets and moves, never prompts, reasoning or the key.
  const quiet = (line: string) => { if (!/reason|prompt|bearer|api[_-]?key/i.test(line)) log(line); };

  const dispatcher = createDispatcher({
    enabled, limits, actors, model, log,
    connect: (project, room, name) => new MakeoTransport({ base: PLATFORM_BASE, projectId: project, roomId: room, name, log: quiet }),
    play: async (r, first, personas) => {
      const actor = actors[r.game]!;
      const seats: ActorSeat[] = [];
      const transports = [first as unknown as MakeoTransport];
      r.stop = () => { seats.forEach((s) => s.stop()); transports.forEach((t) => t.close()); };
      verify?.attestation().then((a) => r.receipts.setAttestation(a)).catch(() => undefined);
      for (const [i, persona] of personas.entries()) {
        const transport = i === 0 ? transports[0]! : new MakeoTransport({ base: PLATFORM_BASE, projectId: r.project, roomId: r.room, name: persona.name, log: quiet });
        if (i > 0) transports.push(transport);
        try {
          const s = await new ActorSeat({ game: r.game, actor, persona, transport, inference, verify, receipts: r.receipts, thinkMs: 0, log: quiet }).start();
          seats.push(s);
          r.seats[i] = { name: persona.name, wallet: s.wallet, model };
        } catch {
          r.seats[i] = { name: persona.name, wallet: null, model };
          log(`[${r.room.slice(0, 8)}] ${persona.name} could not join`);
        }
      }
      if (!seats.length) return;
      await Promise.all(seats.map((s) => s.finished));
      const st = await (transports[0]!).status().catch(() => null);
      if (st?.finished) { r.finished = true; r.receipts.publish((await transports[0]!.info()).instance); }
    },
  });

  const port = envInt("PORT", 8790, 65535);
  const server = Bun.serve({
    hostname: process.env.HOST ?? "127.0.0.1",
    port,
    idleTimeout: 15,
    maxRequestBodySize: 4096,
    fetch: (req, srv) => {
      // X-Agents-Peer is set by Caddy on this host; only a local or docker-bridge peer may pass it.
      const peer = srv.requestIP(req)?.address ?? "";
      const local = /^(::1|(::ffff:)?(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.))/.test(peer);
      return dispatcher.fetch(req, (local && req.headers.get("x-agents-peer")) || peer);
    },
    error: () => Response.json({ error: "internal error" }, { status: 500 }),
  });
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { dispatcher.stopAll(); server.stop(); process.exit(0); });
  console.log(`NEAR AI dispatcher on ${server.hostname}:${port}: games ${Object.keys(actors).join(", ")}, model ${model}, ${enabled ? "enabled" : "DISABLED"}, limits ${JSON.stringify(limits)}`);
}
