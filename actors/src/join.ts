#!/usr/bin/env bun
// Agent seats in a LIVE Makeo room (app-dev): one runner for every game (NEARWOLF, Hold'em, …).
//
//   bun actors/src/join.ts --game games/nearwolf --project <projectId> --room <roomId> --ai 4
//   bun actors/src/join.ts --game games/holdem   --project <projectId> --room <roomId> --ai 3
//   bun actors/src/join.ts --game games/nearwolf --project <projectId> --ai 5     # no --room: open a free match, AI only
//
// An agent seat is a normal player with a fresh EVM key and P-256 session key, made for this run and
// never written down. It joins through free-entry. It NEVER signs MakeoNearEntry and has no NEAR
// account and no funds, so the pot counts it out of the payout. A room someone else opened is started
// by its host; a room this command opens is started by its first agent once every seat is in.
//
// Env: MAKEO_PLATFORM_URL (default https://app-dev.makeo.fun); NEAR_AI_API_KEY / NEAR_AI_MODEL for
// NEAR AI Cloud moves (verified with verify/nearai.ts), else scripted. Receipts go to actors/receipts/.
import { join, resolve } from "node:path";
import { createNearAiVerifier } from "../../verify/nearai";
import { HumanSeat } from "./human";
import { MakeoTransport, openFreeMatch } from "./makeo-transport";
import { nearAiFromEnv } from "./nearai";
import { pickPersonas } from "./personas";
import { ReceiptStore } from "./receipts";
import { runActors } from "./runner";
import type { GameActor } from "./types";

const args = process.argv.slice(2);
const opt = (name: string, fallback?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const base = (opt("base") ?? process.env.MAKEO_PLATFORM_URL ?? "https://app-dev.makeo.fun").replace(/\/$/, "");
const projectId = opt("project") ?? process.env.MAKEO_PROJECT_ID;
if (!projectId || args.includes("--help")) {
  console.log("usage: bun actors/src/join.ts --game <dir> --project <projectId> [--room <roomId>] [--ai N] [--seats N] [--think ms]");
  process.exit(projectId ? 0 : 1);
}
const gameDir = resolve(process.cwd(), opt("game") ?? "games/nearwolf");
const actor = (await import(join(gameDir, "actor.ts"))) as GameActor;
const ai = Number(opt("ai", "3"));
// --human auto: one extra seat that plays random legal moves (a stand-in human, for testing the table).
const autoHuman = opt("human") === "auto";
const seats = Number(opt("seats", String(ai + (autoHuman ? 1 : 0))));
const given = opt("room");
const roomId = given ?? (await openFreeMatch(base, projectId, seats));
console.log(`room ${roomId} — instance ${projectId}:live:${roomId}\nplay: ${base}/play/${projectId}?room=${roomId}`);

const inference = nearAiFromEnv();
const verify = inference && process.env.NEAR_AI_API_KEY ? createNearAiVerifier({ apiKey: process.env.NEAR_AI_API_KEY, model: inference.model }) : null;
console.log(inference ? `AI: NEAR AI Cloud, ${inference.model} (verified)` : "AI: scripted");
const log = (line: string) => console.log(line);
const receipts = new ReceiptStore(resolve(import.meta.dir, "../receipts"));
const personas = pickPersonas(ai, actor.persona?.length ? actor.persona : undefined);
const transports: MakeoTransport[] = [];
// The stand-in human joins first, so in a room we opened it is the host and starts the match when full.
if (autoHuman) {
  const t = new MakeoTransport({ base, projectId, roomId, name: "Auto human", log, ...(given ? {} : { startAt: seats }) });
  transports.push(t);
  const me = await new HumanSeat(t, "Auto human").join();
  console.log(`[Auto human] seated ${me.wallet}`);
  let busy = false, last = "";
  const turn = async () => {
    if (busy) return;
    busy = true;
    try {
      const view = await me.view();
      const legal = view ? actor.legalMoves(view) : [];
      const key = JSON.stringify(view);
      if (!legal.length || key === last) return;
      last = key;
      const move = legal[Math.floor(Math.random() * legal.length)];
      const ack = await me.play(move);
      console.log(`[Auto human] ${JSON.stringify(move)} ${ack.accepted ? "accepted" : `refused: ${ack.message}`}`);
      if (!ack.accepted) last = "";
    } catch (e) { console.log(`[Auto human] ${(e as Error).message}`); } finally { busy = false; }
  };
  t.subscribe(() => void turn());
  setInterval(() => void turn(), 3000);
}
const { outcome, file } = await runActors({
  game: gameDir.split("/").pop()!, actor, personas, inference, verify, receipts, log,
  thinkMs: Number(opt("think", "800")), timeoutMs: Number(opt("timeout", "3600000")),
  transport: null as never,
  // Seats join one by one; the first seat of a room we opened hosts it and starts it once everyone is in.
  transportFor: (persona, i) => {
    const t = new MakeoTransport({ base, projectId, roomId, name: persona.name, log, ...(given || autoHuman || i > 0 ? {} : { startAt: seats }) });
    transports.push(t);
    return t;
  },
});
console.log(`\ngame ${outcome}. ${receipts.all().length} receipts${file ? ` → ${file}` : ""}`);
for (const r of receipts.all()) console.log(`  r${r.round} ${r.seat.slice(0, 10)} ${JSON.stringify(r.move)} ${r.fallback ? `[scripted: ${r.fallback}]` : r.verified ? `[verified ${r.signer}]` : "[unverified]"} ${r.inference_ms ?? "-"}ms`);
transports.forEach((t) => t.close());
process.exit(0);
