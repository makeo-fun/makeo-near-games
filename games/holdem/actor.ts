// NEAR Hold'em's AI seats (SPEC.md, "AI actor protocol"). The runner in actors/ fetches this seat's
// own sealed view from the keeper, asks NEAR AI Cloud with `prompt`, checks the TEE signature and
// plays `parseMove`'s answer. The prompt holds only what the seat may see: its own two cards, the
// public board and the betting. Never another seat's cards (the view doesn't have them).
import type { GameActor, Persona, Prompt } from "../../actors/src/types";
import { personaPreamble } from "../../actors/src/personas";
import {
  describeActions,
  describeHistory,
  describeSituation,
  handOf,
  sitGoOf,
  isBetting,
  legalMoves as legalFor,
  moveWords,
  parseMoveFrom,
  scriptedMove,
  seatOf,
  type HandView,
  type Move,
} from "./shared/holdem";

/** One line of the table's public log the runner may pass along (who did what). */
export type HoldemEvent = { hand?: number; who?: string; text?: string; [key: string]: unknown };

/** What the runner hands us: the seat's own table view (or its hand), optionally with its wallet. */
export type SeatView = { wallet?: string; me?: string; [key: string]: unknown } | HandView;

export const persona: Persona[] = [
  {
    id: "vega",
    name: "Vega",
    voice: "cool, precise, speaks in odds and percentages",
    style: "tight-aggressive: few hands, raises them hard, folds to big bets without a strong hand",
    avatar: "star",
    lines: { thinking: ["Running the numbers."], raise: ["The math says raise."], fold: ["Not this one."] },
  },
  {
    id: "rook",
    name: "Rook",
    voice: "gravelly old card-room regular, dry humour",
    style: "loose-passive: calls a lot, rarely bluffs, slow-plays big hands",
    avatar: "rook",
    lines: { thinking: ["Let me look at these again."], call: ["I'll see that."], fold: ["Too rich for me."] },
  },
  {
    id: "juno",
    name: "Juno",
    voice: "bright, teasing, loves table talk",
    style: "loose-aggressive: plays many hands, bets when checked to, bluffs rivers",
    avatar: "spark",
    lines: { thinking: ["Ooh, decisions."], raise: ["Let's make it interesting."], fold: ["Fine, take it."] },
  },
  {
    id: "atlas",
    name: "Atlas",
    voice: "calm, polite, few words",
    style: "balanced: value bets strong hands, bluffs rarely, respects position",
    avatar: "mountain",
    lines: { thinking: ["Hm."], call: ["Call."], raise: ["Raise."] },
  },
  {
    id: "nyx",
    name: "Nyx",
    voice: "mysterious, quiet, a little ominous",
    style: "tricky: check-raises strong hands and draws, mixes in big bluffs",
    avatar: "moon",
    lines: { thinking: ["..."], raise: ["Are you sure?"], fold: ["Another time."] },
  },
];

const STYLE: Record<string, { aggression: number; looseness: number }> = {
  vega: { aggression: 0.75, looseness: 0.3 },
  rook: { aggression: 0.25, looseness: 0.8 },
  juno: { aggression: 0.85, looseness: 0.75 },
  atlas: { aggression: 0.5, looseness: 0.5 },
  nyx: { aggression: 0.65, looseness: 0.55 },
};

function walletOf(view: SeatView): string | null {
  const v = view as any;
  return typeof v?.wallet === "string" ? v.wallet : typeof v?.me === "string" ? v.me : null;
}

function situation(view: SeatView): { hand: HandView; me: number } | null {
  const hand = handOf(view);
  if (!hand) return null;
  const me = seatOf(hand, walletOf(view));
  return me === null ? null : { hand, me };
}

/** The moves open to this seat now, from its own view. Empty when it is not this seat's turn. */
export function legalMoves(view: SeatView): Move[] {
  const s = situation(view);
  return s ? legalFor(s.hand, s.me) : [];
}

