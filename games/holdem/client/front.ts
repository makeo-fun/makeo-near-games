// NEAR Hold'em's front door and room flow, shared by every table look: the glass table (index.html,
// client/glass) and the noir one (noir.html, client/noir). It opens a room (CPU practice, a free match
// with friends, a paid sit-and-go); when play starts, it hands the live adapter (client/adapter.ts),
// which feeds the table this seat's own view from the keeper-run rules, to the page's `mount`.
// The classic table is ./classic.html.
import { handOf, isBetting, scriptedMove, seatOf, type Move, type SitGoView } from "../shared/holdem.js";
import type { NoirExtras } from "../shared/noir.js";
import { createMakeoAdapter } from "./adapter.js";

type Room = MakeoRoom<{ game: SitGoView | null }>;
const PERSONAS = ["Vega", "Rook", "Juno", "Atlas", "Nyx"];
const CPU_STYLE = [
  { aggression: 0.75, looseness: 0.3 },
  { aggression: 0.25, looseness: 0.8 },
  { aggression: 0.85, looseness: 0.75 },
  { aggression: 0.5, looseness: 0.5 },
  { aggression: 0.65, looseness: 0.55 },
];
const PRACTICE_SEATS = 4;
const $ = (s: string) => document.querySelector(s) as HTMLElement;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const short = (w: string) => (w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w);
let room: Room | null = null;
let mountTable: () => void = () => undefined;
let booted = false;
let toastT = 0;

function toast(m: string) {
  const t = $("#toast");
  t.textContent = m;
  t.classList.add("on");
  clearTimeout(toastT);
  toastT = window.setTimeout(() => t.classList.remove("on"), 3200);
}

function step(which: "main" | "free" | "lobby") {
  $("#menuMain").hidden = which !== "main";
  $("#menuFree").hidden = which !== "free";
  $("#lobby").hidden = which !== "lobby";
}

$("#pot").innerHTML = "Sit-and-go: everyone starts with 100 chips, blinds double every 5 hands, the chip leader takes the pot.<br>Free play: no stake · Paid match: entry 1 or 5 · AI seats play without a wallet.";

$("#front").addEventListener("click", (e) => {
  const b = (e.target as Element).closest("[data-go]") as HTMLElement | null;
  if (!b) return;
  $("#err").textContent = "";
  const go = b.dataset.go;
  if (go === "free") return step("free");
  if (go === "back") return step("main");
  if (go === "cpu") return void enter(() => Makeo.open({ with: "cpu", seats: PRACTICE_SEATS, seat: 0, controllers: cpuSeats() }) as Promise<Room>);
  if (go === "friends") return void enter(() => Makeo.open({ with: "friends", seats: 6 }) as Promise<Room>);
  if (go === "paid") return void enter(() => Makeo.open({ with: "money" }) as Promise<Room>);
});

function cpuSeats(): MakeoCpuControllers {
  const out: MakeoCpuControllers = {};
  for (let k = 1; k < PRACTICE_SEATS; k++) {
    const style = CPU_STYLE[(k - 1) % CPU_STYLE.length];
    out[k] = {
      name: PERSONAS[(k - 1) % PERSONAS.length],
      delayMs: 1400,
      play: (view: any, seat: { wallet: string }, rng: () => number): Move | null => {
        const hand = handOf(view);
        if (!hand || !isBetting(hand)) return null;
        const me = seatOf(hand, seat.wallet);
        if (me === null || hand.options?.player !== me) return null;
        return scriptedMove(hand, me, rng, style);
      },
    };
  }
  return out;
}

async function enter(open: () => Promise<Room | null>) {
  try {
    const next = await open();
    if (!next) return step("main");
    room?.leave();
    room = next;
    next.onLobby(drawLobby);
    next.onPlayers(() => drawLobby(next.lobby));
    next.onStart(start);
    next.onChange(() => start());
    next.onEnd((end) => {
      if (booted) {
        addAgainButton();
        if (next.kind === "paid") addPayoutButton();
        return;
      }
      $("#front").hidden = false;
      step("main");
      const reason = end.outcome && end.outcome.kind === "Void" ? end.outcome.reason : "";
      $("#err").textContent = `Match called off${reason ? ` · ${reason}` : ""} · any entry was refunded.`;
    });
    if (next.phase === "lobby") drawLobby(next.lobby);
    else start();
  } catch (error) {
    step("main");
    const m = error instanceof Error ? error.message : String(error);
    if (m && !/closed|cancel/i.test(m)) $("#err").textContent = m;
  }
}

