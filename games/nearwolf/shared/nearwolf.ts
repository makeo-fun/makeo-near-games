// NEARWOLF's shared, pure model: the rules' view as TypeScript, the personas, the public-record
// analysis (contradictions), each seat's legal moves and a scripted player. Used by the page, the
// page's CPU seats and the AI actor (actor.ts). No DOM, no I/O.

export type Role = "wolf" | "seer" | "healer" | "villager";
export type Phase = "night" | "dawn" | "council" | "pyre" | "dusk" | "end";
export type Team = "village" | "wolves";

export type Speech = {
  kind: "claim" | "report" | "accuse" | "vouch" | "silent";
  role?: Role;
  target?: number;
  wolf?: boolean;
  line: string;
};

export type Entry =
  | { kind: "dawn"; round: number; died: number | null; role: Role | null }
  | { kind: "council"; round: number; moves: Array<[number, Speech]> }
  | { kind: "pyre"; round: number; votes: Array<[number, number | null]>; burned: number | null; role: Role | null };

export type SeatView = {
  seat: number;
  persona: number;
  alive: boolean;
  /** Known to this viewer: their own, their pack's (a wolf), the dead's, everyone's at the end. */
  role: Role | null;
  /** Revealed at the end: a house seat (played by the rules) or an entrant. */
  house: boolean | null;
  wallet: string | null;
};

/** The rules' `view` for one seat (rules/src/lib.rs, `fn view`). */
export type GameView = {
  seats: SeatView[];
  you: number | null;
  role: Role | null;
  phase: Phase;
  round: number;
  deadline_ms: number;
  seq: number;
  /** This seat's own sealed choice this phase. */
  mine: { target?: number | null } | Speech | null;
  /** A wolf at night: the rest of the pack and their picks. */
  pack: Array<{ seat: number; target: number | null }> | null;
  /** The Seer's visions (everyone's at the end). */
  looks: Array<{ round: number; target: number; wolf: boolean }> | null;
  last_heal: number | null;
  log: Entry[];
  winner: Team | null;
  deal: { wolves: number; seer: boolean; healer: boolean; seats: number };
};

export type Move =
  | { move: "night"; target?: number | null }
  | { move: "council"; kind: Speech["kind"]; role?: Role; target?: number; wolf?: boolean; line: string }
  | { move: "vote"; target: number | null };

export type Persona = { name: string; trade: string; color: string; voice: string; style: string };

/** The faces at the fire, by `persona` index (the rules deal 16 of them). */
export const PERSONAS: Persona[] = [
  { name: "Ash", trade: "the lamplighter", color: "#5cc8ff", voice: "measured, watchful", style: "careful; reports what it sees, rarely bluffs" },
  { name: "Wren", trade: "the herbalist", color: "#3ddc97", voice: "gentle, direct", style: "trusting until proven wrong; vouches often" },
  { name: "Corin", trade: "the ferryman", color: "#a78bfa", voice: "dry, laconic", style: "reads votes more than words" },
  { name: "Bram", trade: "the miller", color: "#ffd166", voice: "slow, folksy", style: "patient; stays silent early, strikes late" },
  { name: "Juno", trade: "the weaver", color: "#f49ac1", voice: "quick, curious", style: "asks questions, accuses the evasive" },
  { name: "Hale", trade: "the hunter", color: "#ff8a66", voice: "bold, certain", style: "aggressive; claims and accuses loudly" },
  { name: "Maud", trade: "of the chapel", color: "#c9cedf", voice: "solemn, formal", style: "principled; follows revealed roles" },
  { name: "Tobias", trade: "the drunk", color: "#b8e986", voice: "rambling, comic", style: "chaotic; hunches over logic" },
  { name: "Pell", trade: "the baker", color: "#4fd1c5", voice: "warm, anxious", style: "goes with the majority, then regrets it" },
  { name: "Ida", trade: "the smith", color: "#ff6b9a", voice: "blunt, loud", style: "accuses fast and holds the line" },
  { name: "Osric", trade: "the scribe", color: "#9fb4ff", voice: "precise, pedantic", style: "cites the record for every claim" },
  { name: "Nell", trade: "the shepherd", color: "#f7c873", voice: "soft, wary", style: "vouches for the quiet, distrusts the loud" },
  { name: "Fenn", trade: "the trapper", color: "#7bdcb5", voice: "sly, teasing", style: "baits others into contradicting themselves" },
  { name: "Rook", trade: "the gravedigger", color: "#b3a1ff", voice: "grim, sparse", style: "speaks rarely, votes decisively" },
  { name: "Sela", trade: "the midwife", color: "#ffa8c5", voice: "kind, firm", style: "protective; defends the accused" },
  { name: "Thane", trade: "the reeve", color: "#ffb347", voice: "commanding", style: "organizes the vote around the record" },
];

