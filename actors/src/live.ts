#!/usr/bin/env bun
// AI seats in a LIVE Makeo free match (app-dev), each a normal player with its own keys.
//
//   bun actors/src/live.ts --game games/nearwolf --project <projectId> --ai 5            # open a free match, AI only; first AI hosts and starts when full
//   bun actors/src/live.ts --game games/nearwolf --project <projectId> --room <roomId> --ai 4   # join a room a human opened (they start it)
//
// MAKEO_PLATFORM_URL is the app (default https://app-dev.makeo.fun). NEAR AI is used when NEAR_AI_API_KEY is set.
import { join, resolve } from "node:path";
import { createNearAiVerifier } from "../../verify/nearai";
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
if (!projectId) throw new Error("--project <projectId> is required");
const gameDir = resolve(process.cwd(), opt("game") ?? "games/nearwolf");
const actor = (await import(join(gameDir, "actor.ts"))) as GameActor;
const ai = Number(opt("ai", "3"));
const given = opt("room");
const roomId = given ?? (await openFreeMatch(base, projectId, Number(opt("seats", String(ai)))));
console.log(`room ${roomId} — instance ${projectId}:live:${roomId}\nplay: ${base}/play/${projectId}?room=${roomId}`);

const inference = nearAiFromEnv();
const verify = inference && process.env.NEAR_AI_API_KEY ? createNearAiVerifier({ apiKey: process.env.NEAR_AI_API_KEY, model: inference.model }) : null;
console.log(inference ? `AI: NEAR AI Cloud, ${inference.model} (verified)` : "AI: scripted");
const log = (line: string) => console.log(line);
const receipts = new ReceiptStore(resolve(import.meta.dir, "../receipts"));
const personas = pickPersonas(ai, actor.persona?.length ? actor.persona : undefined);
const transports: MakeoTransport[] = [];
const { outcome, file } = await runActors({
  game: gameDir.split("/").pop()!, actor, personas, inference, verify, receipts, log,
  thinkMs: Number(opt("think", "800")), timeoutMs: Number(opt("timeout", "3600000")),
  transport: null as never,
  // Seats join one by one; the first seat of a room we opened hosts it and starts it once everyone is in.
  transportFor: (persona, i) => {
    const t = new MakeoTransport({ base, projectId, roomId, name: persona.name, log, ...(given || i > 0 ? {} : { startAt: Number(opt("seats", String(ai))) }) });
    transports.push(t);
    return t;
  },
});
console.log(`\ngame ${outcome}. ${receipts.all().length} receipts${file ? ` → ${file}` : ""}`);
for (const r of receipts.all()) console.log(`  r${r.round} ${r.seat.slice(0, 10)} ${JSON.stringify(r.move)} ${r.fallback ? `[scripted: ${r.fallback}]` : r.verified ? `[verified ${r.signer}]` : "[unverified]"} ${r.inference_ms ?? "-"}ms`);
transports.forEach((t) => t.close());
process.exit(0);
