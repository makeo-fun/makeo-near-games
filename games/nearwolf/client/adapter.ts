// The live adapter for the noir client (client/noir/app.js): the same two methods as its mock
// adapter (`start(onView)`, `act(choice)`), driven by a real Makeo room. app.js reads the log by
// index, so this adapter keeps its own append-only log: each event from the rules' view once, in
// order, plus an `acted` event that closes the player's picker (when they act, or when the phase's
// clock runs out first). Also exposed as window.NEARWOLF.createMakeoAdapter / toNearwolfView.
import type { GameView } from "../shared/nearwolf.js";
import { type NearwolfView, type NwEvent, type NwPending, type NwReceipt, fromChoice, toNearwolfView } from "../shared/nearwolf-view.js";

export function createMakeoAdapter(room: MakeoRoom, options: { receipts?: () => NwReceipt[]; loadReceipts?: () => Promise<void>; contract?: string | null; onRefused?: (message: string) => void } = {}) {
  let game: GameView | null = null;
  let onView: ((view: NearwolfView) => void) | null = null;
  const log: NwEvent[] = [];
  const seen = new Set<string>();
  const acted = new Set<string>();
  let pending: NwPending | null = null;
  let pendingKey = "";
  let last: NearwolfView | null = null;
  const keyOf = (g: GameView) => `${g.round}:${g.phase}`;

  function closePicker(choice: unknown) {
    if (!pending || acted.has(pendingKey)) return;
    acted.add(pendingKey);
    log.push({ t: "acted", kind: pending.kind, pending, choice, private: true });
  }

  function emit() {
    if (!last || !onView) return;
    const open = game && pending && !acted.has(keyOf(game)) && pendingKey === keyOf(game) ? pending : null;
    onView({ ...last, log: [...log], pending: open });
  }

  let loaded = false;
  function push(view: unknown) {
    const g = (view as { game?: GameView | null } | null)?.game ?? null;
    if (!g) return;
    // At the end, fetch the AI receipts first (who was AI, their confessionals), then show it.
    if (g.phase === "end" && options.loadReceipts && !loaded) {
      loaded = true;
      void options.loadReceipts().catch(() => undefined).then(() => push(view));
      return;
    }
    game = g;
    const nv = toNearwolfView(g, { receipts: options.receipts?.(), contract: options.contract ?? null, practice: room.kind === "practice" });
    const key = keyOf(g);
    // A picker left open when its phase moved on (the clock ran out): close it with no choice.
    if (pending && pendingKey !== key) closePicker(null);
    for (const ev of nv.log) {
      if (ev.t === "acted") continue;
      const k = JSON.stringify(ev);
      if (!seen.has(k)) {
        seen.add(k);
        log.push(ev);
      }
    }
    // Chosen already (a reload, or the move landed): make sure the picker is closed.
    if (g.mine != null && nv.pending == null && pendingKey === key) closePicker(g.mine);
    if (nv.pending && !acted.has(key)) {
      pending = nv.pending;
      pendingKey = key;
    }
    last = nv;
    // The show engine reads this to keep up with the keeper's clock (client/noir/app.ts).
    (window as unknown as { NEARWOLF?: Record<string, unknown> }).NEARWOLF!.deadline = nv.pending ? g.deadline_ms : null;
    emit();
  }

  return {
    start(cb: (view: NearwolfView) => void) {
      onView = cb;
      room.onChange(push);
      if (room.view) push(room.view);
    },
    async act(choice: Record<string, unknown>) {
      if (!game || acted.has(keyOf(game))) return; // one choice per phase
      const move = fromChoice(game, choice);
      if (!move) return options.onRefused?.("That choice doesn't fit this phase.");
      closePicker(choice);
      emit();
      try {
        await room.move(move);
      } catch (error) {
        // Refused: reopen the picker so the player can choose again.
        acted.delete(pendingKey);
        emit();
        options.onRefused?.(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

const w = window as unknown as { NEARWOLF?: Record<string, unknown> };
w.NEARWOLF = Object.assign(w.NEARWOLF ?? {}, { createMakeoAdapter, toNearwolfView });
