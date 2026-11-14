// NEARWOLF's page: the noir table (client/noir, the show engine) on a real Makeo room.
// The front door opens a room (CPU practice, a free match with friends, a paid match); when play
// starts, the show engine boots with the live adapter (client/adapter.ts), which feeds it this
// seat's own view from the rules. The classic table is ./classic.html.
import type { GameView } from "../shared/nearwolf.js";
import { PERSONAS, ROLES, scriptedMove } from "../shared/nearwolf.js";
import { type NwAgent, type NwReceipt, toNearwolfView } from "../shared/nearwolf-view.js";
import { createMakeoAdapter } from "./adapter.js";
import "./noir/story.js";
import "./noir/portraits.js";
import "./noir/app.js";

const PRACTICE_SEATS = 7;
const AI_SEATS = 5;
const PROJECT = "89411bc3-10c6-42ae-b17d-06442dec8b8d";
/** The NEAR AI actor dispatcher (actors/src/dispatch.ts): it seats verified NEAR AI players in a
 *  room. `?ai=<https url>` points the page at another one (a tunnel). */
const DISPATCH = (() => {
  const q = new URLSearchParams(location.search).get("ai");
  return q && /^https?:\/\//.test(q) ? q.replace(/\/$/, "") : "http://localhost:8790";
})();
/** fetch with a deadline: an unreachable dispatcher must never hold the game up. */
async function fetchJson(url: string, init: RequestInit = {}, ms = 5000): Promise<any> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await (await fetch(url, { ...init, signal: c.signal })).json();
  } finally {
    clearTimeout(t);
  }
}
type AiSeat = { name: string; wallet?: string; model?: string | null };
let ai: { wanted: number; seated: number; seats: AiSeat[]; error: string | null; asked: boolean } | null = null;
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
  if (go === "nearai") {
    ai = { wanted: AI_SEATS, seated: 0, seats: [], error: null, asked: false };
    return void enter(() => Makeo.open({ with: "friends", seats: 12 }));
  }
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
    // A room already under way may say it started before its first view lands: boot on that view.
    next.onChange(() => {
      if (!booted && next.phase === "playing") void start();
    });
    next.onEnd((end) => {
      const g = next.view?.game as GameView | null | undefined;
      if (booted) {
        // Played to the end: the show plays its ending and receipt; offer the way back.
        addAgainButton();
        if (next.kind === "paid") addPayoutButton();
        return;
      }
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

/** Ask the dispatcher for NEAR AI players once this player holds the host seat, then follow them in. */
async function seatAi() {
  if (!ai || ai.asked || !room?.me) return;
  ai.asked = true;
  try {
    const body = await fetchJson(`${DISPATCH}/seat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ game: "nearwolf", project: PROJECT, room: room.id, ai: ai.wanted }) }, 15000);
    if (!body.ok) throw new Error(body.error ?? "the dispatcher refused");
    ai.seats = body.seats ?? [];
  } catch (e) {
    ai.error = `NEAR AI couldn't join: ${e instanceof Error ? e.message : String(e)}. The house will fill the empty seats.`;
  }
  if (room) drawLobby(room.lobby);
  while (ai && !ai.error && room && room.phase === "lobby" && ai.seated < ai.wanted) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const st = await fetchJson(`${DISPATCH}/status?room=${encodeURIComponent(room.id)}`);
      ai.seated = st.seated ?? 0;
      ai.wanted = st.wanted ?? ai.wanted;
      if (Array.isArray(st.seats)) ai.seats = st.seats;
    } catch {
      /* keep trying */
    }
    if (room) drawLobby(room.lobby);
  }
}

function drawLobby(lobby: MakeoLobby) {
  if (!room || room.phase !== "lobby") return;
  step("lobby");
  if (ai && !ai.asked && room.me) void seatAi();
  const joined = lobby.seats.filter((s) => s.id).length;
  const kind = lobby.entry ? `Paid match · ${lobby.entry.stake} ${lobby.entry.token} · invite only` : "Free match · invite only";
  const host = lobby.seats.find((s) => s.id === lobby.host);
  let h = `<div class="head">${joined} joined · up to ${lobby.max}</div><div>${esc(kind)}. When the host starts, the keeper deals the roles and the house fills the table to seven seats.</div>`;
  const agentName = (id: string | null) => ai?.seats.find((x) => x.wallet && id && x.wallet.toLowerCase() === id.toLowerCase());
  h += `<div class="seats">${lobby.seats.map((s) => {
    if (!s.id) return `<span class="seat empty">open seat</span>`;
    const a = agentName(s.id);
    const label = s.id === room!.me?.id ? "You" : a ? `${a.name} · NEAR AI` : s.name ?? "Player";
    return `<span class="seat${a ? " ai" : ""}">${esc(label)}${s.status && s.status !== "connected" ? ` · ${s.status}` : ""}</span>`;
  }).join("")}</div>`;
  if (ai) {
    const model = ai.seats.find((x) => x.model)?.model;
    h += ai.error
      ? `<div class="ai-err">${esc(ai.error)}</div>`
      : `<div class="ai-line">${ai.seated >= ai.wanted ? "NEAR AI seated" : "Seating NEAR AI…"} ${ai.seated}/${ai.wanted}${model ? ` · ${esc(model)} in a TEE` : ""}<br>${ai.seats.map((x) => esc(x.name)).join(" · ")}</div>`;
  }
  h += `<button class="fr-b ghost sm" id="copyLink">Copy invite link</button>`;
  if (!room.me) h += `<button class="fr-b" id="joinBtn"><b>${lobby.entry ? `Join · ${esc(lobby.entry.stake)} ${esc(lobby.entry.token)}` : "Join"}</b></button>`;
  else if (room.me.host || lobby.canStart) {
    const waitAi = !!ai && !ai.error && ai.seated < ai.wanted;
    h += `<button class="fr-b" id="startBtn" ${lobby.canStart && !waitAi ? "" : "disabled"}><b>${waitAi ? "Waiting for NEAR AI…" : `Start with ${joined}`}</b>${joined < lobby.min ? `<small>Needs ${lobby.min} to start</small>` : waitAi ? "" : "<small>The keeper deals the roles; the house fills any empty seat</small>"}</button>`;
  }
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
  NW.PRACTICE = room.kind === "practice";
  (window as any).NEARWOLF_PORTRAIT_BASE = "./noir/";
  (window as any).NEARWOLF_BOOT = { adapter: createMakeoAdapter(room, { contract: NEAR_POT.contract, onRefused: toast, receipts: () => receipts, agents, loadReceipts }) };
  $("#front").hidden = true;
  try {
    NW.mount();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
  const me = g.you != null ? g.seats[g.you] : null;
  if (me && g.role) $("#hud-me").innerHTML = `${room.kind === "practice" ? "practice · " : room.hidden ? "keeper-dealt · " : ""}<b>${esc(PERSONAS[me.persona]?.name)}</b> · ${esc(ROLES[g.role].name)}`;
}

/** AI receipts (actors/, published at game end as <instance>.receipts.json): `?receipts=<https url>`. */
let receipts: NwReceipt[] = [];
function agents(): Record<string, NwAgent> {
  const out: Record<string, NwAgent> = {};
  for (const x of ai?.seats ?? []) if (x.wallet) out[x.wallet] = { name: x.name, model: x.model ?? null };
  return out;
}
async function loadReceipts() {
  if (room && ai) {
    // From the NEAR AI dispatcher, when it seated players in this room (also after a reload).
    for (let i = 0; i < 5; i++) {
      try {
        const body = await fetchJson(`${DISPATCH}/receipts?room=${encodeURIComponent(room.id)}`, { cache: "no-store" }, 4000);
        if (Array.isArray(body?.seats)) ai = { wanted: body.seats.length, seated: body.seats.length, seats: body.seats, error: null, asked: true };
        const list = Array.isArray(body?.receipts) ? body.receipts : [];
        if (list.length) receipts = list;
        if (!body?.seats?.length || list.some((x: NwReceipt) => x.reasoning)) break;
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
    if (receipts.length) return;
  }
  const url = new URLSearchParams(location.search).get("receipts");
  if (!url || !/^https:\/\//.test(url)) return;
  for (let i = 0; i < 5 && !receipts.length; i++) {
    try {
      const body = await (await fetch(url, { cache: "no-store" })).json();
      receipts = Array.isArray(body) ? body : Array.isArray(body?.receipts) ? body.receipts : [];
    } catch {
      /* not published yet */
    }
    if (!receipts.length) await new Promise((r) => setTimeout(r, 2000));
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
    location.href = location.pathname + (new URLSearchParams(location.search).get("revision") ? `?revision=${new URLSearchParams(location.search).get("revision")}` : "");
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

void enter(() => Makeo.room());