/** The hand number, for receipts. */
export function round(view: SeatView): number {
  const v = view as any;
  return Number(v?.hand?.id ?? v?.game?.hands ?? v?.hands ?? 0) || 0;
}

export function prompt(view: SeatView, publicLog: HoldemEvent[], who: Persona): Prompt {
  const s = situation(view);
  const legal = s ? legalFor(s.hand, s.me) : [];
  const g = sitGoOf(view);
  // Players are named by their table seat (stable across hands); this seat is "you".
  const seatOfPlayer = (i: number) => (g ? g.seats[i] ?? i : i);
  const mySeat = s ? seatOfPlayer(s.me) : -1;
  const seatName = (seat: number) => (seat === mySeat ? `${who.name} (you)` : `Seat ${seat + 1}`);
  const names = (i: number) => seatName(seatOfPlayer(i));
  const parts: string[] = [];
  if (g) {
    const stacks = g.players.map((_, seat) => `${seatName(seat)} ${g.chips[seat]}${g.chips[seat] === 0 && g.busted[seat] ? " (out)" : ""}`).join(", ");
    parts.push(`Sit-and-go, hand ${g.hands} of up to ${g.max_hands}; blinds ${g.blinds[0]}/${g.blinds[1]} (next ${g.next_blinds[0]}/${g.next_blinds[1]}). Stacks at the start of this hand: ${stacks}.`);
  }
  if (s) {
    parts.push(describeSituation(s.hand, s.me, names));
    const acts = describeActions(s.hand, names);
    if (acts.length) parts.push(`This hand so far:\n${acts.join("\n")}`);
  } else parts.push("The hand is not in play.");
  const history = g?.history ?? [];
  if (history.length) parts.push(`Earlier hands (oldest first):\n${describeHistory(history, seatName).join("\n")}`);
  // A runner without the sit-and-go view still passes its own public log.
  if (!g && publicLog.length) {
    const recent = publicLog.slice(-12).map((e) => (typeof e === "string" ? e : e.text ?? JSON.stringify(e))).filter(Boolean);
    if (recent.length) parts.push(`Recent table log:\n${recent.map((l) => `- ${l}`).join("\n")}`);
  }
  parts.push(`Legal moves (pick one):\n${legal.map((m) => `- ${JSON.stringify(m)}  (${s ? moveWords(m, s.hand) : m.move})`).join("\n") || "- none"}`);
  const system = [
    personaPreamble(who, "No-Limit Texas Hold'em"),
    "Rules: standard No-Limit Hold'em. A raise names the TOTAL you put in on this street (raise to), not the amount added.",
    "You only know your own two cards, the public board, the betting and the hands shown down. Never claim to know anyone else's cards.",
    'Your "say" line must match the move you make (do not say "all in" unless your move is all in).',
    'The "move" field must be exactly one of the legal moves listed, copied as JSON, e.g. {"move":"call"} or {"move":"raise","to":12}.',
  ].join("\n");
  return { system, user: parts.join("\n\n") };
}

/** The model's JSON (`{"move": ..., "reasoning", "say"}`) into one of `legal`, or null. */
export function parseMove(json: unknown, legal: Move[]): Move | null {
  // The legal list carries every raise size we offered; a raise in between snaps to the nearest.
  return parseMoveFrom(json, legal, null);
}

/** Scripted play when the model is off or answers something illegal: hand strength and pot odds. */
export function fallback(view: SeatView, legal: Move[], who: Persona): Move {
  const s = situation(view);
  const move = s && isBetting(s.hand) ? scriptedMove(s.hand, s.me, Math.random, STYLE[who.id]) : null;
  if (move && legal.some((m) => JSON.stringify(m) === JSON.stringify(move))) return move;
  return legal.find((m) => m.move === "check") ?? legal.find((m) => m.move === "call") ?? legal[0];
}

export const actor: GameActor<SeatView, Move, HoldemEvent> = { persona, legalMoves, prompt, parseMove, round, fallback };
export default actor;
