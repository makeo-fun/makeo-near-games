// Hold'em, shared by the page (client/) and the AI actor (actor.ts): the rules' hand view as
// TypeScript, card names, the legal moves open to a seat, a scripted CPU and the AI prompt.
// Pure: no DOM, no network. The Rust rules decide everything; this only reads their view.

export type Card = number; // suit * 13 + rank; rank 0 = two .. 12 = ace; suit 0 c, 1 d, 2 h, 3 s
export type Street = "Preflop" | "Flop" | "Turn" | "River" | "Showdown" | "Folded";
export type Did = { act: string; to: number };
export type Pot = { amount: number; eligible: number[]; winners: number[] };
export type Showdown = { shown: boolean[]; names: (string | null)[]; best: (Card[] | null)[]; pots: Pot[] };
export type Opening = { card: Card; salt: string };
export type Options = { player: number; check: boolean; call: number; raise: { min_to: number; max_to: number } | null; allin: number };

/** The sit-and-go around the hands (rules/src/sitgo.rs `view`). */
export type SitGoView = {
  players: string[];
  chips: number[];
  hands: number;
  max_hands: number;
  button: number;
  seats: number[];
  hand: HandView | null;
  next_deal_ms: number;
  busted: (number | null)[];
  blinds: [number, number];
  next_blinds: [number, number];
  hands_per_level: number;
  finished: boolean;
  winners: string[];
  shares: number[];
  seq: number;
  state?: unknown;
};

/** The rules' `view` of a hand (rules/src/lib.rs `view`), field for field. */
export type HandView = {
  players: { wallet: string; stack: number }[];
  button: number;
  sb: number;
  bb: number;
  big_blind: number;
  street: Street;
  board: Card[];
  board_names: string[];
  hole: ([Card, Card] | null)[];
  hole_names: ([string, string] | null)[];
  commitments: { domain: string; hole: [string, string][]; board: string[] };
  openings: { hole: (Opening[] | null)[]; board: Opening[] };
  committed: number[];
  street_bet: number[];
  left: number[];
  folded: boolean[];
  all_in: boolean[];
  last: (Did | null)[];
  pot: number;
  current_bet: number;
  min_raise: number;
  turn: number | null;
  deadline_ms: number;
  options: Options | null;
  showdown: Showdown | null;
  won: number[] | null;
  result: number[] | null;
  seq: number;
};

/** Exactly the rules' `Move`. */
export type Move = { move: "fold" } | { move: "check" } | { move: "call" } | { move: "raise"; to: number } | { move: "allin" };

const RANKS = "23456789TJQKA";
const SUITS = "cdhs";
export const rankOf = (c: Card) => c % 13;
export const suitOf = (c: Card) => Math.floor(c / 13);
export const cardName = (c: Card) => RANKS[rankOf(c)] + SUITS[suitOf(c)];
export const SUIT_GLYPH = ["♣", "♦", "♥", "♠"];
export const RANK_LABEL = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const RANK_WORD = ["Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Jack", "Queen", "King", "Ace"];
const SUIT_WORD = ["clubs", "diamonds", "hearts", "spades"];
export const cardWords = (c: Card) => `${RANK_WORD[rankOf(c)]} of ${SUIT_WORD[suitOf(c)]}`;

/** The hand inside whatever view a seat gets: a table view (`hand.game`) or the hand itself. */
export function handOf(view: unknown): HandView | null {
  const v = view as any;
  if (!v || typeof v !== "object") return null;
  if (v.hand && v.hand.game && Array.isArray(v.hand.game.players)) return v.hand.game as HandView;
  if (v.game && v.game.hand && v.game.hand.game) return v.game.hand.game as HandView;
  // A sit-and-go: the contest view's `game.hand`, or the rules' view itself.
  if (v.game && v.game.hand && Array.isArray(v.game.hand.players)) return v.game.hand as HandView;
  if (v.hand && Array.isArray(v.hand.players) && typeof v.hand.street === "string") return v.hand as HandView;
  if (Array.isArray(v.players) && typeof v.street === "string") return v as HandView;
  return null;
}

/** Which player of the hand `wallet` is, or (with no wallet) the only seat whose cards this view shows. */
export function seatOf(hand: HandView, wallet?: string | null): number | null {
  if (wallet) {
    const i = hand.players.findIndex((p) => p.wallet.toLowerCase() === wallet.toLowerCase());
    if (i >= 0) return i;
  }
  if (hand.showdown) return null;
  const seen = hand.hole.map((h, i) => (h ? i : -1)).filter((i) => i >= 0);
  return seen.length === 1 ? seen[0] : null;
}

export const isBetting = (hand: HandView) => hand.street === "Preflop" || hand.street === "Flop" || hand.street === "Turn" || hand.street === "River";

