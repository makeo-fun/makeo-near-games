// The live adapter for the new UI (games/nearwolf/ui): the same two methods as its mock adapter
// (`start(onView)`, `act(choice)`), driven by a real Makeo room. Exposed as
// window.NEARWOLF.createMakeoAdapter(room) and window.NEARWOLF.toNearwolfView(gameView).
import type { GameView } from "../shared/nearwolf.js";
import { type NearwolfView, type NwReceipt, fromChoice, toNearwolfView } from "../shared/nearwolf-view.js";

export function createMakeoAdapter(room: MakeoRoom, options: { receipts?: () => NwReceipt[]; contract?: string | null; onRefused?: (message: string) => void } = {}) {
  let game: GameView | null = null;
  return {
    start(onView: (view: NearwolfView) => void) {
      const push = (view: unknown) => {
        const g = (view as { game?: GameView | null } | null)?.game ?? null;
        if (!g) return;
        game = g;
        onView(toNearwolfView(g, { receipts: options.receipts?.(), contract: options.contract ?? null }));
      };
      room.onChange(push);
      if (room.view) push(room.view);
    },
    async act(choice: Record<string, unknown>) {
      if (!game || room.pending) return;
      const move = fromChoice(game, choice);
      if (!move) return options.onRefused?.("That choice doesn't fit this phase.");
      try {
        await room.move(move);
      } catch (error) {
        options.onRefused?.(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

const w = window as unknown as { NEARWOLF?: Record<string, unknown> };
w.NEARWOLF = Object.assign(w.NEARWOLF ?? {}, { createMakeoAdapter, toNearwolfView });
