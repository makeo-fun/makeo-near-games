// The noir table UI (games/holdem/ui, story.js) is driven by a `HoldemView`: this seat's private view
// plus the public table log. This turns the rules' sit-and-go view (rules/src/sitgo.rs, as the room
// gives it to this seat) into that shape, and a UI choice back into the rules' Move. Pure: the page
// wires it to the room (client/noir-adapter.ts). Nothing here invents data the rules didn't give.
import { cardName, isBetting, type Card, type HandView, type Logged, type Move, type SitGoView } from "./holdem.js";

export type NoirSeat = { id: string; name: string; title: string };
export type NoirPending =
  | { kind: "fill"; joined: number; max: number; stake?: string }
  | { kind: "unseal" }
  | { kind: "act"; street: string; toCall: number; pot: number; stack: number; bet: number; minTo: number; maxTo: number; canRaise: boolean; canCheck: boolean };
export type NoirEvent = { t: string; [key: string]: unknown };
export type NoirView = { me: { seat: string; hole: string[] | null }; seats: NoirSeat[]; log: NoirEvent[]; pending: NoirPending | null; hand: number; finished: boolean };
/** What the UI sends back from its picker. */
export type NoirChoice = { kind?: string; to?: number; unseal?: boolean; fill?: boolean };

const STREET: Record<string, string> = { Preflop: "preflop", Flop: "flop", Turn: "turn", River: "river" };
const card = (c: Card) => cardName(c);

/** A rules action word as the UI's action kind. */
function kindOf(a: Logged): string {
  if (/blind/.test(a.act)) return "post";
  if (a.act === "all in") return "allin";
  return a.act;
}

/**
 * The HoldemView for the hand in play. `names(wallet)` names a seat; `unsealed` says whether this
 * player has opened their own cards yet (the UI's "unseal" moment); `extra` adds lobby/end events.
 */
/** What the page knows beyond the rules' view: who is AI, their published receipts, the model. */
export type NoirExtras = { kinds?: Record<string, string>; receipts?: any[]; model?: string };