/** Every move open to `me` now (raises at a few sensible sizes), or none when it isn't their turn. */
export function legalMoves(hand: HandView, me: number | null): Move[] {
  const o = hand.options;
  if (!o || me === null || o.player !== me || !isBetting(hand)) return [];
  const moves: Move[] = [];
  if (o.check) moves.push({ move: "check" });
  else {
    moves.push({ move: "fold" });
    moves.push({ move: "call" });
  }
  if (o.raise) {
    const { min_to, max_to } = o.raise;
    const potAfterCall = hand.pot + o.call;
    const sizes = new Set<number>([min_to]);
    for (const frac of [0.5, 0.75, 1]) {
      const to = hand.current_bet + Math.round(potAfterCall * frac);
      if (to > min_to && to < max_to) sizes.add(to);
    }
    for (const to of [...sizes].sort((a, b) => a - b)) if (to < max_to) moves.push({ move: "raise", to });
  }
  if (o.allin > 0 && (o.raise || o.allin <= o.call)) moves.push({ move: "allin" });
  return moves;
}

/** Plain words for a move, as the table and the prompt say it. */
export function moveWords(m: Move, hand: HandView): string {
  switch (m.move) {
    case "fold": return "Fold";
    case "check": return "Check";
    case "call": return `Call ${hand.options?.call ?? ""}`.trim();
    case "raise": return hand.current_bet === 0 ? `Bet ${m.to}` : `Raise to ${m.to}`;
    case "allin": return `All in (${hand.options?.allin ?? ""})`;
  }
}

/** Reads a model's answer into one of `legal`: `{"move": "call"}`, `{"move": {"move": "raise", "to": 12}}`,
 * `{"move": "raise", "to": 12}` or `{"action": "raise", "amount": 12}`. A raise between the legal sizes is kept
 * as asked when the rules allow it. Null when nothing legal matches. */
export function parseMoveFrom(json: unknown, legal: Move[], hand?: HandView | null): Move | null {
  if (!legal.length || !json || typeof json !== "object") return null;
  const j = json as any;
  let m: any = j.move ?? j.action ?? j;
  if (typeof m === "string") m = { move: m, to: j.to ?? j.amount };
  if (!m || typeof m !== "object") return null;
  let kind = String(m.move ?? m.action ?? "").toLowerCase().replace(/[\s_-]/g, "");
  if (kind === "bet") kind = "raise";
  if (kind === "allin" || kind === "shove" || kind === "jam") return legal.find((x) => x.move === "allin") ?? null;
  if (kind === "raise") {
    const to = Number(m.to ?? m.amount);
    const range = hand?.options?.raise;
    if (range && Number.isInteger(to) && to >= range.min_to && to <= range.max_to) {
      return to === range.max_to ? (legal.find((x) => x.move === "allin") ?? { move: "raise", to }) : { move: "raise", to };
    }
    const raises = legal.filter((x): x is { move: "raise"; to: number } => x.move === "raise");
    if (!raises.length) return null;
    if (!Number.isFinite(to)) return raises[0];
    return raises.reduce((a, b) => (Math.abs(b.to - to) < Math.abs(a.to - to) ? b : a));
  }
  if (kind === "check" && !legal.some((x) => x.move === "check") && legal.some((x) => x.move === "call")) return null;
  return legal.find((x) => x.move === kind) ?? null;
}

// ------------------------------------------------------------------ a scripted player

/** A quick hand category: 8 straight flush .. 0 high card (the rules alone judge the showdown). */
export function category(cards: Card[]): number {
  const ranks = cards.map(rankOf);
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts.values()].sort((a, b) => b - a);
  const bySuit = [0, 1, 2, 3].map((s) => cards.filter((c) => suitOf(c) === s));
  const straightIn = (rs: number[]) => {
    const set = new Set(rs);
    if (set.has(12)) set.add(-1);
    for (let hi = 12; hi >= 3; hi--) if ([0, 1, 2, 3, 4].every((k) => set.has(hi - k))) return true;
    return false;
  };
  const flushSuit = bySuit.find((s) => s.length >= 5);
  if (flushSuit && straightIn(flushSuit.map(rankOf))) return 8;
  if (groups[0] >= 4) return 7;
  if (groups[0] >= 3 && groups[1] >= 2) return 6;
  if (flushSuit) return 5;
  if (straightIn(ranks)) return 4;
  if (groups[0] >= 3) return 3;
  if (groups[0] >= 2 && groups[1] >= 2) return 2;
  if (groups[0] >= 2) return 1;
  return 0;
}

/** Roughly how good two hole cards are before the flop, 0..1. */
export function preflopStrength([a, b]: [Card, Card]): number {
  const hi = Math.max(rankOf(a), rankOf(b));
  const lo = Math.min(rankOf(a), rankOf(b));
  let s = (hi + lo) / 24;
  if (hi === lo) s = 0.55 + lo / 26;
  if (suitOf(a) === suitOf(b)) s += 0.06;
  if (hi - lo === 1) s += 0.04;
  if (hi - lo > 4 && hi !== lo) s -= 0.06;
  return Math.max(0, Math.min(1, s));
}

