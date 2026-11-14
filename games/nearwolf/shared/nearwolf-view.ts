// From the real game to the new UI's state interface (`NearwolfView`, games/nearwolf/ui/story.js).
// Pure: the rules' view for one seat (GameView) in, NearwolfView out; and the UI's choice back
// to the rules' Action. The adapter that wires it to a live Makeo room is client/adapter.ts.
//
// Only what this seat may know goes in: its own role (a wolf's pack), its own visions, the dead's
// roles and the public record. At the end, everything (roles, who sat where, AI receipts).
import { type GameView, type Move, type Role, type Speech, PERSONAS, contradictions, legalMoves } from "./nearwolf.js";

type UiRole = "SEER" | "HEALER" | "WOLF" | "VILLAGER";
export type NwSeat = { id: string; name: string; title: string };
export type NwEvent = Record<string, unknown> & { t: string };
export type NwPending = { kind: "night" | "move" | "vote"; round: number; role?: UiRole; options: string[]; channel?: Array<{ from: string; text: string }> };
export type NearwolfView = {
  me: { seat: string | null; role: UiRole | null; mates: string[] };
  seats: NwSeat[];
  log: NwEvent[];
  pending: NwPending | null;
};
/** One AI receipt (actors/src/types.ts `Receipt`), keyed to a seat by its wallet. */
export type NwReceipt = { seat: string; round: number; model: string; verified: boolean; reasoning: string | null; move: unknown } & Record<string, unknown>;

const NAMES: Record<string, string> = { bram: "Old Bram", maud: "Sister Maud" };
const up = (r: Role | null | undefined): UiRole | null => (r ? (r.toUpperCase() as UiRole) : null);

export function seatId(v: GameView, seat: number): string {
  return (PERSONAS[v.seats[seat]?.persona ?? seat] ?? PERSONAS[0]).name.toLowerCase();
}
function seatOf(v: GameView, id: unknown): number | null {
  if (id == null) return null;
  const i = v.seats.findIndex((s) => seatId(v, s.seat) === String(id).toLowerCase());
  return i >= 0 ? i : null;
}

