// A local stand-in for NEARWOLF's room, for the actor harness only (actors/src/harness.ts,
// `--game games/nearwolf`). It mirrors rules/src/lib.rs (the real game, run by Makeo's keeper)
// closely enough to exercise actor.ts end to end: same roles, phases, views and record. Every
// seat is a harness seat here (no house seats). The real rules, not this file, decide real games.
import type { Entry, GameView, Move, Phase, Role, Speech } from "./shared/nearwolf.ts";

const PHASE_MS: Record<Phase, number> = { night: 30000, dawn: 7000, council: 50000, pyre: 30000, dusk: 7000, end: 0 };

type Seat = { wallet: string; persona: number; role: Role; alive: boolean };
export type NearwolfMockState = {
  seats: Seat[];
  phase: Phase;
  round: number;
  deadline_ms: number;
  seq: number;
  night: Record<number, number | null>;
  council: Record<number, Speech>;
  votes: Record<number, number | null>;
  last_heal: number | null;
  looks: Array<{ round: number; target: number; wolf: boolean }>;
  log: Entry[];
  winner: "village" | "wolves" | null;
};

const shuffle = <T>(xs: T[], random: () => number) => {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
};
const living = (s: NearwolfMockState) => s.seats.map((x, i) => (x.alive ? i : -1)).filter((i) => i >= 0);

function enter(s: NearwolfMockState, phase: Phase, now: number) {
  s.phase = phase;
  s.deadline_ms = now + PHASE_MS[phase];
  s.night = {};
  s.council = {};
  s.votes = {};
}

function winCheck(s: NearwolfMockState): "village" | "wolves" | null {
  const a = living(s);
  const w = a.filter((i) => s.seats[i].role === "wolf").length;
  return w === 0 ? "village" : w >= a.length - w ? "wolves" : null;
}

function resolve(s: NearwolfMockState, now: number) {
  if (s.phase === "night") {
    const a = living(s);
    const tally = new Map<number, number>();
    const order: number[] = [];
    for (const i of a)
      if (s.seats[i].role === "wolf" && s.night[i] != null) {
        tally.set(s.night[i]!, (tally.get(s.night[i]!) ?? 0) + 1);
        order.push(s.night[i]!);
      }
    const best = Math.max(0, ...tally.values());
    const victim = order.find((t) => tally.get(t) === best && best > 0) ?? null;
    let healed: number | null = null;
    for (const i of a) {
      const t = s.night[i];
      if (s.seats[i].role === "seer" && t != null) s.looks.push({ round: s.round, target: t, wolf: s.seats[t].role === "wolf" });
      if (s.seats[i].role === "healer") healed = t ?? null;
    }
    s.last_heal = healed;
    const died = victim != null && victim !== healed ? victim : null;
    if (died != null) s.seats[died].alive = false;
    s.log.push({ kind: "dawn", round: s.round, died, role: died != null ? s.seats[died].role : null });
    enter(s, "dawn", now);
  } else if (s.phase === "dawn") enter(s, "council", now);
  else if (s.phase === "council") {
    s.log.push({ kind: "council", round: s.round, moves: living(s).map((i) => [i, s.council[i] ?? { kind: "silent", line: "" }]) });
    enter(s, "pyre", now);
  } else if (s.phase === "pyre") {
    const votes = living(s).map((i) => [i, s.votes[i] ?? null] as [number, number | null]);
    const tally = new Map<number, number>();
    for (const [, t] of votes) if (t != null) tally.set(t, (tally.get(t) ?? 0) + 1);
    const best = Math.max(0, ...tally.values());
    const top = [...tally].filter(([, n]) => n === best).map(([t]) => t);
    const burned = best > 0 && top.length === 1 ? top[0] : null;
    if (burned != null) s.seats[burned].alive = false;
    s.log.push({ kind: "pyre", round: s.round, votes, burned, role: burned != null ? s.seats[burned].role : null });
    enter(s, "dusk", now);
  } else if (s.phase === "dusk") {
    s.round += 1;
    enter(s, "night", now);
  }
  if (s.phase === "dawn" || s.phase === "dusk") {
    const w = winCheck(s);
    if (w) {
      s.winner = w;
      s.phase = "end";
    }
  }
}

function allIn(s: NearwolfMockState) {
  const box = s.phase === "night" ? s.night : s.phase === "council" ? s.council : s.phase === "pyre" ? s.votes : null;
  return !box || living(s).every((i) => i in box);
}

