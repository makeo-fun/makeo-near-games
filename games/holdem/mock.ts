// A local stand-in for NEAR Hold'em's rules, for the actors harness (actors/src/harness.ts) only:
// `bun actors/src/harness.ts --game games/holdem --ai 3`. It mirrors rules/src/lib.rs (blinds,
// no-limit betting with the min-raise rule, side pots, showdown) and produces views of the same
// shape, so actor.ts plays it exactly as it plays the real table. The real game is the Rust rules
// run by Makeo's keeper; nothing here decides a paid hand.
import { createHash } from "node:crypto";
import type { MockGame } from "../../actors/src/mock-room";
import type { Card, Did, HandView, Move, Pot, Street } from "./shared/holdem";
import { cardName } from "./shared/holdem";

const SB = 1;
const BB = 2;
const BUYIN = 100;
const HANDS = Number(process.env.HOLDEM_HANDS ?? 8);
const DOMAIN = "makeo:holdem:card:v1";

type Seat = { wallet: string; name: string };
type H = {
  id: number;
  players: { wallet: string; stack: number }[];
  button: number; sb: number; bb: number;
  hole: [Card, Card][]; board: Card[]; holeSalts: [string, string][]; boardSalts: string[];
  holeCommits: [string, string][]; boardCommits: string[];
  street: Street; dealt: number;
  committed: number[]; streetBet: number[]; folded: boolean[]; toAct: boolean[]; raiseOpen: boolean[];
  currentBet: number; minRaise: number; last: (Did | null)[]; turn: number | null; seq: number;
  showdown: HandView["showdown"]; won: number[] | null; result: number[] | null;
};
type State = { seats: Seat[]; stacks: number[]; button: number; hands: number; hand: H | null; log: string[]; ended?: H | null };

const commit = (card: Card, salt: string) => "0x" + createHash("sha256").update(JSON.stringify({ domain: DOMAIN, value: { card, salt } })).digest("hex");
const salt = (r: () => number) => Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16)).join("");

// ------------------------------------------------------------------ evaluator (as cards::best)

function score5(cs: Card[]): number {
  const ranks = cs.map((c) => c % 13).sort((a, b) => b - a);
  const flush = cs.every((c) => Math.floor(c / 13) === Math.floor(cs[0] / 13));
  const uniq = [...new Set(ranks)];
  let straightHi = -1;
  if (uniq.length === 5) {
    if (ranks[0] - ranks[4] === 4) straightHi = ranks[0];
    else if (ranks.join() === "12,3,2,1,0") straightHi = 3;
  }
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const order = groups.flatMap(([r, n]) => Array(n).fill(r));
  let cat: number;
  if (straightHi >= 0 && flush) cat = 8;
  else if (groups[0][1] === 4) cat = 7;
  else if (groups[0][1] === 3 && groups[1][1] === 2) cat = 6;
  else if (flush) cat = 5;
  else if (straightHi >= 0) cat = 4;
  else if (groups[0][1] === 3) cat = 3;
  else if (groups[0][1] === 2 && groups[1][1] === 2) cat = 2;
  else if (groups[0][1] === 2) cat = 1;
  else cat = 0;
  const kick = straightHi >= 0 ? [straightHi, 0, 0, 0, 0] : order;
  return kick.reduce((acc, r) => acc * 15 + r, cat);
}
function best(cards: Card[]): { score: number; five: Card[] } {
  let top = { score: -1, five: [] as Card[] };
  const n = cards.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    const five = cards.filter((_, i) => i !== a && i !== b);
    const s = score5(five);
    if (s > top.score) top = { score: s, five };
  }
  return top;
}
const CAT = ["High card", "Pair", "Two pair", "Three of a kind", "Straight", "Flush", "Full house", "Four of a kind", "Straight flush"];
const describe = (s: number) => CAT[Math.floor(s / 15 ** 5)];