/** How strong `me`'s hand is now, 0..1, and whether it is drawing to something big. */
export function strength(hand: HandView, me: number): { now: number; draw: boolean } {
  const hole = hand.hole[me];
  if (!hole) return { now: 0, draw: false };
  if (hand.board.length === 0) return { now: preflopStrength(hole), draw: false };
  const mine = category([...hole, ...hand.board]);
  const boardOnly = hand.board.length >= 5 ? category(hand.board) : -1;
  // A made hand the board alone already has is worth little.
  let now = mine <= boardOnly ? 0.15 : [0.12, 0.42, 0.62, 0.74, 0.82, 0.88, 0.94, 0.98, 1][mine];
  if (mine === 1) {
    const top = Math.max(...hand.board.map(rankOf));
    const paired = hole.some((c) => rankOf(c) >= top && hand.board.some((b) => rankOf(b) === rankOf(c)));
    if (paired || rankOf(hole[0]) === rankOf(hole[1])) now += 0.12;
  }
  const all = [...hole, ...hand.board];
  const flushDraw = [0, 1, 2, 3].some((s) => all.filter((c) => suitOf(c) === s).length === 4);
  return { now, draw: flushDraw && hand.board.length < 5 };
}

/** A scripted player: plays by hand strength and pot odds, with a little bluffing. */
export function scriptedMove(hand: HandView, me: number, rng: () => number, style: { aggression?: number; looseness?: number } = {}): Move | null {
  const legal = legalMoves(hand, me);
  if (!legal.length) return null;
  const o = hand.options!;
  const aggression = style.aggression ?? 0.5;
  const looseness = style.looseness ?? 0.5;
  const { now, draw } = strength(hand, me);
  const potOdds = o.call / Math.max(1, hand.pot + o.call);
  const raises = legal.filter((m): m is { move: "raise"; to: number } => m.move === "raise");
  const pickRaise = () => raises[Math.min(raises.length - 1, Math.floor(rng() * raises.length * (0.5 + aggression)))] ?? raises[0];
  const roll = rng();
  // Monsters raise; strong hands raise sometimes and call otherwise.
  if (now > 0.85 && raises.length && roll < 0.55 + aggression * 0.4) return pickRaise();
  if (now > 0.85 && legal.some((m) => m.move === "allin") && !raises.length) return { move: "allin" };
  if (now > 0.62 && raises.length && roll < 0.2 + aggression * 0.4) return pickRaise();
  if (o.check) {
    if (raises.length && (roll < 0.06 + aggression * 0.1 || (draw && roll < 0.3))) return raises[0];
    return { move: "check" };
  }
  const want = now + (draw ? 0.18 : 0) + (looseness - 0.5) * 0.2;
  if (want > potOdds + 0.18 || (o.call <= hand.big_blind && want > 0.25)) return { move: "call" };
  if (roll < 0.04 * aggression && raises.length) return pickRaise();
  return { move: "fold" };
}

// ------------------------------------------------------------------ what an AI seat is told

const streetWords: Record<Street, string> = { Preflop: "preflop", Flop: "the flop", Turn: "the turn", River: "the river", Showdown: "showdown", Folded: "over" };

/** The situation in words, from `me`'s own view only: their two cards, the public board and the betting. */
export function describeSituation(hand: HandView, me: number, names: (i: number) => string = (i) => `Seat ${i + 1}`): string {
  const n = hand.players.length;
  const hole = hand.hole[me];
  const lines: string[] = [];
  lines.push(`No-Limit Texas Hold'em, ${n} players, blinds ${Math.max(1, Math.floor(hand.big_blind / 2))}/${hand.big_blind}. It is ${streetWords[hand.street]}.`);
  lines.push(`Your cards: ${hole ? hole.map((c) => `${cardName(c)} (${cardWords(c)})`).join(", ") : "unknown"}.`);
  lines.push(`Board: ${hand.board.length ? hand.board.map(cardName).join(" ") : "no cards yet"}.`);
  lines.push(`Pot: ${hand.pot}. Bet to match on this street: ${hand.current_bet}.`);
  lines.push("Players (in seat order):");
  for (let i = 0; i < n; i++) {
    const tags = [i === hand.button ? "button" : "", i === hand.sb ? "small blind" : "", i === hand.bb ? "big blind" : "", i === me ? "YOU" : ""].filter(Boolean).join(", ");
    const state = hand.folded[i] ? "folded" : hand.all_in[i] ? "all in" : `${hand.left[i]} chips behind`;
    const last = hand.last[i] ? `, last: ${hand.last[i]!.act}${hand.last[i]!.to ? " " + hand.last[i]!.to : ""}` : "";
    lines.push(`- ${names(i)}${tags ? ` (${tags})` : ""}: ${state}, ${hand.street_bet[i]} in this street, ${hand.committed[i]} in the pot${last}`);
  }
  const o = hand.options;
  if (o && o.player === me) {
    lines.push(o.check ? "Nothing to call: you may check." : `To call: ${o.call}.`);
    if (o.raise) lines.push(`You may raise to any total between ${o.raise.min_to} and ${o.raise.max_to} on this street (${o.raise.max_to} is all in).`);
    else lines.push("You may not raise.");
  }
  return lines.join("\n");
}
