// `bun test games/holdem`: the noir UI adapter turns each seat's sit-and-go view into the UI's
// HoldemView: an append-only log per hand, every action, the board street by street, and UI choices
// that are always legal moves.
import { expect, test } from "bun:test";
import { mockGame } from "./mock";
import { legalMoves } from "./actor";
import { noirMove, noirView } from "./shared/noir";

const seats = [1, 2, 3].map((i) => ({ wallet: `0x${String(i).repeat(40)}`, name: `P${i}` }));
let a = 11;
const rng = () => ((a = (Math.imul(a, 1103515245) + 12345) >>> 0) / 4294967296);

test("each hand's log only grows, carries every action and the board in order, and choices are legal", () => {
  let s: any = mockGame.setup(seats, rng);
  const me = seats[0].wallet;
  const names = (w: string) => seats.find((x) => x.wallet === w.toLowerCase())?.name ?? w;
  const logs = new Map<number, string[]>();
  let checkedPending = 0;
  for (let k = 0; k < 400 && s.hand; k++) {
    const v: any = mockGame.view(s, me);
    const nv = noirView(v.game, me, names, true);
    // Append-only within a hand.
    const now = nv.log.map((e) => JSON.stringify(e));
    const before = logs.get(nv.hand) ?? [];
    expect(now.slice(0, before.length)).toEqual(before);
    logs.set(nv.hand, now);
    // Every action of the hand is in the log, and the board comes out flop, turn, river.
    expect(nv.log.filter((e) => e.t === "action").length).toBe(v.game.hand.actions.length);
    const streets = nv.log.filter((e) => e.t === "street").map((e) => e.name);
    expect(streets).toEqual(["flop", "turn", "river"].slice(0, streets.length));
    expect(nv.log.find((e) => e.t === "hole")?.cards).toEqual(nv.me.hole!);
    // My turn: the UI's choices become legal rules moves.
    const h = s.hand;
    const wallet = h.players[h.turn].wallet;
    if (wallet === me) {
      expect(nv.pending?.kind).toBe("act");
      const legal = legalMoves(v);
      for (const choice of [{ kind: "fold" }, { kind: "check" }, { kind: "call" }, { kind: "raise", to: 9999 }, { kind: "raise", to: 1 }, { kind: "allin" }]) {
        const m = noirMove(choice, nv.pending);
        if (!m) continue;
        const ok = m.move === "fold" || legal.some((l) => l.move === m.move) || (m.move === "raise" && legal.some((l) => l.move === "raise")) || (m.move === "check" && legal.some((l) => l.move === "check"));
        expect(ok, `${JSON.stringify(choice)} → ${JSON.stringify(m)} not in ${JSON.stringify(legal)}`).toBe(true);
      }
      checkedPending++;
      const pick = legal.find((m) => m.move === "check") ?? legal.find((m) => m.move === "call") ?? legal[0];
      s = mockGame.apply(s, wallet, pick, rng);
    } else {
      const lv: any = mockGame.view(s, wallet);
      const legal = legalMoves(lv);
      s = mockGame.apply(s, wallet, legal.find((m) => m.move === "call") ?? legal.find((m) => m.move === "check") ?? legal[0], rng);
    }
  }
  expect(checkedPending).toBeGreaterThan(3);
  expect(logs.size).toBeGreaterThan(1);
});

test("a sealed hand waits for the player to unseal it", () => {
  const s: any = mockGame.setup(seats, rng);
  const v: any = mockGame.view(s, seats[1].wallet);
  const sealed = noirView(v.game, seats[1].wallet, (w) => w, false);
  expect(sealed.pending).toEqual({ kind: "unseal" });
  expect(sealed.log.some((e) => e.t === "hole")).toBe(false);
  // Another seat's cards are never in this seat's view.
  const other = noirView(v.game, seats[1].wallet, (w) => w, true);
  expect(other.log.filter((e) => e.t === "hole").length).toBe(1);
});

import { NoirLog } from "./shared/noir";

test("across hands the whole log stays append-only", () => {
  let s: any = mockGame.setup(seats, rng);
  const me = seats[0].wallet;
  const acc = new NoirLog([{ t: "lobby", joined: 3, max: 3 }]);
  let prev: string[] = [];
  for (let k = 0; k < 300 && s.hand; k++) {
    const v: any = mockGame.view(s, me);
    acc.unseal(v.game.hands);
    const now = acc.update(v.game, me, (w) => w).log.map((e) => JSON.stringify(e));
    expect(now.slice(0, prev.length)).toEqual(prev);
    prev = now;
    const h = s.hand;
    const w = h.players[h.turn].wallet;
    const legal = legalMoves(mockGame.view(s, w) as any);
    s = mockGame.apply(s, w, legal.find((m) => m.move === "call") ?? legal.find((m) => m.move === "check") ?? legal[0], rng);
  }
  expect(prev.filter((e) => e.includes('"t":"hand"')).length).toBeGreaterThan(2);
});

test("unsealing mid-hand appends the player's cards, keeping the log append-only", () => {
  let s: any = mockGame.setup(seats, rng);
  const me = seats[0].wallet;
  const acc = new NoirLog();
  let prev: string[] = [];
  let unsealedAt = -1;
  for (let k = 0; k < 120 && s.hand; k++) {
    const v: any = mockGame.view(s, me);
    // Break the seal only after a few actions of each hand have been read.
    if (v.game.hand.actions.length >= 4 && unsealedAt !== v.game.hands) {
      acc.unseal(v.game.hands);
      unsealedAt = v.game.hands;
    }
    const now = acc.update(v.game, me, (w) => w).log.map((e) => JSON.stringify(e));
    expect(now.slice(0, prev.length)).toEqual(prev);
    prev = now;
    const h = s.hand;
    const w = h.players[h.turn].wallet;
    const legal = legalMoves(mockGame.view(s, w) as any);
    s = mockGame.apply(s, w, legal.find((m) => m.move === "call") ?? legal.find((m) => m.move === "check") ?? legal[0], rng);
  }
  expect(prev.filter((e) => e.includes('"t":"hole"')).length).toBeGreaterThan(0);
});
