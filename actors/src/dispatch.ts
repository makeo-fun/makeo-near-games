#!/usr/bin/env bun
// "Play with NEAR AI" in one tap: a small HTTP service a game page calls after opening a free match.
// It seats N NEAR AI agent seats in that room (each a normal player with fresh keys, joined through
// free-entry under its persona's name, never in the pot) and runs them until the game ends. The page's
// human hosts and starts the match.
//
//   bun actors/src/dispatch.ts --port 8790 --games nearwolf=games/nearwolf,holdem=games/holdem
//
//   POST /seat     {game, project, room, ai}  -> {ok, room, seats: [{name, model}]}  (seating runs in the background)
//   GET  /status?room=                          -> {seated, wanted, seats: [{name, wallet, model}], finished, receiptsUrl}
//   GET  /receipts?room=                        -> the room's receipts (reasoning only once the game is over)
//
// Guards, since it may sit behind a public tunnel and spends NEAR AI credit: only the configured games
// and their project ids, at most DISPATCH_ROOMS_PER_HOUR rooms an hour (default 3), at most 2 rooms at
// once, at most 6 AI seats a room, and each room runs for at most 45 minutes.
// Env: NEAR_AI_API_KEY / NEAR_AI_MODEL, MAKEO_PLATFORM_URL (default https://app-dev.makeo.fun).
import { join, resolve } from "node:path";
import { createNearAiVerifier } from "../../verify/nearai";
import { MakeoTransport } from "./makeo-transport";
import { nearAiFromEnv } from "./nearai";
import { pickPersonas } from "./personas";
import { ReceiptStore } from "./receipts";
import { ActorSeat } from "./runner";
import type { GameActor } from "./types";

