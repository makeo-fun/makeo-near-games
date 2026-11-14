// NEARWOLF's AI actor (SPEC.md "AI actor protocol"). The runner in actors/ fetches this seat's own
// sealed view from the keeper, builds the prompt here, asks NEAR AI Cloud for a JSON answer,
// verifies its TEE signature and plays the move parseMove returns (or `fallback`).
//
// The prompt carries only what this seat may know: its own view (its role; a wolf's pack and
// their picks; the Seer's own visions; the Healer's last protection) and the public record.
// Types and the answer contract come from actors/ (the agent-actors stream).
import {
  type GameView,
  type Entry,
  type Move,
  type Role,
  PERSONAS,
  ROLES,
  LINE_MAX,
  alive,
  contradictions,
  legalMoves as legal,
  persona as personaOf,
  scriptedMove,
  speechText,
} from "./shared/nearwolf.ts";
import { personaPreamble } from "../../actors/src/personas";
import type { GameActor, Persona } from "../../actors/src/types";

/** The room's view is the contest's; the rules' view for this seat is its `game`. Accept either. */
type AnyView = GameView | { game: GameView | null };
const game = (v: AnyView): GameView | null => ("seats" in v ? v : v.game);

export const persona: Persona[] = PERSONAS.map((p) => ({
  id: p.name.toLowerCase(),
  name: p.name,
  voice: p.voice,
  style: p.style,
  avatar: p.color,
}));

export function legalMoves(view: AnyView): Move[] {
  const v = game(view);
  return v ? legal(v) : [];
}

export function round(view: AnyView): number {
  return game(view)?.round ?? 0;
}

const RULES = `NEARWOLF is werewolf around one fire. Some seats are people, some are AI; every seat looks the same.
Roles (dealt secretly by an attested keeper): wolves (about a quarter of the table), one Seer (5+ seats), one Healer (6+ seats), villagers.
Each round:
1. Moonrise: wolves pick a victim (the pack's most-picked seat), the Seer looks at one seat and learns only "wolf" or "not wolf", the Healer protects one seat (never the same seat two nights running). Villagers sleep.
2. Dawn: the victim dies unless the Healer protected them; their role is shown to everyone.
3. Council: everyone alive makes ONE move at the same time, unseen until all are revealed together: claim a role, report a vision ("I saw X: wolf / not wolf"), accuse someone, vouch for someone, or stay silent, plus one short line.
4. Pyre: everyone alive votes for one seat to burn, or abstains. The most votes burns (a tie burns nobody) and the burned seat's role is shown.
The village wins when no wolves are left. The wolves win when they are as many as everyone else alive.
Anyone may lie at the council. Wolves usually must. The record shows contradictions once roles are revealed.`;

function teamGoal(role: Role | null): string {
  if (role === "wolf") return "You are a WOLF. Win with your pack: kill the Seer and Healer if you can find them, never reveal yourself, and lie freely at the council (claiming Seer and naming a villager is a classic play). Don't vote for your packmates unless it saves you.";
  if (role === "seer") return "You are the SEER. Your visions are true. Decide when to reveal them: too early and the wolves kill you tonight; too late and the village burns the wrong seat.";
  if (role === "healer") return "You are the HEALER. Protect whoever the wolves most likely want dead (often a convincing Seer, or yourself). You may not protect the same seat two nights running.";
  return "You are a VILLAGER. You have no night power. Read the record, find the liars and burn the wolves.";
}

function describeLog(v: GameView, log: Entry[], name: (i: number) => string): string[] {
  const lines: string[] = [];
  for (const e of log) {
    if (e.kind === "dawn") lines.push(e.died == null ? `Dawn ${e.round}: everyone woke (the Healer saved the wolves' victim, or the wolves held back).` : `Dawn ${e.round}: ${name(e.died)} did not wake. Role: ${ROLES[e.role!].name}.`);
    if (e.kind === "council") lines.push(`Council ${e.round}: ` + e.moves.map(([i, m]) => `${name(i)} [seat ${i}] ${speechText(m, (t) => `${name(t)} [seat ${t}]`)}${m.line ? ` ("${m.line}")` : ""}`).join("; "));
    if (e.kind === "pyre") {
      const votes = e.votes.map(([i, t]) => `${name(i)}→${t == null ? "abstain" : name(t)}`).join(", ");
      lines.push(`Pyre ${e.round}: votes ${votes}. ${e.burned == null ? "A tie or no votes: nobody burned." : `${name(e.burned)} burned. Role: ${ROLES[e.role!].name}.`}`);
    }
  }
  return lines;
}

