// `bun test games/holdem`: the AI seat's prompt carries everything the seat saw (every action of the
// hand, earlier hands' shown cards and results, stacks) and nothing it didn't (no hidden cards).
import { expect, test } from "bun:test";
import { mockGame } from "./mock";
import { legalMoves, parseMove, persona, prompt } from "./actor";
import { cardName, handOf, type Card } from "./shared/holdem";

const seats = ["a", "b", "c", "d"].map((x, i) => ({ wallet: `0x${String(i + 1).repeat(40)}`, name: `P${x}` }));
const rng = (() => {
  let a = 7;
  return () => ((a = (Math.imul(a, 1103515245) + 12345) >>> 0) / 4294967296);
})();

/** Plays until `stop(state)` with a simple policy: fold once per hand from the first seat that can, else check/call. */
function playUntil(state: any, stop: (s: any) => boolean) {
  for (let k = 0; k < 500 && !stop(state); k++) {
    const h = state.hand;
    if (!h) break;
    const wallet = h.players[h.turn].wallet;
    const v = mockGame.view(state, wallet) as any;
    const legal = legalMoves(v);
    const folded = h.folded.some(Boolean);
    const pick = (!folded && legal.find((m) => m.move === "fold")) || legal.find((m) => m.move === "check") || legal.find((m) => m.move === "call") || legal[0];
    state = mockGame.apply(state, wallet, pick, rng);
  }
  return state;
}

/** Every card no one but its owner should know: hole cards not shown down (this hand and every earlier one). */
function hiddenFrom(state: any, wallet: string): Card[] {
  const h = state.hand;
  const out: Card[] = [];
  h.players.forEach((p: any, i: number) => {
    if (p.wallet !== wallet && !h.showdown?.shown[i]) out.push(...h.hole[i]);
  });
  return out;
}

test("the prompt has every action of the hand, earlier hands, stacks, and no hidden card", () => {
  let s: any = mockGame.setup(seats, rng);
  // Finish hand 1 (with a fold), then play into hand 2 until a few actions are in.
  s = playUntil(s, (x) => x.hand && x.hand.id === 2 && x.hand.actions.length >= 5);
  const h = s.hand;
  expect(h.id).toBe(2);
  const wallet = h.players[h.turn].wallet;
  const view = mockGame.view(s, wallet) as any;
  const { system, user } = prompt(view, [], persona[0]);
  const text = `${system}\n${user}`;

  // (a) every action of the current hand, in order.
  const hand = handOf(view)!;
  const lines = user.split("\n");
  const start = lines.findIndex((l) => l.startsWith("This hand so far"));
  expect(start).toBeGreaterThan(-1);
  const log = lines.slice(start + 1).join("\n");
  let at = 0;
  for (const a of hand.actions!) {
    const seat = view.game.seats[a.p];
    const who = seat === view.game.seats[hand.options!.player] ? `${persona[0].name} (you)` : `Seat ${seat + 1}`;
    const word = { check: "checks", call: "calls", bet: "bets", raise: "raises to", "all in": "all in to", fold: "folds" }[a.act] ?? a.act;
    const needle = `${who} ${word}`;
    const found = log.indexOf(needle, at);
    expect(found, `missing "${needle}" in\n${log}`).toBeGreaterThan(-1);
    at = found + needle.length;
  }
  // (b) earlier hands and (c) stacks and pot.
  expect(user).toContain("Earlier hands");
  expect(user).toContain("Hand 1:");
  expect(user).toContain("Stacks at the start of this hand");
  expect(user).toContain(`Pot: ${hand.pot}`);
  // Never a card the seat can't see: other players' hole cards in this hand. (Earlier hands are
  // reshuffled decks; their section only ever holds board and shown-down cards, checked below.)
  const current = text.slice(0, text.indexOf("Earlier hands"));
  for (const c of hiddenFrom(s, wallet)) expect(current).not.toMatch(new RegExp(`\\b${cardName(c)}\\b`));
  const earlier = user.slice(user.indexOf("Earlier hands"), user.indexOf("Legal moves"));
  const h1 = s.history[0];
  const allowed = new Set<string>([...h1.board, ...h1.shown.flatMap((x: any) => x[1])].map(cardName));
  for (const m of earlier.matchAll(/\b([2-9TJQKA][cdhs])\b/g)) expect(allowed.has(m[1]), `${m[1]} in earlier hands`).toBe(true);
  expect(user.length).toBeLessThan(6000); // ~1.5k tokens
});

test("parseMove is lenient and stays legal", () => {
  const legal = [{ move: "fold" }, { move: "call" }, { move: "raise", to: 6 }, { move: "raise", to: 10 }, { move: "allin" }] as any[];
  expect(parseMove({ move: "call" }, legal)).toEqual({ move: "call" });
  expect(parseMove({ action: "call" }, legal)).toEqual({ move: "call" });
  expect(parseMove({ move: { move: "raise", to: 9 } }, legal)).toEqual({ move: "raise", to: 10 });
  expect(parseMove({ move: "bet", amount: 5 }, legal)).toEqual({ move: "raise", to: 6 });
  expect(parseMove({ move: "all-in" }, legal)).toEqual({ move: "allin" });
  expect(parseMove({ move: "check" }, legal)).toBeNull();
});
