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
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createNearAiVerifier } from "../../verify/nearai";
import { HumanSeat } from "./human";
import { MakeoTransport, openFreeMatch } from "./makeo-transport";
import { enterPot, implicitAccount } from "./near-entry";
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
  console.log("usage: bun actors/src/join.ts --game <dir> --project <projectId> [--room <roomId> [--start]] [--ai N] [--humans K [--stake NEAR] [--operator URL]] [--seats N] [--think ms]");
  process.exit(projectId ? 0 : 1);
}
const gameDir = resolve(process.cwd(), opt("game") ?? "games/nearwolf");
const actor = (await import(join(gameDir, "actor.ts"))) as GameActor;
const ai = Number(opt("ai", "3"));
// Test human seats: scripted stand-ins for people (random legal moves), labelled as such everywhere.
// --human auto = 1 of them. --humans K = K of them. With --stake <NEAR>, each one also enters the NEAR
// pot: it signs MakeoNearEntry with its own EVM key, naming a fresh implicit NEAR account as payout,
// and the operator relays it (NEAR_OPERATOR_URL, default http://127.0.0.1:8787). AI seats never enter.
const humans = Number(opt("humans", opt("human") === "auto" ? "1" : "0"));
const stakeNear = opt("stake");
const prefer = opt("prefer");
const operatorUrl = opt("operator") ?? process.env.NEAR_OPERATOR_URL ?? "http://127.0.0.1:8787";
const seats = Number(opt("seats", String(ai + humans)));
const given = opt("room");
// --start: the first seat we bring hosts (or is told to) and starts once `seats` have entered.
const weStart = !given || args.includes("--start");
const roomId = given ?? (await openFreeMatch(base, projectId, seats));
// The game id is the keeper's instance as the room names it (a free match's ends in ":free"): the
// keeper signs the result over it, so the NEAR pot and every MakeoNearEntry must name exactly this.
const game = (await new MakeoTransport({ base, projectId, roomId, name: "probe" }).info().then((i) => i.instance).catch(() => null)) ?? `${projectId}:live:${roomId}:free`;
console.log(`room ${roomId} — game/instance ${game}\nplay: ${base}/play/${projectId}?room=${roomId}`);
if (opt("open-only") !== undefined || args.includes("--open-only")) { console.log("opened; nobody seated (--open-only)"); process.exit(0); }