function drawLobby(lobby: MakeoLobby) {
  if (!room || room.phase !== "lobby") return;
  step("lobby");
  const joined = lobby.seats.filter((s) => s.id).length;
  const kind = lobby.entry ? `Paid match · ${lobby.entry.stake} ${lobby.entry.token} · ${lobby.access === "open" ? "discoverable" : "invite only"}` : "Free match · invite only";
  const host = lobby.seats.find((s) => s.id === lobby.host);
  let h = `<div class="head">${joined} joined · up to ${lobby.max}</div><div>${esc(kind)}. When the host starts, the keeper deals every hand sealed.</div>`;
  h += `<div class="seats">${lobby.seats.map((s) => (s.id ? `<span class="seat">${esc(s.id === room!.me?.id ? "You" : s.name ?? short(s.id))}${s.status && s.status !== "connected" ? ` · ${s.status}` : ""}</span>` : `<span class="seat empty">open seat</span>`)).join("")}</div>`;
  h += `<button class="fr-b ghost sm" id="copyLink">Copy invite link</button>`;
  if (!room.me) h += `<button class="fr-b" id="joinBtn"><b>${lobby.entry ? `Join · ${esc(lobby.entry.stake)} ${esc(lobby.entry.token)}` : "Join"}</b></button>`;
  else if (room.me.host || lobby.canStart) h += `<button class="fr-b" id="startBtn" ${lobby.canStart ? "" : "disabled"}><b>Start with ${joined}</b>${joined < lobby.min ? `<small>Needs ${lobby.min} to start</small>` : ""}</button>`;
  else h += `<div>Waiting for ${esc(host?.name ?? "the host")} to start · ${joined} joined</div>`;
  $("#lobby").innerHTML = h;
  ($("#copyLink") as HTMLButtonElement).onclick = async () => {
    const link = room?.link ?? location.href;
    try {
      await navigator.clipboard.writeText(link);
      toast("Invite link copied.");
    } catch {
      toast(link);
    }
  };
  const join = document.querySelector("#joinBtn") as HTMLButtonElement | null;
  if (join) join.onclick = () => room?.pay().catch((e) => toast(e?.message ?? String(e)));
  const startBtn = document.querySelector("#startBtn") as HTMLButtonElement | null;
  if (startBtn)
    startBtn.onclick = async () => {
      startBtn.disabled = true;
      try {
        await room!.start();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
        startBtn.disabled = false;
      }
    };
}

function nameOf(wallet: string): string {
  const w = wallet.toLowerCase();
  if (room?.me?.id?.toLowerCase() === w) return "You";
  const g = room?.view?.game;
  const seat = g ? g.players.findIndex((p) => p.toLowerCase() === w) : -1;
  const p = room?.players.find((x) => x.id?.toLowerCase() === w) ?? room?.players.find((x) => x.seat === seat);
  const name = p?.name ?? room?.lobby.seats.find((s) => s.id?.toLowerCase() === w)?.name ?? null;
  if (name && !/^0x[0-9a-f]{4}/i.test(name)) return name;
  if (room?.kind === "practice" && seat > 0) return PERSONAS[(seat - 1) % PERSONAS.length];
  return name ?? `Player ${short(wallet)}`;
}

/** Who is AI, as far as this page can tell: practice CPUs, or seats with published NEAR AI receipts. */
function extras(): NoirExtras {
  const g = room?.view?.game;
  const kinds: Record<string, string> = {};
  for (const w of g?.players ?? []) {
    const id = w.toLowerCase();
    if (room?.me?.id?.toLowerCase() === id) kinds[id] = "HUMAN";
    else if (room?.kind === "practice") kinds[id] = "CPU";
    else if (receipts.some((r) => String(r.seat).toLowerCase() === id)) kinds[id] = "AI";
  }
  return { kinds, receipts };
}

/** Play has begun: give the show engine this table's seats and the live adapter, then mount it. */
function start() {
  if (booted || !room) return;
  const g = room.view?.game;
  if (!g || !Array.isArray(g.chips) || !g.hand) return;
  booted = true;
  const HD = ((window as any).HOLDEM ??= {});
  HD.SEATS = g.players.map((w) => ({ id: w.toLowerCase(), name: nameOf(w), title: "" }));
  const joined = g.players.length;
  const opening = [{ t: "lobby", joined, max: joined, stake: room.kind === "paid" ? room.lobby.entry?.stake : room.kind === "practice" ? "PRACTICE" : "FREE PLAY", line: room.kind === "practice" ? "You against the house's practice players." : "Humans and verified AI agents, one table. Every seat looks the same." }];
  (window as any).HOLDEM_BOOT = { adapter: createMakeoAdapter(room, { names: nameOf, extras, opening, onRefused: toast }), seats: HD.SEATS };
  $("#front").hidden = true;
  void loadReceipts();
  try {
    mountTable();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
  $("#hud-me").innerHTML = `${room.kind === "practice" ? "practice · " : room.hidden ? "keeper-dealt · " : ""}<b>${esc(nameOf(room.me?.id ?? ""))}</b>`;
}

/** AI receipts (actors/, published at game end): `?receipts=<https url>`. */
let receipts: any[] = [];
async function loadReceipts() {
  const url = new URLSearchParams(location.search).get("receipts");
  if (!url || !/^https:\/\//.test(url)) return;
  try {
    const body = await (await fetch(url, { cache: "no-store" })).json();
    receipts = Array.isArray(body) ? body : Array.isArray(body?.receipts) ? body.receipts : [];
  } catch {
    /* not published yet */
  }
}

function addAgainButton() {
  const ctl = $("#ctl");
  if (ctl.querySelector(".again")) return;
  const b = document.createElement("button");
  b.className = "again";
  b.textContent = "Play again";
  b.onclick = () => {
    room?.leave();
    location.href = location.pathname;
  };
  ctl.appendChild(b);
}

function addPayoutButton() {
  const ctl = $("#ctl");
  if (ctl.querySelector(".payout")) return;
  const b = document.createElement("button");
  b.className = "payout";
  b.textContent = "See payout";
  b.onclick = async () => {
    const games = await Makeo.games();
    await (games as any)?.contests?.showResult?.(room!.id);
  };
  ctl.appendChild(b);
}

/** Runs the front door; `mount` starts the page's table once play begins (HOLDEM_BOOT is set). */
export function runFront(mount: () => void) {
  mountTable = mount;
  // The room this page was opened for; a bare `?room=` link (as agent runners share) joins it directly.
  void enter(async () => {
    const opened = (await Makeo.room()) as Room | null;
    if (opened) return opened;
    const id = new URL(location.href).searchParams.get("room");
    return id ? ((await Makeo.join(id)) as Room) : null;
  });
}