export const ROLES: Record<Role, { name: string; color: string; about: string }> = {
  wolf: { name: "Wolf", color: "#ff6b5b", about: "Hunt by night with your pack. You win when wolves equal the village." },
  seer: { name: "Seer", color: "#5cc8ff", about: "Each night, look at one player. The keeper tells you only: wolf, or not wolf." },
  healer: { name: "Healer", color: "#3ddc97", about: "Each night, protect one player. Never the same one twice in a row." },
  villager: { name: "Villager", color: "#ffd166", about: "No power at night. Read the record. Burn the wolves." },
};

export const LINE_MAX = 120;

export function persona(v: GameView, seat: number): Persona {
  return PERSONAS[v.seats[seat]?.persona ?? seat % PERSONAS.length] ?? PERSONAS[0];
}

export const alive = (v: GameView) => v.seats.filter((s) => s.alive).map((s) => s.seat);

/** Every role the record has shown to everyone (the dead), or all roles at the end. */
export function revealed(v: GameView): Record<number, Role> {
  const out: Record<number, Role> = {};
  for (const s of v.seats) if (s.role && (!s.alive || v.phase === "end")) out[s.seat] = s.role;
  return out;
}

export function councils(v: GameView): Array<{ round: number; moves: Array<[number, Speech]> }> {
  return v.log.filter((e): e is Extract<Entry, { kind: "council" }> => e.kind === "council");
}

export type Contradiction = { text: string; soft?: boolean; seat: number; round: number };

/** What the public record contradicts, from public information only (never this seat's secrets). */
export function contradictions(v: GameView, name: (seat: number) => string): { list: Contradiction[]; flags: Record<string, Contradiction> } {
  const rev = revealed(v);
  const list: Contradiction[] = [];
  const flags: Record<string, Contradiction> = {};
  const add = (c: Contradiction) => {
    list.push(c);
    flags[`${c.seat}-${c.round}`] = c;
  };
  const claimers: Record<"seer" | "healer", Set<number>> = { seer: new Set(), healer: new Set() };
  for (const c of councils(v)) {
    for (const [i, m] of c.moves) {
      if ((m.kind === "claim" && m.role === "seer") || m.kind === "report") claimers.seer.add(i);
      if (m.kind === "claim" && m.role === "healer") claimers.healer.add(i);
    }
  }
  for (const role of ["seer", "healer"] as const) {
    const who = [...claimers[role]];
    if (who.length > 1) {
      const first = who[0];
      list.push({ text: `${who.map(name).join(" and ")} ${who.length === 2 ? "both" : "all"} claim ${ROLES[role].name}. There is only one.`, seat: first, round: 0 });
      for (const c of councils(v)) {
        for (const [i, m] of c.moves) {
          const claims = (m.kind === "claim" && m.role === role) || (role === "seer" && m.kind === "report");
          if (who.includes(i) && claims) flags[`${i}-${c.round}`] = { text: `${who.length} players claim ${ROLES[role].name}`, seat: i, round: c.round };
        }
      }
    }
  }
  for (const c of councils(v)) {
    const r = c.round;
    for (const [i, m] of c.moves) {
      const t = m.target;
      if (m.kind === "report" && t != null && rev[t] && (rev[t] === "wolf") !== !!m.wolf) {
        add({ text: `${name(i)} saw ${name(t)}: ${m.wolf ? "WOLF" : "not wolf"} (day ${r}). The keeper revealed ${name(t)} as ${ROLES[rev[t]].name}.`, seat: i, round: r });
      }
      if (m.kind === "claim" && m.role && rev[i] && rev[i] !== m.role) {
        add({ text: `${name(i)} claimed ${ROLES[m.role].name} (day ${r}). Revealed as ${ROLES[rev[i]].name}.`, seat: i, round: r });
      }
      if (m.kind === "vouch" && t != null && rev[t] === "wolf") {
        add({ text: rev[i] === "wolf" ? `${name(i)} vouched for packmate ${name(t)} (day ${r}).` : `${name(i)} vouched for ${name(t)} (day ${r}), a revealed wolf.`, soft: true, seat: i, round: r });
      }
      if (m.kind === "accuse" && t != null && rev[t] && rev[t] !== "wolf" && rev[i] === "wolf") {
        add({ text: `${name(i)}, a wolf, accused ${name(t)} (day ${r}).`, soft: true, seat: i, round: r });
      }
    }
  }
  return { list, flags };
}