export const mockGame = {
  seats: 7,
  setup(seats: Array<{ wallet: string; name: string }>, random: () => number): NearwolfMockState {
    const n = seats.length;
    const roles: Role[] = Array(Math.max(1, Math.floor(n / 4))).fill("wolf");
    if (n >= 5) roles.push("seer");
    if (n >= 6) roles.push("healer");
    while (roles.length < n) roles.push("villager");
    shuffle(roles, random);
    const personas = shuffle([...Array(9).keys()], random);
    const s: NearwolfMockState = {
      seats: seats.map((x, i) => ({ wallet: x.wallet, persona: personas[i % 9], role: roles[i], alive: true })),
      phase: "night", round: 1, deadline_ms: 0, seq: 0, night: {}, council: {}, votes: {}, last_heal: null, looks: [], log: [], winner: null,
    };
    enter(s, "night", Date.now());
    return s;
  },
  view(s: NearwolfMockState, wallet: string): GameView {
    const me = s.seats.findIndex((x) => x.wallet.toLowerCase() === wallet.toLowerCase());
    const over = s.phase === "end";
    const role = me >= 0 ? s.seats[me].role : null;
    const wolf = role === "wolf";
    const mine = me < 0 ? null : s.phase === "night" && me in s.night ? { target: s.night[me] } : s.phase === "council" ? s.council[me] ?? null : s.phase === "pyre" && me in s.votes ? { target: s.votes[me] } : null;
    return {
      seats: s.seats.map((x, i) => ({
        seat: i, persona: x.persona, alive: x.alive,
        role: over || !x.alive || i === me || (wolf && x.role === "wolf") ? x.role : null,
        house: over ? false : null, wallet: over ? x.wallet : null,
      })),
      you: me >= 0 ? me : null, role, phase: s.phase, round: s.round, deadline_ms: s.deadline_ms, seq: s.seq, mine,
      pack: wolf && s.phase === "night" ? s.seats.map((x, i) => ({ x, i })).filter(({ x, i }) => x.alive && x.role === "wolf" && i !== me).map(({ i }) => ({ seat: i, target: s.night[i] ?? null })) : null,
      looks: over || role === "seer" ? s.looks : null,
      last_heal: over || role === "healer" ? s.last_heal : null,
      log: s.log, winner: s.winner,
      deal: { wolves: s.seats.filter((x) => x.role === "wolf").length, seer: s.seats.length >= 5, healer: s.seats.length >= 6, seats: s.seats.length },
    };
  },
  publicLog: (s: NearwolfMockState) => s.log,
  apply(state: NearwolfMockState, wallet: string, move: Move): NearwolfMockState {
    const s: NearwolfMockState = structuredClone(state);
    const me = s.seats.findIndex((x) => x.wallet.toLowerCase() === wallet.toLowerCase());
    if (me < 0) throw new Error("not at this fire");
    if (!s.seats[me].alive) throw new Error("the dead don't speak");
    const ok = (t: number | null | undefined) => t != null && t >= 0 && t < s.seats.length && s.seats[t].alive;
    if (move.move === "night") {
      if (s.phase !== "night") throw new Error("it is not night");
      if (me in s.night) throw new Error("you already chose tonight");
      const t = move.target ?? null;
      const role = s.seats[me].role;
      if (role === "villager" && t != null) throw new Error("villagers sleep at night");
      if (t != null && !ok(t)) throw new Error("pick someone alive");
      if (role === "wolf" && t != null && s.seats[t].role === "wolf") throw new Error("wolves don't hunt wolves");
      if (role === "seer" && t === me) throw new Error("look at someone else");
      if (role === "healer" && t != null && t === s.last_heal) throw new Error("not the same seat two nights running");
      s.night[me] = t;
    } else if (move.move === "council") {
      if (s.phase !== "council") throw new Error("the council is not sitting");
      if (me in s.council) throw new Error("you already spoke");
      if ((move.line ?? "").length > 120) throw new Error("keep it to one short line");
      if (["accuse", "vouch"].includes(move.kind) && (!ok(move.target) || move.target === me)) throw new Error("pick someone else alive");
      if (move.kind === "report" && (move.target == null || move.target === me || move.wolf == null)) throw new Error("report whom, wolf or not?");
      if (move.kind === "claim" && !move.role) throw new Error("claim which role?");
      s.council[me] = { kind: move.kind, role: move.role, target: move.target, wolf: move.wolf, line: (move.line ?? "").trim() };
    } else if (move.move === "vote") {
      if (s.phase !== "pyre") throw new Error("the pyre is not lit");
      if (me in s.votes) throw new Error("you already voted");
      if (move.target != null && (!ok(move.target) || move.target === me)) throw new Error("vote for someone else alive");
      s.votes[me] = move.target ?? null;
    } else throw new Error("night, council or vote");
    s.seq += 1;
    if (allIn(s)) resolve(s, Date.now());
    return s;
  },
  finished: (s: NearwolfMockState) => s.phase === "end",
  tick(state: NearwolfMockState, nowMs: number): NearwolfMockState {
    if (state.phase === "end" || nowMs < state.deadline_ms) return state;
    const s: NearwolfMockState = structuredClone(state);
    resolve(s, nowMs);
    s.seq += 1;
    return s;
  },
};