const args = process.argv.slice(2);
const opt = (name: string, fallback?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const port = Number(opt("port", "8790"));
const base = (process.env.MAKEO_PLATFORM_URL ?? "https://app-dev.makeo.fun").replace(/\/$/, "");
const perHour = Number(process.env.DISPATCH_ROOMS_PER_HOUR ?? "3");
const MAX_LIVE = 2, MAX_AI = 6, ROOM_MS = 45 * 60_000;

/** The games this dispatcher serves: name -> {dir, project}. */
const PROJECTS: Record<string, string> = { nearwolf: "89411bc3-10c6-42ae-b17d-06442dec8b8d", holdem: "795650a8-2999-4971-b388-469c19b9c362" };
const games = new Map<string, { actor: GameActor; project: string }>();
for (const pair of (opt("games") ?? "nearwolf=games/nearwolf,holdem=games/holdem").split(",")) {
  const [name, dir] = pair.split("=");
  if (!name || !dir || !PROJECTS[name]) continue;
  try {
    games.set(name, { actor: (await import(join(resolve(process.cwd(), dir), "actor.ts"))) as GameActor, project: PROJECTS[name]! });
  } catch (e) {
    console.log(`skipping ${name}: ${(e as Error).message}`);
  }
}

const inference = nearAiFromEnv();
const verify = inference && process.env.NEAR_AI_API_KEY ? createNearAiVerifier({ apiKey: process.env.NEAR_AI_API_KEY, model: inference.model }) : null;
const model = inference?.model ?? "scripted";

type Room = { game: string; room: string; wanted: number; seats: Array<{ name: string; wallet: string | null; model: string; error?: string }>; receipts: ReceiptStore; finished: boolean; startedAt: number; stop: () => void };
const rooms = new Map<string, Room>();
const opened: number[] = [];
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

async function runRoom(r: Room, actor: GameActor, project: string) {
  const personas = pickPersonas(r.wanted, actor.persona?.length ? actor.persona : undefined);
  const live: ActorSeat[] = [];
  const transports: MakeoTransport[] = [];
  r.stop = () => { live.forEach((s) => s.stop()); transports.forEach((t) => t.close()); };
  for (const [i, persona] of personas.entries()) {
    // Joined under the persona's name, so Makeo's lobby shows "Mira Vell", not "AI".
    const transport = new MakeoTransport({ base, projectId: project, roomId: r.room, name: persona.name, log });
    transports.push(transport);
    try {
      const seat = await new ActorSeat({ game: r.game, actor, persona, transport, inference, verify, receipts: r.receipts, thinkMs: 0, log }).start();
      live.push(seat);
      r.seats[i] = { name: persona.name, wallet: seat.wallet, model };
      log(`[${r.room.slice(0, 8)}] seated ${persona.name} ${seat.wallet}`);
    } catch (e) {
      r.seats[i] = { name: persona.name, wallet: null, model, error: (e as Error).message };
      log(`[${r.room.slice(0, 8)}] ${persona.name} could not join: ${(e as Error).message}`);
    }
  }
  const timeout = new Promise<"timeout">((res) => setTimeout(() => res("timeout"), ROOM_MS));
  const outcome = await Promise.race([Promise.all(live.map((s) => s.finished)).then(() => "finished" as const), timeout]);
  r.stop();
  if (outcome === "finished") { r.finished = true; r.receipts.publish((await transports[0]!.info()).instance); }
  log(`[${r.room.slice(0, 8)}] ${outcome}, ${r.receipts.all().length} receipts`);
}

const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-allow-private-network": "true",
  "cache-control": "no-store",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
const status = (r: Room) => ({
  room: r.room, game: r.game, wanted: r.wanted, seated: r.seats.filter((s) => s?.wallet).length,
  seats: r.seats.filter(Boolean), finished: r.finished, receiptsUrl: `/receipts?room=${r.room}`,
});

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (req.method === "GET" && url.pathname === "/health") return json({ ok: true, games: [...games.keys()], model, live: [...rooms.values()].filter((r) => !r.finished).length });
    const roomId = url.searchParams.get("room") ?? "";
    if (req.method === "GET" && url.pathname === "/status") {
      const r = rooms.get(roomId);
      return r ? json(status(r)) : json({ error: "no AI seats for that room" }, 404);
    }
    if (req.method === "GET" && url.pathname === "/receipts") {
      const r = rooms.get(roomId);
      if (!r) return json({ error: "no AI seats for that room" }, 404);
      // Before the end, receipts come without reasoning (ReceiptStore keeps confessionals sealed).
      return json({ room: r.room, game: r.game, finished: r.finished, seats: r.seats.filter(Boolean), receipts: r.receipts.list() });
    }
    if (req.method === "POST" && url.pathname === "/seat") {
      const body = (await req.json().catch(() => ({}))) as { game?: string; project?: string; room?: string; ai?: number };
      const g = games.get(String(body.game));
      if (!g) return json({ ok: false, error: `game must be one of ${[...games.keys()].join(", ")}` }, 400);
      if (body.project && body.project !== g.project) return json({ ok: false, error: "that project is not this game" }, 400);
      const room = String(body.room ?? "");
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(room)) return json({ ok: false, error: "room must be the room id" }, 400);
      const existing = rooms.get(room);
      if (existing) return json({ ok: true, ...status(existing) });
      const now = Date.now();
      while (opened.length && now - opened[0]! > 3600_000) opened.shift();
      if (opened.length >= perHour) return json({ ok: false, error: `NEAR AI seats are limited to ${perHour} rooms an hour; try again later` }, 429);
      if ([...rooms.values()].filter((r) => !r.finished && now - r.startedAt < ROOM_MS).length >= MAX_LIVE) return json({ ok: false, error: "NEAR AI is already playing at its limit of tables; try again soon" }, 429);
      const ai = Math.max(1, Math.min(MAX_AI, Math.floor(Number(body.ai ?? 5))));
      opened.push(now);
      const personas = pickPersonas(ai, g.actor.persona?.length ? g.actor.persona : undefined);
      const r: Room = { game: String(body.game), room, wanted: ai, seats: [], receipts: new ReceiptStore(resolve(import.meta.dir, "../receipts")), finished: false, startedAt: now, stop: () => {} };
      rooms.set(room, r);
      log(`[${room.slice(0, 8)}] seating ${ai} NEAR AI for ${r.game}`);
      void runRoom(r, g.actor, g.project).catch((e) => log(`[${room.slice(0, 8)}] failed: ${(e as Error).message}`));
      return json({ ok: true, room, seats: personas.map((p) => ({ name: p.name, model })), statusUrl: `/status?room=${room}` });
    }
    return json({ error: "not found" }, 404);
  },
});
console.log(`NEAR AI dispatcher on :${port} — games ${[...games.keys()].join(", ") || "(none loaded)"}, model ${model}, ${perHour} rooms/hour`);