/** A NEAR AI player, by wallet: its own name and model (from the actor dispatcher). */
export type NwAgent = { name: string; model?: string | null };
export function toNearwolfView(v: GameView, extra: { receipts?: NwReceipt[]; agents?: Record<string, NwAgent>; network?: string; contract?: string | null; practice?: boolean } = {}): NearwolfView {
  const id = (i: number) => seatId(v, i);
  const me = v.you;
  const seats: NwSeat[] = v.seats.map((s) => {
    const p = PERSONAS[s.persona] ?? PERSONAS[0];
    const key = p.name.toLowerCase();
    return { id: key, name: NAMES[key] ?? p.name, title: p.trade };
  });
  const mates = v.role === "wolf" ? v.seats.filter((s) => s.role === "wolf" && s.seat !== me).map((s) => id(s.seat)) : [];
  const log: NwEvent[] = [{ t: "lobby", seats: seats.map((s) => s.id) }, { t: "deal", commitment: "", pcr0: "", keeper: "makeo-keeper" }];
  if (v.role) log.push({ t: "role", role: up(v.role), private: true });
  const { flags } = contradictions(v, (i) => seats[i]?.name ?? String(i));
  const order = ["night", "dawn", "council", "pyre", "dusk", "end"];
  for (let r = 1; r <= v.round; r++) {
    const reached = (phase: string) => r < v.round || v.phase === "end" || order.indexOf(v.phase) >= order.indexOf(phase);
    log.push({ t: "night", round: r });
    for (const l of v.looks ?? []) if (l.round === r && reached("dawn")) log.push({ t: "vision", round: r, target: id(l.target), wolf: l.wolf, private: true });
    const dawn = v.log.find((e) => e.kind === "dawn" && e.round === r);
    if (dawn && dawn.kind === "dawn") {
      // A reveal that exposes a lie: someone reported or claimed against the role just shown.
      let proves: { liar: string; text: string[] } | null = null;
      if (dawn.died != null) {
        for (const e of v.log) {
          if (e.kind !== "council") continue;
          for (const [i, m] of e.moves) {
            const lie = m.kind === "report" && m.target === dawn.died && (dawn.role === "wolf") !== !!m.wolf;
            if (lie && !proves) proves = { liar: id(i), text: [`${seats[dawn.died].name.toUpperCase()} WAS THE ${up(dawn.role)}`, `${seats[i].name.toUpperCase()} SAID ${m.wolf ? "WOLF" : "NOT WOLF"}`, `${seats[i].name.toUpperCase()} LIED`] };
          }
        }
      }
      log.push({ t: "dawn", round: r, died: dawn.died != null ? id(dawn.died) : null, role: up(dawn.role), saved: dawn.died == null, proves });
    }
    if (dawn && reached("council")) log.push({ t: "table", round: r });
    const council = v.log.find((e) => e.kind === "council" && e.round === r);
    if (council && council.kind === "council") {
      log.push({
        t: "moves",
        round: r,
        moves: council.moves.map(([i, m]: [number, Speech]) => ({
          seat: id(i),
          kind: m.kind,
          target: m.target != null ? id(m.target) : undefined,
          wolf: m.wolf,
          role: up(m.role) ?? undefined,
          claim: m.kind === "claim" ? up(m.role) : m.kind === "report" ? "SEER" : undefined,
          line: m.line,
          contradicted: !!flags[`${i}-${r}`],
        })),
      });
    }
    if (council && reached("pyre")) log.push({ t: "vote", round: r });
    const pyre = v.log.find((e) => e.kind === "pyre" && e.round === r);
    if (pyre && pyre.kind === "pyre") {
      const votes: Record<string, string | null> = {};
      for (const [i, t] of pyre.votes) votes[id(i)] = t != null ? id(t) : null;
      log.push({ t: "votes", round: r, votes, banished: pyre.burned != null ? id(pyre.burned) : null, role: up(pyre.role), tie: pyre.burned == null && pyre.votes.some(([, t]) => t != null) });
    }
  }
  if (me != null && v.mine != null) {
    const kind = v.phase === "night" ? "night" : v.phase === "council" ? "move" : "vote";
    log.push({ t: "acted", kind, choice: v.mine, private: true });
  }
  if (v.phase === "end") {
    const receipts = extra.receipts ?? [];
    const byWallet = (w: string | null) => (w ? receipts.filter((x) => String(x.seat).toLowerCase() === w.toLowerCase()) : []);
    const roles: Record<string, UiRole | null> = {};
    const kinds: Record<string, "HUMAN" | "AI" | "HOUSE" | "CPU"> = {};
    const confessionals: Record<string, Record<number, string>> = {};
    const agents: Record<string, NwAgent> = {};
    const agentOf = (w: string | null) => (w ? Object.entries(extra.agents ?? {}).find(([k]) => k.toLowerCase() === w.toLowerCase())?.[1] : undefined);
    for (const s of v.seats) {
      roles[id(s.seat)] = up(s.role);
      const mine = byWallet(s.wallet);
      // HOUSE: played by the rules themselves (scripted, inside the keeper), not a NEAR AI model.
      const agent = agentOf(s.wallet);
      if (agent) agents[id(s.seat)] = agent;
      kinds[id(s.seat)] = extra.practice && s.seat !== me ? "CPU" : s.house ? "HOUSE" : mine.length || agent ? "AI" : "HUMAN";
      for (const x of mine) if (x.reasoning) (confessionals[id(s.seat)] ??= {})[x.round] = x.reasoning;
    }
    log.push({
      t: "end",
      winner: v.winner === "village" ? "VILLAGE" : "WOLVES",
      roles,
      kinds,
      model: receipts[0]?.model ?? Object.values(agents)[0]?.model ?? null,
      agents,
      commitment: null,
      seed: null,
      receipts: receipts.map((x) => ({ ...x, seat: v.seats.find((s) => s.wallet && s.wallet.toLowerCase() === String(x.seat).toLowerCase()) ? id(v.seats.find((s) => s.wallet && s.wallet.toLowerCase() === String(x.seat).toLowerCase())!.seat) : x.seat })),
      confessionals,
      near: { network: extra.network ?? "testnet", contract: extra.contract ?? null, winners: v.seats.filter((s) => s.wallet && (v.winners ?? []).includes(s.wallet.toLowerCase())).map((s) => id(s.seat)) },
    });
  }
  return { me: { seat: me != null ? id(me) : null, role: up(v.role), mates }, seats, log, pending: pending(v) };
}

function pending(v: GameView): NwPending | null {
  const moves = legalMoves(v);
  if (!moves.length) return null;
  const id = (i: number) => seatId(v, i);
  const kind = v.phase === "night" ? "night" : v.phase === "council" ? "move" : "vote";
  const targets = new Set<number>();
  for (const m of moves) if ("target" in m && m.target != null) targets.add(m.target);
  const out: NwPending = { kind, round: v.round, role: up(v.role) ?? undefined, options: [...targets].map(id) };
  if (v.role === "wolf" && v.phase === "night") out.channel = (v.pack ?? []).filter((p) => p.target != null).map((p) => ({ from: id(p.seat), text: `picks ${id(p.target!)}` }));
  return out;
}

/** The UI's choice for the pending action, as the rules' Action. Null if it doesn't fit. */
export function fromChoice(v: GameView, choice: Record<string, unknown>): Move | null {
  const target = seatOf(v, choice.target);
  const line = typeof choice.line === "string" ? choice.line.slice(0, 120) : "";
  if (v.phase === "night") return v.role === "villager" ? { move: "night" } : { move: "night", target };
  if (v.phase === "pyre") return { move: "vote", target };
  if (v.phase === "council") {
    const kind = String(choice.kind ?? "silent") as Speech["kind"];
    if (kind === "claim") {
      const role = String(choice.role ?? choice.claim ?? "").toLowerCase() as Role;
      return ["seer", "healer", "villager", "wolf"].includes(role) ? { move: "council", kind, role, line } : null;
    }
    if (kind === "report") return target != null ? { move: "council", kind, target, wolf: !!choice.wolf, line } : null;
    if (kind === "accuse" || kind === "vouch") return target != null ? { move: "council", kind, target, line } : null;
    return { move: "council", kind: "silent", line };
  }
  return null;
}