function settle(committed: number[], scores: (number | null)[], button: number): number[] {
  const n = committed.length;
  const live = scores.map((s, i) => (s === null ? -1 : i)).filter((i) => i >= 0);
  const won = Array(n).fill(0);
  const total = committed.reduce((a, b) => a + b, 0);
  if (live.length === 1) {
    won[live[0]] = total;
    return won;
  }
  const order = Array.from({ length: n }, (_, k) => (button + 1 + k) % n);
  const levels = [...new Set(live.map((i) => committed[i]))].sort((a, b) => a - b);
  let prev = 0;
  for (const level of levels) {
    const pot = committed.reduce((a, c) => a + Math.min(c, level) - Math.min(c, prev), 0);
    const eligible = order.filter((i) => scores[i] !== null && committed[i] >= level);
    const top = Math.max(...eligible.map((i) => scores[i]!));
    const winners = eligible.filter((i) => scores[i] === top);
    const share = Math.floor(pot / winners.length);
    const odd = pot % winners.length;
    winners.forEach((w, k) => (won[w] += share + (k < odd ? 1 : 0)));
    prev = level;
  }
  for (let i = 0; i < n; i++) won[i] += Math.max(0, committed[i] - prev);
  return won;
}

// ------------------------------------------------------------------ the hand

const left = (h: H, i: number) => h.players[i].stack - h.committed[i];
const canAct = (h: H, i: number) => !h.folded[i] && left(h, i) > 0;
function needs(h: H, i: number) {
  if (!canAct(h, i) || !h.toAct[i]) return false;
  const others = h.players.filter((_, j) => j !== i && canAct(h, j)).length;
  return others > 0 || h.streetBet[i] < h.currentBet;
}
function put(h: H, i: number, amount: number) {
  const a = Math.min(amount, left(h, i));
  h.committed[i] += a;
  h.streetBet[i] += a;
}
function raiseRange(h: H, i: number): [number, number] | null {
  const owed = Math.max(0, h.currentBet - h.streetBet[i]);
  if (!h.raiseOpen[i] || left(h, i) <= owed) return null;
  const max = h.streetBet[i] + left(h, i);
  return [Math.min(h.currentBet + h.minRaise, max), max];
}
function finish(h: H, won: number[], street: Street) {
  h.won = won;
  h.result = won.map((w, i) => w - h.committed[i]);
  h.street = street;
  h.turn = null;
}
function progress(h: H, after: number) {
  const n = h.players.length;
  if (h.folded.filter((f) => !f).length === 1) return finish(h, settle(h.committed, h.folded.map((f) => (f ? null : 0)), h.button), "Folded");
  for (let k = 1; k <= n; k++) {
    const i = (after + k) % n;
    if (needs(h, i)) {
      h.turn = i;
      return;
    }
  }
  const acting = h.players.filter((_, i) => canAct(h, i)).length;
  if (acting <= 1 || h.street === "River") {
    h.dealt = 5;
    const scores = h.players.map((_, i) => (h.folded[i] ? null : best([...h.hole[i], ...h.board])));
    const s = scores.map((x) => (x ? x.score : null));
    const won = settle(h.committed, s, h.button);
    const levels = [...new Set(h.players.map((_, i) => i).filter((i) => s[i] !== null).map((i) => h.committed[i]))].sort((a, b) => a - b);
    const pots: Pot[] = [];
    let prev = 0;
    for (const level of levels) {
      const amount = h.committed.reduce((a, c) => a + Math.min(c, level) - Math.min(c, prev), 0);
      const eligible = h.players.map((_, i) => i).filter((i) => s[i] !== null && h.committed[i] >= level);
      const top = Math.max(...eligible.map((i) => s[i]!));
      if (amount > 0 && (eligible.length > 1 || !pots.length)) pots.push({ amount, eligible, winners: eligible.filter((i) => s[i] === top) });
      prev = level;
    }
    h.showdown = { shown: h.folded.map((f) => !f), names: scores.map((x) => (x ? describe(x.score) : null)), best: scores.map((x) => (x ? x.five : null)), pots };
    return finish(h, won, "Showdown");
  }
  h.street = h.street === "Preflop" ? "Flop" : h.street === "Flop" ? "Turn" : "River";
  h.dealt = h.street === "Flop" ? 3 : h.street === "Turn" ? 4 : 5;
  h.streetBet = Array(n).fill(0);
  h.currentBet = 0;
  h.minRaise = BB;
  h.toAct = h.players.map((_, i) => canAct(h, i));
  h.raiseOpen = Array(n).fill(true);
  h.players.forEach((_, i) => canAct(h, i) && (h.last[i] = null));
  progress(h, h.button);
}

