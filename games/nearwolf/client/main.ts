// NEARWOLF's page: the noir table (client/noir, the show engine) on a real Makeo room.
// The front door opens a room (CPU practice, a free match with friends, a paid match); when play
// starts, the show engine boots with the live adapter (client/adapter.ts), which feeds it this
// seat's own view from the rules. The classic table is ./classic.html.
import type { GameView } from "../shared/nearwolf.js";
import { PERSONAS, ROLES, scriptedMove } from "../shared/nearwolf.js";
import { toNearwolfView } from "../shared/nearwolf-view.js";
import { createMakeoAdapter } from "./adapter.js";
import "./noir/story.js";
import "./noir/portraits.js";
import "./noir/app.js";

const PRACTICE_SEATS = 7;
const NEAR_POT: { network: string; contract: string | null } = { network: "testnet", contract: null };
const $ = (s: string) => document.querySelector(s) as HTMLElement;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
let room: MakeoRoom | null = null;
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

$("#pot").innerHTML = `Free play: no stake, no pot · Paid match: entry 1 or 5, winners split the pot<br>NEAR ${esc(NEAR_POT.network)} pot: ${NEAR_POT.contract ? `<b>${esc(NEAR_POT.contract)}</b>` : "contract not live yet"}`;

$("#front").addEventListener("click", (e) => {
  const b = (e.target as Element).closest("[data-go]") as HTMLElement | null;
  if (!b) return;
  $("#err").textContent = "";
  const go = b.dataset.go;
  if (go === "free") return step("free");
  if (go === "back") return step("main");
  if (go === "cpu") return void enter(() => Makeo.open({ with: "cpu", seats: PRACTICE_SEATS, controllers: cpuSeats() }));
  if (go === "friends") return void enter(() => Makeo.open({ with: "friends", seats: 12 }));
  if (go === "paid") return void enter(() => Makeo.open({ with: "money", private: true }));
});

function cpuSeats(): MakeoCpuControllers {
  const out: MakeoCpuControllers = {};
  for (let s = 1; s < PRACTICE_SEATS; s++) {
    out[s] = {
      name: PERSONAS[s].name,
      delayMs: 1200 + s * 400,
      play: (view: any, _seat, rng) => {
        const g: GameView | null = view?.game ?? (view?.seats ? view : null);
        return g ? scriptedMove(g, rng) : null;
      },
    };
  }
  return out;
}

async function enter(open: () => Promise<MakeoRoom | null>) {
  try {
    const next = await open();
    if (!next) return step("main");
    room?.leave();
    room = next;
    next.onLobby(drawLobby);
    next.onPlayers(() => drawLobby(next.lobby));
    next.onStart(start);
    next.onEnd((end) => {
      const g = next.view?.game as GameView | null | undefined;
      if (!g || g.phase !== "end") {
        $("#front").hidden = false;
        step("main");
        const reason = end.outcome && end.outcome.kind === "Void" ? end.outcome.reason : "";
        $("#err").textContent = `Match called off${reason ? ` · ${reason}` : ""} · any entry was refunded.`;
      } else if (next.kind === "paid") addPayoutButton();
    });
    if (next.phase === "lobby") drawLobby(next.lobby);
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
  const kind = lobby.entry ? `Paid match · ${lobby.entry.stake} ${lobby.entry.token} · invite only` : "Free match · invite only";
  const host = lobby.seats.find((s) => s.id === lobby.host);
  let h = `<div class="head">${joined} joined · up to ${lobby.max}</div><div>${esc(kind)}. When the host starts, the keeper deals the roles and the house fills the table to seven seats.</div>`;
  h += `<div class="seats">${lobby.seats.map((s) => (s.id ? `<span class="seat">${esc(s.id === room!.me?.id ? "You" : s.name ?? "Player")}${s.status && s.status !== "connected" ? ` · ${s.status}` : ""}</span>` : `<span class="seat empty">open seat</span>`)).join("")}</div>`;
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

/** Play has begun: give the show engine this table's seats and the live adapter, then boot it. */
async function start() {
  if (booted || !room) return;
  const g = room.view?.game as GameView | null | undefined;
  if (!g) return;
  booted = true;
  const NW = ((window as any).NEARWOLF ??= {});
  NW.SEATS = toNearwolfView(g).seats;
  NW.LIVE = true;
  (window as any).NEARWOLF_PORTRAIT_BASE = "./noir/";
  (window as any).NEARWOLF_BOOT = { adapter: createMakeoAdapter(room, { contract: NEAR_POT.contract, onRefused: toast }) };
  $("#front").hidden = true;
  try {
    NW.mount();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
  const me = g.you != null ? g.seats[g.you] : null;
  if (me && g.role) $("#hud-me").innerHTML = `${room.kind === "practice" ? "practice · " : room.hidden ? "keeper-dealt · " : ""}<b>${esc(PERSONAS[me.persona]?.name)}</b> · ${esc(ROLES[g.role].name)}`;
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

void enter(() => Makeo.room());