/** Has this seat already chosen this phase? */
export const hasChosen = (v: GameView) => v.mine != null;

/** Every legal move for this seat now, from its own view (empty when it has nothing to do). */
export function legalMoves(v: GameView): Move[] {
  const me = v.you;
  if (me == null || !v.seats[me]?.alive || hasChosen(v)) return [];
  const living = alive(v);
  const others = living.filter((i) => i !== me);
  switch (v.phase) {
    case "night": {
      if (v.role === "villager") return [{ move: "night" }];
      let targets = others;
      if (v.role === "wolf") targets = living.filter((i) => v.seats[i].role !== "wolf");
      if (v.role === "healer") targets = living.filter((i) => i !== v.last_heal);
      return [...targets.map((t) => ({ move: "night", target: t }) as Move), { move: "night" }];
    }
    case "council": {
      const out: Move[] = [{ move: "council", kind: "silent", line: "" }];
      for (const role of ["seer", "healer", "villager"] as Role[]) out.push({ move: "council", kind: "claim", role, line: "" });
      for (const t of others) {
        out.push({ move: "council", kind: "accuse", target: t, line: "" });
        out.push({ move: "council", kind: "vouch", target: t, line: "" });
        out.push({ move: "council", kind: "report", target: t, wolf: true, line: "" });
        out.push({ move: "council", kind: "report", target: t, wolf: false, line: "" });
      }
      return out;
    }
    case "pyre":
      return [...others.map((t) => ({ move: "vote", target: t }) as Move), { move: "vote", target: null }];
    default:
      return [];
  }
}

/** Suspicion of every living seat from the public record, plus this seat's own knowledge. */
export function suspicion(v: GameView): Record<number, number> {
  const score: Record<number, number> = {};
  for (const i of alive(v)) score[i] = 0;
  const rev = revealed(v);
  const liar = (i: number) => (score[i] = (score[i] ?? 0) + 6);
  for (const c of councils(v)) {
    for (const [i, m] of c.moves) {
      const t = m.target;
      if (t == null && m.kind !== "claim") continue;
      if (m.kind === "accuse" && t != null) score[t] = (score[t] ?? 0) + 2;
      if (m.kind === "report" && t != null) {
        score[t] = (score[t] ?? 0) + (m.wolf ? 3 : -2);
        if (rev[t] && (rev[t] === "wolf") !== !!m.wolf) liar(i);
      }
      if (m.kind === "vouch" && t != null) {
        score[t] = (score[t] ?? 0) - 1;
        if (rev[t] === "wolf") liar(i);
      }
      if (m.kind === "claim" && m.role && rev[i] && rev[i] !== m.role) liar(i);
    }
  }
  for (const l of v.looks ?? []) score[l.target] = (score[l.target] ?? 0) + (l.wolf ? 50 : -50);
  for (const k of Object.keys(score)) if (!v.seats[+k]?.alive) delete score[+k];
  return score;
}