const inference = nearAiFromEnv();
const verify = inference && process.env.NEAR_AI_API_KEY ? createNearAiVerifier({ apiKey: process.env.NEAR_AI_API_KEY, model: inference.model }) : null;
console.log(inference ? `AI: NEAR AI Cloud, ${inference.model} (verified)` : "AI: scripted");
const log = (line: string) => console.log(line);
const receipts = new ReceiptStore(resolve(import.meta.dir, "../receipts"));
const personas = pickPersonas(ai, actor.persona?.length ? actor.persona : undefined);
const transports: MakeoTransport[] = [];
const testHumans: Array<{ label: string; seat: string; payout: string | null; entered: unknown }> = [];
const payoutKeys: Array<{ seat: string; accountId: string; secretKeyHex: string }> = [];
const humanPersona = { id: "test-human", name: "Test human", voice: "plain", style: "solid, sensible play" };
for (let h = 0; h < humans; h++) {
  const label = `TEST HUMAN SEAT ${h + 1} (scripted)`;
  const t = new MakeoTransport({ base, projectId, roomId, name: `Test human ${h + 1}`, log, ...(weStart && h === 0 ? { startAt: seats } : {}) });
  transports.push(t);
  const me = await new HumanSeat(t, `Test human ${h + 1}`).join();
  console.log(`[${label}] seated ${me.wallet}`);
  let payout: string | null = null, entered: unknown = null;
  if (stakeNear) {
    const account = implicitAccount();
    payout = account.accountId;
    payoutKeys.push({ seat: me.wallet, ...account });
    try {
      entered = await enterPot({ operator: operatorUrl, signer: me.signer, game, payout, stakeNear });
      console.log(`[${label}] entered the pot: ${stakeNear} NEAR, payout ${payout}`);
    } catch (e) {
      entered = { error: (e as Error).message };
      console.log(`[${label}] pot entry FAILED: ${(e as Error).message}`);
    }
  }
  testHumans.push({ label, seat: me.wallet, payout, entered });
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
      // --prefer <text>: pick a legal move whose JSON contains it (e.g. "allin" for a short Hold'em match).
      // Otherwise they play the game's own scripted strategy (actor.fallback), so a test human can
      // plausibly win; random legal moves only when the game has none.
      const preferred = prefer ? legal.filter((m) => JSON.stringify(m).includes(prefer)) : [];
      const move = preferred.length ? preferred[Math.floor(Math.random() * preferred.length)]
        : actor.fallback ? actor.fallback(view, legal, humanPersona) : legal[Math.floor(Math.random() * legal.length)];
      const ack = await me.play(move);
      console.log(`[${label}] ${JSON.stringify(move)} ${ack.accepted ? "accepted" : `refused: ${ack.message}`}`);
      if (!ack.accepted) last = "";
    } catch (e) { console.log(`[${label}] ${(e as Error).message}`); } finally { busy = false; }
  };
  t.subscribe(() => void turn());
  setInterval(() => void turn(), 3000);
}
// Every test human must be in the pot before any AI seat joins (the table can't fill, so it can't start).
const failedEntries = stakeNear ? testHumans.filter((t) => (t.entered as { error?: unknown } | null)?.error !== undefined || !t.entered) : [];
if (failedEntries.length) {
  console.log(`ABORT: ${failedEntries.length} test human entr${failedEntries.length > 1 ? "ies" : "y"} failed: ${JSON.stringify(failedEntries)}. No AI seat joined; the match did not start.`);
  transports.forEach((t) => t.close());
  process.exit(2);
}
if (stakeNear) console.log(`all ${testHumans.length} test human seats are in the pot: ${testHumans.map((t) => JSON.stringify(t.entered)).join(" ")}`);
if (payoutKeys.length) {
  // The payout accounts' keys stay on this machine (they can spend what the pot pays); only ids are printed.
  const dir = resolve(import.meta.dir, "../receipts/private");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `payout-keys-${roomId.slice(0, 16)}.json`), JSON.stringify({ game, payoutKeys }, null, 2), { mode: 0o600 });
}
const { outcome, file } = await runActors({
  game: gameDir.split("/").pop()!, actor, personas, inference, verify, receipts, log,
  thinkMs: Number(opt("think", "800")), timeoutMs: Number(opt("timeout", "3600000")),
  transport: null as never,
  // Seats join one by one; the first seat of a room we opened hosts it and starts it once everyone is in.
  transportFor: (persona, i) => {
    const t = new MakeoTransport({ base, projectId, roomId, name: persona.name, log, ...(weStart && humans === 0 && i === 0 ? { startAt: seats } : {}) });
    transports.push(t);
    return t;
  },
});
console.log(`\ngame ${outcome}. ${receipts.all().length} receipts${file ? ` → ${file}` : ""}`);
for (const r of receipts.all()) console.log(`  r${r.round} ${r.seat.slice(0, 10)} ${JSON.stringify(r.move)} ${r.fallback ? `[scripted: ${r.fallback}]` : r.verified ? `[verified ${r.signer}]` : "[unverified]"} ${r.inference_ms ?? "-"}ms`);
if (testHumans.length) console.log(`test human seats: ${JSON.stringify(testHumans)}`);
const runFile = resolve(import.meta.dir, `../receipts/run-${roomId.slice(0, 16)}.json`);
writeFileSync(runFile, JSON.stringify({ game, room: roomId, outcome, agentSeats: [...new Set(receipts.all().map((r) => r.seat))], testHumanSeats: testHumans, receipts: receipts.list() }, null, 2));
console.log(`run → ${runFile}`);
transports.forEach((t) => t.close());
process.exit(0);