function deal(state: State, random: () => number): H | null {
  const seated = state.seats.map((s, i) => ({ ...s, i })).filter((s) => state.stacks[s.i] > 0);
  if (seated.length < 2) return null;
  const n = seated.length;
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const button = state.button % n;
  const hole = seated.map((_, i) => [deck[i], deck[n + i]] as [Card, Card]);
  const board = deck.slice(2 * n, 2 * n + 5);
  const holeSalts = seated.map(() => [salt(random), salt(random)] as [string, string]);
  const boardSalts = board.map(() => salt(random));
  const [sb, bb] = n === 2 ? [button, (button + 1) % n] : [(button + 1) % n, (button + 2) % n];
  const h: H = {
    id: state.hands + 1, players: seated.map((s) => ({ wallet: s.wallet, stack: state.stacks[s.i] })), button, sb, bb,
    hole, board, holeSalts, boardSalts,
    holeCommits: hole.map((c, i) => [commit(c[0], holeSalts[i][0]), commit(c[1], holeSalts[i][1])]), boardCommits: board.map((c, k) => commit(c, boardSalts[k])),
    street: "Preflop", dealt: 0, committed: Array(n).fill(0), streetBet: Array(n).fill(0), folded: Array(n).fill(false), toAct: Array(n).fill(false),
    raiseOpen: Array(n).fill(true), currentBet: BB, minRaise: BB, last: Array(n).fill(null), turn: null, seq: 0, showdown: null, won: null, result: null,
  };
  put(h, sb, SB);
  h.last[sb] = { act: "small blind", to: h.streetBet[sb] };
  put(h, bb, BB);
  h.last[bb] = { act: "big blind", to: h.streetBet[bb] };
  h.toAct = h.players.map((_, i) => canAct(h, i));
  progress(h, bb);
  return h;
}

function act(h: H, p: number, move: Move): H {
  if (h.turn !== p) throw new Error("not your turn");
  const n = structuredClone(h);
  const owed = Math.max(0, h.currentBet - h.streetBet[p]);
  const max = h.streetBet[p] + left(h, p);
  let m: Move = move;
  if (m.move === "allin") m = max <= h.currentBet ? { move: "call" } : { move: "raise", to: max };
  let word: string;
  if (m.move === "fold") {
    n.folded[p] = true;
    word = "fold";
  } else if (m.move === "check") {
    if (owed) throw new Error("there is a bet to call: call, raise or fold");
    word = "check";
  } else if (m.move === "call") {
    if (!owed) throw new Error("nothing to call: check instead");
    put(n, p, owed);
    word = left(n, p) === 0 ? "all in" : "call";
  } else {
    const range = raiseRange(h, p);
    if (!range) throw new Error("you can only call or fold: the betting was not reopened to you");
    if (!Number.isInteger(m.to) || m.to > range[1]) throw new Error("you don't have that many chips");
    if (m.to < range[0]) throw new Error(`the smallest raise is to ${range[0]}`);
    put(n, p, m.to - h.streetBet[p]);
    const size = m.to - h.currentBet;
    if (size >= h.minRaise) {
      n.minRaise = size;
      n.raiseOpen = n.raiseOpen.map((o, i) => (i === p ? o : true));
    }
    n.currentBet = m.to;
    n.toAct = n.toAct.map((t, i) => (i !== p && canAct(n, i) ? true : t));
    word = left(n, p) === 0 ? "all in" : h.currentBet === 0 ? "bet" : "raise";
  }
  n.toAct[p] = false;
  n.raiseOpen[p] = false;
  n.last[p] = { act: word, to: n.streetBet[p] };
  n.seq += 1;
  progress(n, p);
  return n;
}