export function noirView(g: SitGoView, me: string | null, names: (wallet: string) => string, unsealed: boolean, extras: NoirExtras = {}): NoirView {
  const wallet = (i: number) => g.hand!.players[i].wallet.toLowerCase();
  const seats: NoirSeat[] = g.players.map((w) => ({ id: w.toLowerCase(), name: names(w), title: "" }));
  const view: NoirView = { me: { seat: me ?? "", hole: null }, seats, log: [], pending: null, hand: g.hands, finished: g.finished };
  const hand = g.hand;
  if (!hand) return view;
  const meIdx = me ? hand.players.findIndex((p) => p.wallet.toLowerCase() === me) : -1;
  const log = view.log;

  // The hand: button, blinds, stacks at its start.
  const stacks: Record<string, number> = {};
  hand.players.forEach((p, i) => (stacks[wallet(i)] = p.stack));
  log.push({ t: "hand", n: g.hands, button: wallet(hand.button), sb: wallet(hand.sb), bb: wallet(hand.bb), blinds: g.blinds, stacks });
  // The deal: the keeper's commitments to every card, made before the first bet.
  const cardCount = hand.players.length * 2 + hand.commitments.board.length;
  log.push({ t: "deal", deck_commitment: hand.commitments.hole[0]?.[0] ?? "", cardCount, commitments: hand.commitments, pcr0: "", keeper: "", seats: hand.players.map((_, i) => wallet(i)) });
  const mine = meIdx >= 0 ? hand.hole[meIdx] : null;
  if (mine && unsealed) {
    log.push({ t: "hole", cards: mine.map(card), private: true });
    view.me.hole = mine.map(card);
  }

  // Every action, with the board revealed between streets.
  const bet = hand.players.map(() => 0);
  const left = hand.players.map((p) => p.stack);
  let pot = 0;
  let street = "Preflop";
  let shownBoard = 0;
  const reveal = (upTo: string) => {
    const target = upTo === "Flop" ? 3 : upTo === "Turn" ? 4 : upTo === "River" ? 5 : 0;
    for (const [name, n] of [["flop", 3], ["turn", 4], ["river", 5]] as const) {
      if (shownBoard < n && n <= target && hand.board.length >= n) {
        const from = n === 3 ? 0 : n - 1;
        log.push({ t: "street", name, cards: hand.board.slice(from, n).map(card), commitments: hand.commitments.board.slice(from, n), openings: hand.openings.board.slice(from, n) });
        shownBoard = n;
      }
    }
  };
  for (const a of hand.actions ?? []) {
    if (a.street !== street) {
      bet.fill(0);
      street = a.street;
      reveal(street);
    }
    const amount = Math.max(0, a.to - bet[a.p]);
    bet[a.p] = a.to;
    left[a.p] -= amount;
    pot += amount;
    const ev: NoirEvent = { t: "action", street: STREET[a.street] ?? a.street.toLowerCase(), seat: wallet(a.p), kind: kindOf(a), amount, to: a.to, pot, stack: left[a.p] };
    if (a.act === "small blind") ev.label = `SMALL BLIND ${a.to}`;
    if (a.act === "big blind") ev.label = `BIG BLIND ${a.to}`;
    log.push(ev);
  }
  // Streets dealt with no action on them (everyone all in): run the board out.
  reveal(hand.board.length >= 5 ? "River" : hand.board.length === 4 ? "Turn" : hand.board.length === 3 ? "Flop" : "Preflop");

  // How it ended.
  if (hand.street === "Showdown" && hand.showdown) {
    const sd = hand.showdown;
    const hands: Record<string, string[]> = {};
    const rank: Record<string, string> = {};
    const best: Record<string, string[]> = {};
    hand.players.forEach((_, i) => {
      if (sd.shown[i] && hand.hole[i]) {
        hands[wallet(i)] = hand.hole[i]!.map(card);
        rank[wallet(i)] = sd.names[i] ?? "";
        best[wallet(i)] = (sd.best[i] ?? []).map(card);
      }
    });
    const winners = [...new Set(sd.pots.flatMap((p) => p.winners))].map(wallet);
    log.push({ t: "showdown", inHand: hand.players.map((_, i) => wallet(i)).filter((_, i) => !hand.folded[i]).concat(hand.players.map((_, i) => wallet(i)).filter((_, i) => hand.folded[i])), hands, rank, best, winners, pots: sd.pots.map((p) => ({ amount: p.amount, eligible: p.eligible.map(wallet), winners: p.winners.map(wallet) })), result: resultOf(hand, wallet) });
  } else if (hand.street === "Folded" && hand.won) {
    const w = hand.won.findIndex((x, i) => x > 0 && !hand.folded[i]);
    log.push({ t: "won", seat: w >= 0 ? wallet(w) : null, pot: hand.pot, result: resultOf(hand, wallet) });
  }
  if (g.finished) log.push(endOf(g, hand, wallet, names, extras));

  // What the keeper waits on from this player.
  if (mine && !unsealed) view.pending = { kind: "unseal" };
  else if (isBetting(hand) && hand.options && hand.options.player === meIdx) {
    const o = hand.options;
    view.pending = {
      kind: "act", street: STREET[hand.street], toCall: o.call, pot: hand.pot, stack: hand.left[meIdx], bet: hand.street_bet[meIdx],
      minTo: o.raise?.min_to ?? hand.street_bet[meIdx] + o.allin, maxTo: o.raise?.max_to ?? hand.street_bet[meIdx] + o.allin,
      canRaise: !!o.raise, canCheck: o.check,
    };
  }
  return view;
}

function resultOf(hand: HandView, wallet: (i: number) => string) {
  const out: Record<string, number> = {};
  (hand.result ?? []).forEach((d, i) => (out[wallet(i)] = d));
  return out;
}

/** The game's end: final ranking by chips, the winners and shares that settle the pot, and the last
 * hand's card commitments with every opening the rules published (folded cards stay sealed). */