const ACCUSE = ["Too quiet, too careful. That's a wolf's habit.", "Their story changes every time I hear it.", "Every vote they cast lands where the wolves want it.", "Ask them where they were when the howling started."];
const VOUCH = ["Their hands are clean. Look elsewhere.", "They spoke true yesterday. Leave them be."];

/** A scripted legal move: what the page's CPU seats, and an AI actor without a model, play. */
export function scriptedMove(v: GameView, rng: () => number): Move | null {
  const legal = legalMoves(v);
  if (!legal.length) return null;
  const me = v.you!;
  const any = <T>(xs: T[]) => xs[Math.floor(rng() * xs.length)];
  const score = suspicion(v);
  const wolf = v.role === "wolf";
  const ranked = Object.entries(score)
    .map(([k, s]) => [+k, s] as const)
    .filter(([k]) => k !== me && !(wolf && v.seats[k].role === "wolf"))
    .sort((a, b) => b[1] - a[1]);
  const top = ranked.length && ranked[0][1] > 0 ? ranked[0][0] : null;
  if (v.phase === "night") {
    const targeted = legal.filter((m): m is Extract<Move, { move: "night" }> => m.move === "night" && m.target != null);
    if (!targeted.length) return legal[0];
    if (wolf) {
      const lead = v.pack?.find((p) => p.target != null);
      if (lead) return { move: "night", target: lead.target };
    }
    if (v.role === "seer") {
      const seen = new Set((v.looks ?? []).map((l) => l.target));
      const fresh = targeted.filter((m) => !seen.has(m.target!));
      return any(fresh.length ? fresh : targeted);
    }
    return any(targeted);
  }
  if (v.phase === "council") {
    if (v.role === "seer") {
      const look = [...(v.looks ?? [])].reverse().find((l) => v.seats[l.target]?.alive);
      if (look) return { move: "council", kind: "report", target: look.target, wolf: look.wolf, line: look.wolf ? "The moon showed me the truth. Wolf." : "The moon showed me a clean soul." };
    }
    if (wolf && rng() < 0.25) {
      const mark = any(alive(v).filter((i) => i !== me && v.seats[i].role !== "wolf"));
      if (mark != null) return { move: "council", kind: "report", target: mark, wolf: true, line: "I am the Seer. The moon named them. Wolf." };
    }
    const r = rng();
    if (top != null && r < 0.7) return { move: "council", kind: "accuse", target: top, line: any(ACCUSE) };
    const others = alive(v).filter((i) => i !== me && !(wolf && v.seats[i].role === "wolf"));
    if (others.length && r < 0.5) return { move: "council", kind: "accuse", target: any(others), line: any(ACCUSE) };
    if (others.length && r < 0.75) return { move: "council", kind: "vouch", target: any(alive(v).filter((i) => i !== me)), line: any(VOUCH) };
    return { move: "council", kind: "silent", line: "I'll listen today." };
  }
  if (v.phase === "pyre") {
    if (top != null) return { move: "vote", target: top };
    const pool = ranked.map(([k]) => k);
    return rng() < 0.3 || !pool.length ? { move: "vote", target: null } : { move: "vote", target: any(pool) };
  }
  return legal[0];
}

/** How a speech reads in one line ("Accuses Wren"). */
export function speechText(m: Speech, name: (seat: number) => string): string {
  switch (m.kind) {
    case "claim":
      return `Claims ${m.role ? ROLES[m.role].name : "?"}`;
    case "report":
      return `Saw ${m.target != null ? name(m.target) : "?"}: ${m.wolf ? "WOLF" : "not wolf"}`;
    case "accuse":
      return `Accuses ${m.target != null ? name(m.target) : "?"}`;
    case "vouch":
      return `Vouches ${m.target != null ? name(m.target) : "?"}`;
    default:
      return "Silent";
  }
}
