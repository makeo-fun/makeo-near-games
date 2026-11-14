// The live adapter for the noir client (client/noir/app.ts): the same two methods as its mock adapter
// (`start(onView)`, `act(choice)`), driven by a real Makeo room. The engine reads the log by index, so
// this keeps one append-only log: every event shared/noir.ts derives from the rules' view, once, in
// order, plus an `acted` event that closes the player's picker (when they act, or when the clock or
// the table moves on first).
import type { SitGoView } from "../shared/holdem.js";
import { NoirLog, type NoirEvent, type NoirExtras, type NoirPending, type NoirView, noirMove } from "../shared/noir.js";

type Options = { names: (wallet: string) => string; extras: () => NoirExtras; opening: NoirEvent[]; onRefused?: (message: string) => void };

export function createMakeoAdapter(room: MakeoRoom<{ game: SitGoView | null }>, options: Options) {
  const noir = new NoirLog(options.opening);
  const log: NoirEvent[] = [];
  let taken = 0; // events of noir's log already in ours
  let onView: ((view: NoirView) => void) | null = null;
  let last: NoirView | null = null;
  let pending: NoirPending | null = null;
  let pendingKey = "";
  const acted = new Set<string>();
  let game: SitGoView | null = null;
  let sending = false;

  const me = () => room.me?.id?.toLowerCase() ?? null;
  const keyOf = (g: SitGoView, p: NoirPending) => `${g.hands}:${p.kind === "unseal" ? "unseal" : g.hand?.seq ?? 0}`;

  function closePicker(choice: unknown) {
    if (!pending || acted.has(pendingKey)) return;
    acted.add(pendingKey);
    log.push({ t: "acted", kind: pending.kind, pending, choice, private: true });
  }

  function emit() {
    if (!last || !onView) return;
    const open = pending && !acted.has(pendingKey) && !sending ? pending : null;
    onView({ ...last, log: [...log], pending: open });
  }

  function push(view: unknown) {
    const g = (view as { game?: SitGoView | null } | null)?.game ?? null;
    if (!g || !Array.isArray(g.chips)) return;
    game = g;
    noir.extras = options.extras();
    const nv = noir.update(g, me(), options.names);
    const key = nv.pending ? keyOf(g, nv.pending) : "";
    // The decision the picker was open for has passed (the clock ran out, or the hand moved on).
    if (pending && pendingKey !== key) closePicker(null);
    for (; taken < nv.log.length; taken++) log.push(nv.log[taken]);
    if (nv.pending && !acted.has(key)) {
      pending = nv.pending;
      pendingKey = key;
    }
    last = nv;
    emit();
  }

  return {
    start(cb: (view: NoirView) => void) {
      onView = cb;
      room.onChange(push);
      if (room.view) push(room.view);
    },
    async act(choice: { kind?: string; to?: number; unseal?: boolean; fill?: boolean }) {
      if (!game || !pending || acted.has(pendingKey)) return;
      if (pending.kind === "unseal" || choice.unseal) {
        closePicker(choice);
        noir.unseal(game.hands);
        push(room.view);
        return;
      }
      const move = noirMove(choice, pending);
      if (!move) return options.onRefused?.("That move isn't open to you right now.");
      const key = pendingKey;
      closePicker(choice);
      sending = true;
      emit();
      try {
        await room.move(move);
      } catch (error) {
        // Refused: reopen the picker so the player can choose again.
        acted.delete(key);
        options.onRefused?.(error instanceof Error ? error.message : String(error));
      } finally {
        sending = false;
        emit();
      }
    },
  };
}
