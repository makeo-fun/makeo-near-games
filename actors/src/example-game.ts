// A tiny hidden-information game to exercise the runner and mock room end to end: "Last Card".
// Each seat is dealt 3 secret cards (1-9). Each round every seat plays one card (sealed); the
// highest unique card wins the round. After 3 rounds the most round wins wins.
// Game streams: copy this shape for your MockGame and actor.ts.
import type { MockGame } from "./mock-room";
import { personaPreamble, PERSONAS } from "./personas";
import type { GameActor } from "./types";

type Seat = { wallet: string; name: string; hand: number[]; wins: number };
export type LastCardState = { seats: Seat[]; round: number; played: Record<string, number>; log: LastCardEvent[]; finished: boolean };
export type LastCardEvent = { round: number; plays: Record<string, number>; winner: string | null };
export type LastCardView = { me: string; hand: number[]; round: number; mustPlay: boolean; scores: Record<string, number>; finished: boolean };
export type LastCardMove = { play: number };

export const lastCardGame: MockGame<LastCardState, LastCardMove> = {
  seats: 3,
  setup(seats, random) {
    const deck = Array.from({ length: 9 }, (_, i) => i + 1).sort(() => random() - 0.5);
    return { seats: seats.map((s, i) => ({ ...s, hand: deck.slice(i * 3, i * 3 + 3).sort(), wins: 0 })), round: 1, played: {}, log: [], finished: false };
  },
  view(state, wallet) {
    const me = state.seats.find((s) => s.wallet === wallet);
    return {
      me: wallet, hand: me?.hand ?? [], round: state.round, finished: state.finished,
      mustPlay: !!me && !state.finished && state.played[wallet] === undefined,
      scores: Object.fromEntries(state.seats.map((s) => [s.wallet, s.wins])),
    } satisfies LastCardView;
  },
  publicLog: (state) => state.log,
  apply(state, wallet, move) {
    const seat = state.seats.find((s) => s.wallet === wallet)!;
    if (state.played[wallet] !== undefined) throw new Error("already played this round");
    if (!seat.hand.includes(move?.play)) throw new Error("not in your hand");
    const next = structuredClone(state);
    next.played[wallet] = move.play;
    next.seats.find((s) => s.wallet === wallet)!.hand = seat.hand.filter((c) => c !== move.play);
    if (Object.keys(next.played).length === next.seats.length) {
      const counts = new Map<number, number>();
      for (const c of Object.values(next.played)) counts.set(c, (counts.get(c) ?? 0) + 1);
      const unique = Object.entries(next.played).filter(([, c]) => counts.get(c) === 1).sort((a, b) => b[1] - a[1]);
      const winner = unique[0]?.[0] ?? null;
      if (winner) next.seats.find((s) => s.wallet === winner)!.wins += 1;
      next.log.push({ round: next.round, plays: next.played, winner });
      next.played = {};
      next.round += 1;
      next.finished = next.round > 3;
    }
    return next;
  },
  finished: (state) => state.finished,
};

export const lastCardActor: GameActor<LastCardView, LastCardMove, LastCardEvent> = {
  persona: PERSONAS,
  legalMoves: (view) => (view.mustPlay ? view.hand.map((play) => ({ play })) : []),
  round: (view) => view.round,
  prompt(view, log, persona) {
    return {
      system: `${personaPreamble(persona, "Last Card")}\nRules: 3 rounds; each round everyone plays one secret card; the highest card nobody else played wins the round.`,
      user: JSON.stringify({ your_hand: view.hand, round: view.round, scores: view.scores, history: log, legal_moves: view.hand.map((play) => ({ play })) }),
    };
  },
  parseMove(json, legal) {
    const play = Number((json as { move?: { play?: unknown } })?.move?.play);
    return legal.find((m) => m.play === play) ?? null;
  },
};