function endOf(g: SitGoView, hand: HandView, wallet: (i: number) => string, names: (w: string) => string, extras: NoirExtras): NoirEvent {
  const cards: { label: string; commitment: string; salt: string | null; card: string | null; status: string }[] = [];
  hand.players.forEach((_, i) => {
    [0, 1].forEach((j) => {
      const o = hand.openings.hole[i]?.[j];
      cards.push({
        label: `${names(hand.players[i].wallet)} · hole ${j + 1}`, commitment: hand.commitments.hole[i][j], salt: o?.salt ?? null, card: o ? card(o.card) : null,
        status: o ? (hand.showdown?.shown[i] ? "shown at showdown" : "sealed to you") : hand.folded[i] ? "folded · never revealed" : "sealed",
      });
    });
  });
  hand.commitments.board.forEach((c, k) => {
    const o = hand.openings.board[k];
    cards.push({ label: `board ${k + 1}`, commitment: c, salt: o?.salt ?? null, card: o ? card(o.card) : null, status: o ? "revealed by the keeper" : "never dealt" });
  });
  const kinds: Record<string, string> = {};
  g.players.forEach((w) => (kinds[w.toLowerCase()] = extras.kinds?.[w.toLowerCase()] ?? "PLAYER"));
  // The AI runner's receipts, in the engine's shape (move kinds as the table names them).
  const receipts = (extras.receipts ?? []).map((r) => ({
    ...r, seat: String(r.seat).toLowerCase(), round: `hand ${r.round}`,
    move: r.move && typeof r.move === "object" ? { kind: r.move.move, to: r.move.to } : { kind: String(r.move) },
  }));
  return {
    t: "end", mock: false, kinds, model: extras.model ?? (receipts[0]?.model ?? "NEAR AI Cloud"), receipts,
    deck_commitment: hand.commitments.hole[0]?.[0] ?? "", seed: "", pcr0: "", near: null,
    checked: `${cards.filter((c) => c.card).length} opened cards`,
    hands: g.hands, chips: Object.fromEntries(g.players.map((w, s) => [w.toLowerCase(), g.chips[s]])),
    winners: g.winners, shares: g.shares, cards, state: g.state ?? null,
  };
}

/** A UI choice as the rules' Move, checked against what the rules offered; null when it isn't legal. */
export function noirMove(choice: NoirChoice, p: NoirPending | null): Move | null {
  if (!p || p.kind !== "act") return null;
  switch (choice.kind) {
    case "fold": return { move: "fold" };
    case "check": return p.canCheck ? { move: "check" } : null;
    case "call": return p.toCall > 0 ? { move: "call" } : p.canCheck ? { move: "check" } : null;
    case "allin": return { move: "allin" };
    case "bet":
    case "raise": {
      if (!p.canRaise) return null;
      const to = Math.round(Number(choice.to));
      if (!Number.isFinite(to)) return null;
      const clamped = Math.max(p.minTo, Math.min(p.maxTo, to));
      return clamped >= p.maxTo ? { move: "allin" } : { move: "raise", to: clamped };
    }
    default: return null;
  }
}

/**
 * The whole game as one append-only HoldemView log, the way the UI consumes it: an opening `lobby`,
 * each finished hand's events frozen in order, then the hand in play. Feed it every view the room
 * gives this seat; `view()` is what the UI's `onView` gets.
 */
export class NoirLog {
  private frozen: NoirEvent[] = [];
  private current: { hand: number; events: NoirEvent[] } | null = null;
  private unsealed = new Set<number>();
  private holeAt = new Map<number, number>();
  private last: NoirView | null = null;

  extras: NoirExtras = {};

  constructor(private readonly opening: NoirEvent[] = []) {}

  /** This player opened their own cards for `hand` (the UI's unseal moment). */
  unseal(hand: number) {
    this.unsealed.add(hand);
  }

  update(g: SitGoView, me: string | null, names: (wallet: string) => string): NoirView {
    const open = this.unsealed.has(g.hands) || !me;
    const v = noirView(g, me, names, open, this.extras);
    // The player's own cards enter the log where they broke the seal, never earlier: the UI has
    // already read the events before that moment.
    const hole = v.log.findIndex((e) => e.t === "hole");
    let events = v.log;
    if (hole >= 0) {
      const ev = v.log[hole];
      events = v.log.filter((_, i) => i !== hole);
      const at = this.holeAt.get(g.hands) ?? (this.current && this.current.hand === g.hands ? this.current.events.length : 0);
      this.holeAt.set(g.hands, Math.min(at, events.length));
      events = [...events.slice(0, this.holeAt.get(g.hands)), ev, ...events.slice(this.holeAt.get(g.hands))];
    }
    if (this.current && this.current.hand !== v.hand) this.frozen.push(...this.current.events);
    this.current = { hand: v.hand, events };
    this.last = { ...v, log: [...this.opening, ...this.frozen, ...events] };
    return this.last;
  }

  view(): NoirView | null {
    return this.last;
  }
}