export function viewOf(h: H, viewer: number | null): HandView {
  const vis = (i: number) => viewer === i || !!h.showdown?.shown[i];
  const t = h.turn;
  const r = t !== null ? raiseRange(h, t) : null;
  const hole = h.hole.map((c, i) => (vis(i) ? c : null));
  return {
    players: h.players, button: h.button, sb: h.sb, bb: h.bb, big_blind: BB, street: h.street,
    board: h.board.slice(0, h.dealt), board_names: h.board.slice(0, h.dealt).map(cardName),
    hole, hole_names: hole.map((c) => (c ? [cardName(c[0]), cardName(c[1])] : null)),
    commitments: { domain: DOMAIN, hole: h.holeCommits, board: h.boardCommits },
    openings: { hole: h.hole.map((c, i) => (vis(i) ? c.map((card, j) => ({ card, salt: h.holeSalts[i][j] })) : null)), board: h.board.slice(0, h.dealt).map((card, k) => ({ card, salt: h.boardSalts[k] })) },
    committed: h.committed, street_bet: h.streetBet, left: h.players.map((_, i) => left(h, i)), folded: h.folded,
    all_in: h.players.map((_, i) => !h.folded[i] && left(h, i) === 0), last: h.last, pot: h.committed.reduce((a, b) => a + b, 0),
    current_bet: h.currentBet, min_raise: h.minRaise, turn: t, deadline_ms: 0,
    options: t === null ? null : { player: t, check: h.currentBet <= h.streetBet[t], call: Math.min(Math.max(0, h.currentBet - h.streetBet[t]), left(h, t)), raise: r ? { min_to: r[0], max_to: r[1] } : null, allin: left(h, t) },
    showdown: h.showdown, won: h.won, result: h.result, seq: h.seq,
  };
}

function endHand(state: State, random: () => number): State {
  const h = state.hand!;
  const s = structuredClone(state);
  h.players.forEach((p, i) => {
    const k = s.seats.findIndex((x) => x.wallet === p.wallet);
    s.stacks[k] += h.result![i];
  });
  const names = (i: number) => s.seats.find((x) => x.wallet === h.players[i].wallet)?.name ?? `Seat ${i + 1}`;
  if (h.showdown) {
    h.showdown.shown.forEach((sh, i) => sh && s.log.push(`Hand ${h.id}: ${names(i)} shows ${h.hole[i].map(cardName).join(" ")} (${h.showdown!.names[i]})`));
    h.showdown.pots.forEach((p) => s.log.push(`Hand ${h.id}: ${p.winners.map(names).join(" and ")} win ${p.amount}`));
  } else s.log.push(`Hand ${h.id}: ${names(h.won!.findIndex((w, i) => w > 0 && !h.folded[i]))} takes ${h.committed.reduce((a, b) => a + b, 0)} unshown`);
  s.ended = h;
  s.hands += 1;
  s.button += 1;
  s.hand = s.hands < HANDS ? deal(s, random) : null;
  return s;
}

export const mockGame: MockGame<State, Move> = {
  seats: Number(process.env.HOLDEM_SEATS ?? 4),
  setup(seats, random) {
    const s: State = { seats, stacks: seats.map(() => BUYIN), button: 0, hands: 0, hand: null, log: [`${seats.length} players sit down with ${BUYIN} chips each. Blinds ${SB}/${BB}.`] };
    s.hand = deal(s, random);
    return s;
  },
  view(state, wallet) {
    const h = state.hand;
    if (!h) return { seats: state.seats, stacks: state.stacks, hand: null, wallet };
    const i = h.players.findIndex((p) => p.wallet === wallet.toLowerCase());
    return { wallet, seats: state.seats, stacks: state.stacks, hand: { id: h.id, actor: h.turn !== null ? h.players[h.turn].wallet : null, players: h.players, game: viewOf(h, i >= 0 ? i : null) } };
  },
  publicLog(state) {
    const h = state.hand;
    const live = h
      ? h.last.map((d, i) => (d ? `Hand ${h.id}: ${state.seats.find((x) => x.wallet === h.players[i].wallet)?.name} ${d.act}${d.to ? " " + d.to : ""}` : null)).filter(Boolean)
      : [];
    return [...state.log.slice(-20), ...live];
  },
  apply(state, wallet, move, random) {
    const h = state.hand;
    if (!h) throw new Error("no hand in play");
    const p = h.players.findIndex((x) => x.wallet === wallet.toLowerCase());
    if (p < 0) throw new Error("you are not in this hand");
    const next = { ...state, ended: null, hand: act(h, p, move) };
    return next.hand!.result ? endHand(next, random) : next;
  },
  finished(state) {
    return state.hand === null;
  },
};

export default mockGame;