export function prompt(view: AnyView, publicLog: Entry[] | unknown[], who: Persona): { system: string; user: string } {
  const v = game(view);
  if (!v) return { system: RULES, user: "{}" };
  const me = v.you!;
  const name = (i: number) => (i === me ? `${personaOf(v, i).name} (you)` : personaOf(v, i).name);
  const log = (Array.isArray(publicLog) && publicLog.length ? publicLog : v.log) as Entry[];
  const moves = legal(v);
  const facts: string[] = [`You sit in seat ${me}. It is round ${v.round}, phase: ${v.phase}.`, teamGoal(v.role)];
  if (v.role === "wolf") {
    const pack = v.seats.filter((s) => s.role === "wolf" && s.seat !== me).map((s) => `${name(s.seat)} [seat ${s.seat}]${s.alive ? "" : " (dead)"}`);
    facts.push(pack.length ? `Your pack: ${pack.join(", ")}.` : "You hunt alone.");
    for (const p of v.pack ?? []) if (p.target != null) facts.push(`Tonight ${name(p.seat)} picked ${name(p.target)} [seat ${p.target}]. Agree on one victim: the pack's most-picked seat dies.`);
  }
  if (v.role === "seer") for (const l of v.looks ?? []) facts.push(`Your vision, night ${l.round}: ${name(l.target)} [seat ${l.target}] is ${l.wolf ? "a WOLF" : "NOT a wolf"}.`);
  if (v.role === "healer" && v.last_heal != null) facts.push(`Last night you protected ${name(v.last_heal)} [seat ${v.last_heal}]: you can't protect them tonight.`);
  const { list } = contradictions(v, name);
  const ask =
    v.phase === "night"
      ? v.role === "villager"
        ? 'Villagers sleep: answer {"move": {"move": "night"}}.'
        : `Choose your night target: {"move": {"move": "night", "target": <seat>}}.`
      : v.phase === "council"
        ? `Make your one council move. Shapes: {"move":"council","kind":"claim","role":"seer|healer|villager","line":"..."}, {"move":"council","kind":"report","target":<seat>,"wolf":true|false,"line":"..."}, {"move":"council","kind":"accuse"|"vouch","target":<seat>,"line":"..."}, {"move":"council","kind":"silent","line":"..."}. The line is public, in character, under ${LINE_MAX} characters.`
        : v.phase === "pyre"
          ? `Vote: {"move": {"move": "vote", "target": <seat or null to abstain>}}.`
          : "Nothing to do now.";
  const seats = v.seats.map((s) => ({
    seat: s.seat,
    name: name(s.seat),
    alive: s.alive,
    role_known_to_you: s.role ? ROLES[s.role].name : null,
  }));
  const system = [
    // The seat's own name: the table only knows this seat as its persona (no other name exists here).
    personaPreamble({ ...who, name: personaOf(v, me).name }, "NEARWOLF"),
    `You are ${personaOf(v, me).name}, ${personaOf(v, me).trade}, seat ${me}. Speak as ${personaOf(v, me).name} only; never mention another name for yourself, and never say you are an AI. Refer to others by their table names.`,
    RULES,
    `Your "move" must be exactly one of legal_moves (fill in "line" for a council move). "reasoning" is your private confessional: it stays sealed until the game ends, then everyone reads it. Wolves may lie in "say" and "line", never in "reasoning".`,
  ].join("\n\n");
  const user = JSON.stringify(
    {
      you: { seat: me, role: v.role ? ROLES[v.role].name : null, alive: v.seats[me]?.alive },
      what_you_know: facts,
      seats,
      alive: alive(v),
      public_record: describeLog(v, log, name),
      contradictions_on_record: list.map((c) => c.text),
      task: ask,
      legal_moves: moves.length > 40 ? moves.filter((m) => m.move !== "council" || m.kind !== "vouch") : moves,
    },
    null,
    1,
  );
  return { system, user };
}

const lineOf = (x: unknown) => (typeof x === "string" ? x.replace(/\s+/g, " ").trim().slice(0, LINE_MAX) : "");

/** The model's whole JSON answer; null makes the runner play `fallback`. */
export function parseMove(json: unknown, legalList: Move[]): Move | null {
  const answer = (json && typeof json === "object" ? json : { move: json }) as { move?: unknown; say?: unknown } | null;
  let m = (answer && "move" in answer ? answer.move : answer) as Record<string, unknown> | undefined;
  // A bare move at the top level ({"move":"vote","target":3,...}) or a bare seat number.
  if (typeof m === "string" && ["night", "council", "vote"].includes(m)) m = answer as Record<string, unknown>;
  if (typeof m === "number" || (typeof m === "string" && /^\d+$/.test(m))) {
    const t = Number(m);
    return legalList.find((x) => (x.move === "night" || x.move === "vote") && x.target === t) ?? null;
  }
  if (typeof m === "string") {
    try {
      m = JSON.parse(m);
    } catch {
      return null;
    }
  }
  if (!m || typeof m !== "object") return null;
  // An object that names only a phase-free choice: infer the phase from what is legal now.
  if (m.move == null && legalList.length) m = { ...m, move: legalList[0].move };
  const num = (x: unknown) => (x == null ? null : Number.isInteger(Number(x)) ? Number(x) : NaN);
  const kind = m.move;
  if (kind === "night") {
    const t = num(m.target);
    return legalList.find((x) => x.move === "night" && (x.target ?? null) === t) ?? null;
  }
  if (kind === "vote") {
    const t = num(m.target);
    return legalList.find((x) => x.move === "vote" && x.target === t) ?? null;
  }
  if (kind === "council") {
    const line = lineOf(m.line) || lineOf(answer?.say);
    const t = num(m.target);
    const found = legalList.find(
      (x) =>
        x.move === "council" &&
        x.kind === m.kind &&
        (x.kind !== "claim" || x.role === m.role) &&
        (x.target ?? null) === (["accuse", "vouch", "report"].includes(String(m.kind)) ? t : null) &&
        (x.kind !== "report" || x.wolf === Boolean(m.wolf)),
    );
    return found ? ({ ...found, line } as Move) : null;
  }
  return null;
}

/** A scripted move when the model is off or wrong: plays from the same view, never peeks. */
export function fallback(view: AnyView, legalList: Move[], _persona: Persona): Move {
  const v = game(view);
  return (v && scriptedMove(v, Math.random)) ?? legalList[0];
}

const actor: GameActor<AnyView, Move, Entry> = { persona, legalMoves, prompt, parseMove, round, fallback };
export default actor;
