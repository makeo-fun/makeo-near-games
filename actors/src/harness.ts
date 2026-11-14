#!/usr/bin/env bun
// Mock room harness: 1 human + N AI actors at one table, locally, before devnet is wired.
//
//   bun actors/src/harness.ts                          # Last Card demo, you + 2 AI seats, in the terminal
//   bun actors/src/harness.ts --game games/nearwolf --ai 5
//   bun actors/src/harness.ts --game games/holdem --ai 3 --human auto   # no prompts: the human plays randomly
//   bun actors/src/harness.ts --game games/nearwolf --ai 5 --human none --port 8787   # all AI; serve HTTP for a client
//
// --game DIR loads DIR/actor.ts (GameActor, per SPEC) and DIR/mock.ts (`export const mockGame: MockGame`,
// a TypeScript reducer of the rules for local play). AI moves use NEAR AI Cloud when NEAR_AI_API_KEY is
// set (and are verified with verify/nearai.ts), else scripted. Receipts land in actors/receipts/.
import { join, resolve } from "node:path";
import { createNearAiVerifier } from "../../verify/nearai";
import { lastCardActor, lastCardGame } from "./example-game";
import { HumanSeat } from "./human";
import { MockRoom, serveMockRoom, type MockGame } from "./mock-room";
import { nearAiFromEnv } from "./nearai";
import { pickPersonas } from "./personas";
import { ReceiptStore } from "./receipts";
import { runActors } from "./runner";
import type { GameActor } from "./types";

const args = process.argv.slice(2);
const opt = (name: string, fallback?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };

let actor: GameActor = lastCardActor;
let game: MockGame = lastCardGame;
let gameName = "lastcard";
const dir = opt("game");
if (dir) {
  const abs = resolve(process.cwd(), dir);
  gameName = abs.split("/").pop()!;
  actor = (await import(join(abs, "actor.ts"))) as GameActor;
  game = ((await import(join(abs, "mock.ts"))) as { mockGame: MockGame }).mockGame;
}
const human = opt("human", "terminal")!; // terminal | auto | none
const ai = Number(opt("ai", String(game.seats - (human === "none" ? 0 : 1))));
if (ai + (human === "none" ? 0 : 1) !== game.seats) throw new Error(`${gameName} seats ${game.seats}; got ${ai} AI + ${human === "none" ? 0 : 1} human`);

const quiet = args.includes("--quiet");
const log = (line: string) => { if (!quiet) console.log(line); };
const room = await MockRoom.create(game, { game: gameName, seed: Number(opt("seed", String(Date.now() % 1e9))), log, tickMs: Number(opt("tick", "1000")) });
const port = opt("port");
if (port) { serveMockRoom(room, Number(port)); console.log(`mock room on http://localhost:${port} (info, status, log, join, view, move, say)`); }

const inference = nearAiFromEnv();
const verify = inference && process.env.NEAR_AI_API_KEY ? createNearAiVerifier({ apiKey: process.env.NEAR_AI_API_KEY, model: inference.model }) : null;
console.log(inference ? `AI: NEAR AI Cloud, ${inference.model} (verified)` : "AI: scripted (set NEAR_AI_API_KEY for NEAR AI Cloud)");

const receipts = new ReceiptStore(resolve(import.meta.dir, "../receipts"));
const personas = pickPersonas(ai, actor.persona?.length ? actor.persona : undefined);
const running = runActors({ game: gameName, actor, personas, transport: room, inference, verify, receipts, thinkMs: Number(opt("think", "300")), log, timeoutMs: Number(opt("timeout", "1800000")) });

if (human !== "none") {
  const me = await new HumanSeat(room, "You").join();
  const lines = console[Symbol.asyncIterator] ? (console as unknown as AsyncIterable<string>)[Symbol.asyncIterator]() : null;
  let lastKey = "";
  const turn = async () => {
    const view = await me.view();
    if (!view) return;
    const legal = actor.legalMoves(view);
    const key = JSON.stringify(view);
    if (!legal.length || key === lastKey) return;
    lastKey = key;
    let move = legal[Math.floor(Math.random() * legal.length)];
    if (human === "terminal" && lines) {
      console.log(`\nYour view: ${JSON.stringify(view)}\n${legal.map((m, i) => `  ${i}: ${JSON.stringify(m)}`).join("\n")}\nPick a number (or type JSON): `);
      const answer = String((await lines.next()).value ?? "").trim();
      move = /^\d+$/.test(answer) ? legal[Number(answer)] ?? move : (() => { try { return JSON.parse(answer); } catch { return move; } })();
    }
    const ack = await me.play(move);
    if (!ack.accepted) { console.log(`refused: ${ack.message}`); lastKey = ""; }
  };
  let busy = false;
  room.subscribe(async () => { if (busy) return; busy = true; try { await turn(); } finally { busy = false; } });
}

const { outcome, file } = await running;
console.log(`\ngame ${outcome}. ${receipts.all().length} AI receipts${file ? ` → ${file}` : ""}`);
for (const r of receipts.all()) console.log(`  r${r.round} ${room.name(r.seat)}: ${JSON.stringify(r.move)} ${r.fallback ? `[scripted: ${r.fallback}]` : r.verified ? `[verified, ${r.signer} ${r.signing_address}]` : "[unverified]"}`);
room.close();
process.exit(0);
