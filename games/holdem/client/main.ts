// NEAR Hold'em: a sit-and-go table. Everything shown comes from the rules' view (room.view.game);
// the page never evaluates a hand or decides a pot. Moves go through room.move, sealed to the keeper.
import {
  RANK_LABEL,
  SUIT_GLYPH,
  cardName,
  handOf,
  isBetting,
  rankOf,
  scriptedMove,
  seatOf,
  suitOf,
  type Card,
  type HandView,
  type Move,
  type SitGoView,
} from "../shared/holdem.js";
// Rechecking AI signatures in the browser (EIP-191 recovery): audited, pinned versions.
import { secp256k1 } from "https://esm.sh/@noble/curves@1.4.0/secp256k1";
import { keccak_256 } from "https://esm.sh/@noble/hashes@1.4.0/sha3";

type MatchView = { phase: string; game: SitGoView | null; [key: string]: unknown };

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const short = (w: string) => (w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const PERSONAS = ["Vega", "Rook", "Juno", "Atlas", "Nyx"];
const CPU_STYLE = [
  { aggression: 0.75, looseness: 0.3 },
  { aggression: 0.25, looseness: 0.8 },
  { aggression: 0.85, looseness: 0.75 },
  { aggression: 0.5, looseness: 0.5 },
  { aggression: 0.65, looseness: 0.55 },
];
const COLORS = ["#5cc8ff", "#a78bfa", "#ffd166", "#ff6b5b", "#3ddc97", "#f3eedd"];

// ------------------------------------------------------------------ state

let room: MakeoRoom<MatchView> | null = null;
let practice = false;
let cpuCount = 3;
let menuStep: "root" | "free" = "root";
let raiseOpen = false;
let raiseTo = 0;
let sent: { label: string; hands: number; seq: number; since: number } | null = null;
let lastSeen: { hands: number; game: HandView } | null = null;
const endLogged = new Set<number>();
const dealtKeys = new Set<string>();
const logLines: string[] = [];
type HandRecord = {
  id: number;
  players: { wallet: string; name: string }[];
  me: number | null;
  commitments: HandView["commitments"];
  mine: { hole: [Card, Card]; openings: { card: Card; salt: string }[] } | null;
  last: HandView;
};
const records = new Map<number, HandRecord>();
let aiReceipts: any[] = [];
/** The exact request and response bytes each receipt's hashes cover, by chat id. */
let aiEvidence = new Map<string, { request_body: string; response_body: string }>();
/** What this browser recomputed for each receipt, by chat id. */
const aiChecks = new Map<string, { hashes: boolean; recovered: string | null }>();
/** Autoplay: this seat plays itself with the scripted player (`window.makeoBot(true)`, or `#autoplay`). */
let autoplay = /autoplay/.test(location.hash);
let autoTimer: ReturnType<typeof setTimeout> | null = null;
(window as any).makeoBot = (on: boolean) => {
  autoplay = !!on;
  render();
};
let autoRng = 0x2545f491;
const autoRandom = () => ((autoRng = (Math.imul(autoRng, 1664525) + 1013904223) >>> 0) / 4294967296);

// ------------------------------------------------------------------ small ui

function toast(text: string, ms = 2600) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("on");
  clearTimeout((toast as any).timer);
  (toast as any).timer = setTimeout(() => t.classList.remove("on"), ms);
}
function sheet(html: string, closeLabel = "Close") {
  $("#sheetcard").innerHTML = `${html}${closeLabel ? `<button class="btn ghost" id="sheetclose">${closeLabel}</button>` : ""}`;
  $("#sheet").classList.add("on");
  const c = document.getElementById("sheetclose");
  if (c) c.onclick = () => closeSheet();
}
function closeSheet() {
  $("#sheet").classList.remove("on");
}
$("#sheet").addEventListener("click", (e) => {
  if (e.target === $("#sheet")) closeSheet();
});
function show(screen: "title" | "table" | "receipt") {
  document.body.dataset.screen = screen;
  if (screen === "title") drawTitle();
  if (screen === "receipt") void drawReceipt();
  layout();
}

function cardHTML(c: Card | null | undefined, cls = "") {
  if (c === null || c === undefined) return `<div class="card back ${cls}"></div>`;
  const red = suitOf(c) === 1 || suitOf(c) === 2;
  return `<div class="card ${red ? "red" : ""} ${cls}" title="${cardName(c)}"><span class="rk">${RANK_LABEL[rankOf(c)]}</span><span class="st">${SUIT_GLYPH[suitOf(c)]}</span></div>`;
}
const cardText = (c: Card) => `${RANK_LABEL[rankOf(c)]}${SUIT_GLYPH[suitOf(c)]}`;

// ------------------------------------------------------------------ stars

(() => {
  const cv = $("#stars") as HTMLCanvasElement;
  const ctx = cv.getContext("2d")!;
  const stars = Array.from({ length: 90 }, (_, k) => ({ x: (k * 0.6180339) % 1, y: ((k * 0.7548776) % 1) * 0.8, r: ((k * 37) % 10) / 9 + 0.2, p: k }));
  const draw = (t: number) => {
    const w = (cv.width = innerWidth), h = (cv.height = innerHeight);
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      ctx.globalAlpha = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(t / 1400 + s.p));
      ctx.fillStyle = "#e8ecff";
      ctx.beginPath();
      ctx.arc(s.x * w, s.y * h, s.r, 0, 6.3);
      ctx.fill();
    }
  };
  let last = 0;
  const loop = (t: number) => {
    if (t - last > 120) {
      draw(t);
      last = t;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
})();

// ------------------------------------------------------------------ title

const INFO: Record<string, string> = {
  free: "Free play costs nothing. Practice against computer players in your browser, or invite friends to a free table by link.",
  cpu: "You against 1 to 5 computer players, with the same blinds, timers and showdowns as a real game. Practice: nothing is saved and no money moves.",
  friends: "A free table you host. Share the link; friends sign in to sit down and pay nothing. You deal once two or more have joined.",
  paid: "A sit-and-go for an entry. Everyone starts with 100 chips and blinds double every 5 hands. Whoever holds the most chips when one player has them all, or after 60 hands, takes the pot.",
};

function drawTitle() {
  const m = $("#menu");
  const choice = (id: string, label: string, detail: string, cls = "") =>
    `<div class="choice"><button class="btn ${cls}" data-go="${id}">${label}<small>${detail}</small></button><button class="info" data-info="${id}" aria-label="About ${label}">i</button></div>`;
  if (menuStep === "root") {
    m.innerHTML = choice("free", "Free play", "Practice or play friends") + choice("paid", "Paid match", "Sit-and-go · entry from 1", "sunny") +
      `<button class="back-link" data-go="fair">How the cards stay fair</button>`;
  } else {
    m.innerHTML = choice("cpu", "Practice vs CPU", "Just you, vs bots") +
      `<div class="stepper">Opponents <button data-cpu="-1" aria-label="Fewer">−</button><b id="cpun">${cpuCount}</b><button data-cpu="1" aria-label="More">+</button></div>` +
      choice("friends", "Free match with friends", "Invite link", "ghost") +
      `<button class="back-link" data-go="root">Back</button>`;
  }
  m.querySelectorAll<HTMLElement>("[data-go]").forEach((b) => (b.onclick = () => go(b.dataset.go!)));
  m.querySelectorAll<HTMLElement>("[data-info]").forEach((b) => (b.onclick = () => sheet(`<h3>${esc(b.previousElementSibling?.firstChild?.textContent)}</h3><p>${esc(INFO[b.dataset.info!])}</p>`)));
  m.querySelectorAll<HTMLElement>("[data-cpu]").forEach(
    (b) =>
      (b.onclick = () => {
        cpuCount = Math.max(1, Math.min(5, cpuCount + Number(b.dataset.cpu)));
        $("#cpun").textContent = String(cpuCount);
      }),
  );
  void drawLobbies();
}

function go(id: string) {
  if (id === "root" || id === "free") {
    menuStep = id;
    drawTitle();
  } else if (id === "fair") show("receipt");
  else if (id === "cpu") void startPractice();
  else if (id === "friends") void enter(() => Makeo.open({ with: "friends", seats: 6 }) as Promise<MakeoRoom<MatchView>>);
  else if (id === "paid") void enter(() => Makeo.open({ with: "money" }) as Promise<MakeoRoom<MatchView>>);
}

async function drawLobbies() {
  const box = $("#tables");
  if (menuStep !== "root") {
    box.innerHTML = "";
    return;
  }
  try {
    const list = await Makeo.lobbies();
    if (!list.length) {
      box.innerHTML = "";
      return;
    }
    box.innerHTML =
      `<div class="empty">Open matches</div>` +
      list
        .slice(0, 6)
        .map((l, k) => `<div class="trow"><div><div class="tn">Sit-and-go · ${esc(l.stake)} ${esc(l.token)}</div><div class="tm">${l.seats.taken} joined · up to ${l.seats.total}</div></div><button class="btn sm" data-join="${k}">Join</button></div>`)
        .join("");
    box.querySelectorAll<HTMLElement>("[data-join]").forEach((b) => (b.onclick = () => void enter(() => Makeo.join(list[Number(b.dataset.join)].room) as Promise<MakeoRoom<MatchView>>)));
  } catch {
    box.innerHTML = "";
  }
}

// ------------------------------------------------------------------ rooms

async function startPractice() {
  const controllers: Record<number, { play: (view: any, seat: { index: number; wallet: string }, rng: () => number) => Move | null; delayMs: number; name: string }> = {};
  for (let k = 1; k <= cpuCount; k++) {
    const style = CPU_STYLE[(k - 1) % CPU_STYLE.length];
    controllers[k] = {
      name: PERSONAS[(k - 1) % PERSONAS.length],
      delayMs: 1100,
      play: (view, seat, rng) => {
        const hand = handOf(view);
        if (!hand || !isBetting(hand)) return null;
        const me = seatOf(hand, seat.wallet);
        if (me === null || hand.options?.player !== me) return null;
        return scriptedMove(hand, me, rng, style);
      },
    };
  }
  await enter(() => Makeo.open({ with: "cpu", seats: cpuCount + 1, seat: 0, controllers }) as Promise<MakeoRoom<MatchView>>);
}

async function enter(open: () => Promise<MakeoRoom<MatchView> | null>) {
  try {
    const next = await open();
    if (!next) return show("title");
    room?.leave();
    room = next;
    practice = next.kind === "practice";
    records.clear();
    endLogged.clear();
    logLines.length = 0;
    lastSeen = null;
    sent = null;
    closeSheet();
    next.onChange(onView);
    next.onPlayers(() => render());
    next.onLobby(() => render());
    next.onStart(() => show("table"));
    next.onEnd((end) => showResult(end));
    show("table");
    if (next.view) onView(next.view);
  } catch (error) {
    const msg = errText(error);
    if (!/closed|cancel/i.test(msg)) toast(msg);
    show("title");
  }
}

function myWallet(): string | null {
  return room?.me?.id?.toLowerCase() ?? null;
}
function game(): SitGoView | null {
  return room?.view?.game ?? null;
}

function onView(view: MatchView) {
  const g = view?.game;
  if (g?.hand) noteHand(g, g.hand);
  if (sent && (!g || g.hands !== sent.hands || g.seq > sent.seq)) sent = null;
  render();
}

function noteHand(g: SitGoView, hand: HandView) {
  const id = g.hands;
  const me = seatOf(hand, myWallet());
  let rec = records.get(id);
  if (!rec) {
    rec = { id, players: hand.players.map((p, i) => ({ wallet: p.wallet, name: nameOf(p.wallet, g.seats[i]) })), me, commitments: hand.commitments, mine: null, last: hand };
    records.set(id, rec);
    if (records.size > 40) records.delete(Math.min(...records.keys()));
    log(`<div class="hh">HAND ${id} · BLINDS ${g.blinds[0]}/${g.blinds[1]}</div>`);
    if (me !== null && hand.hole[me]) log(`You hold <b>${hand.hole[me]!.map(cardText).join(" ")}</b>`);
  }
  if (me !== null && hand.hole[me] && hand.openings.hole[me]) rec.mine = { hole: hand.hole[me]!, openings: hand.openings.hole[me]! };
  if (lastSeen && lastSeen.hands === id) narrate(rec, lastSeen.game, hand);
  rec.last = hand;
  lastSeen = { hands: id, game: hand };
  if (!isBetting(hand) && !endLogged.has(id)) {
    endLogged.add(id);
    logEnd(rec, hand);
  }
}

/** "You calls" → "You call": second person for this player. */
function you(name: string, phrase: string) {
  if (name !== "You") return phrase;
  const [verb, ...rest] = phrase.split(" ");
  const base: Record<string, string> = { calls: "call", checks: "check", raises: "raise", bets: "bet", is: "are", folds: "fold", shows: "show", wins: "win", takes: "take" };
  return [base[verb] ?? verb, ...rest].join(" ");
}

function actWords(act: string, to: number) {
  switch (act) {
    case "check": return "checks";
    case "call": return `calls ${to}`;
    case "bet": return `bets ${to}`;
    case "raise": return `raises to ${to}`;
    case "all in": return `is all in (${to})`;
    case "fold": return "folds";
    default: return act;
  }
}

function narrate(rec: HandRecord, a: HandView, hand: HandView) {
  for (let i = 0; i < hand.players.length; i++) {
    const d = hand.last[i];
    const was = a.last[i];
    const nm = nameAt(rec, i);
    if (d && JSON.stringify(d) !== JSON.stringify(was) && !/blind/.test(d.act)) log(`<b>${esc(nm)}</b> ${you(nm, actWords(d.act, d.to))}`);
    else if (!d && hand.folded[i] && !a.folded[i]) log(`<b>${esc(nm)}</b> ${you(nm, "folds")}`);
  }
  if (hand.board.length > a.board.length) {
    const b = hand.board.length;
    const street = a.board.length === 0 && b === 5 ? "Board" : b === 3 ? "Flop" : b === 4 ? "Turn" : a.board.length < 4 ? "Board" : "River";
    log(`${street}: <b>${hand.board.slice(a.board.length).map(cardText).join(" ")}</b>`);
  }
}

function logEnd(rec: HandRecord, hand: HandView) {
  const mine = rec.me !== null && hand.result ? hand.result[rec.me] : 0;
  if (hand.street === "Showdown" && hand.showdown) {
    for (let i = 0; i < hand.players.length; i++) if (hand.showdown.shown[i] && hand.hole[i]) log(`<span class="sd"><b>${esc(nameAt(rec, i))}</b> ${you(nameAt(rec, i), "shows")} ${hand.hole[i]!.map(cardText).join(" ")} · ${esc(hand.showdown.names[i])}</span>`);
    for (const [k, pot] of hand.showdown.pots.entries()) {
      const who = pot.winners.map((w) => nameAt(rec, w)).join(" and ");
      log(`<span class="sd"><b>${esc(who)}</b> ${pot.winners.length > 1 ? "split" : you(who, "wins")} the ${k === 0 ? "pot" : "side pot"} · ${pot.amount}</span>`);
    }
  } else if (hand.won) {
    const w = hand.won.findIndex((x, i) => x > 0 && !hand.folded[i]);
    if (w >= 0) {
      log(`<b>${esc(nameAt(rec, w))}</b> ${you(nameAt(rec, w), "takes")} the pot · ${hand.pot}`);
      toast(`${w === rec.me ? "You take" : nameAt(rec, w) + " takes"} the pot · ${hand.pot}`);
    }
  }
  if (mine) log(`Your hand: <b class="net ${mine > 0 ? "up" : "down"}">${mine > 0 ? "+" : ""}${mine} chips</b>`);
}

// ------------------------------------------------------------------ names

function nameOf(wallet: string, seat: number): string {
  if (myWallet() && wallet.toLowerCase() === myWallet()) return "You";
  const players = room?.players ?? [];
  const p = players.find((x) => x.id?.toLowerCase() === wallet.toLowerCase()) ?? players.find((x) => x.seat === seat);
  const fromLobby = room?.lobby?.seats?.find((s) => s.id?.toLowerCase() === wallet.toLowerCase())?.name;
  const name = p?.name || fromLobby;
  if (name && !/^0x[0-9a-f]{4}/i.test(name)) return name;
  // Practice CPUs sit at seats 1..n with the names the page gave them.
  if (practice && seat > 0) return PERSONAS[(seat - 1) % PERSONAS.length];
  return name || `Player ${short(wallet)}`;
}
function nameAt(rec: HandRecord, i: number) {
  return rec.players[i]?.wallet && myWallet() && rec.players[i].wallet.toLowerCase() === myWallet() ? "You" : rec.players[i]?.name ?? `Seat ${i + 1}`;
}
function kindOf(wallet: string, name: string): "you" | "ai" | "cpu" | "human" {
  if (myWallet() && wallet.toLowerCase() === myWallet()) return "you";
  if (practice) return "cpu";
  if (aiReceipts.some((r) => String(r.seat).toLowerCase() === wallet.toLowerCase()) || PERSONAS.some((p) => name.toLowerCase().startsWith(p.toLowerCase()))) return "ai";
  return "human";
}
function colorOf(wallet: string) {
  let h = 0;
  for (const ch of wallet.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

// ------------------------------------------------------------------ layout

function layout() {
  const wide = innerWidth >= 1100 && document.body.dataset.screen === "table";
  const tall = innerHeight > innerWidth * 1.15;
  document.body.classList.toggle("wide", wide);
  document.body.classList.toggle("tall", tall);
  render();
}
addEventListener("resize", layout);

/** Sizes the felt so the seats around it fit the stage. */
function fitFelt() {
  const stage = $("#stage").getBoundingClientRect();
  const felt = $("#felt");
  const tall = document.body.classList.contains("tall");
  const small = innerWidth < 640;
  const padX = small ? 110 : 290;
  const padY = small ? 230 : 250;
  const aspect = tall ? 0.62 : 2.05;
  const w = Math.max(160, Math.min(stage.width - padX, (stage.height - padY) * aspect, tall ? 440 : 980));
  felt.style.width = `${w}px`;
  felt.style.aspectRatio = String(aspect);
}

/** Where seat `s` sits on screen: this player at the bottom, the rest clockwise. */
function slotOf(s: number, mySeat: number | null, n: number) {
  const k = (s - (mySeat ?? 0) + n) % n;
  return 90 + (360 / n) * k;
}
function polar(angle: number, fx: number, fy: number, pad: number) {
  const felt = $("#felt").getBoundingClientRect();
  const stage = $("#stage").getBoundingClientRect();
  const cx = felt.left - stage.left + felt.width / 2;
  const cy = felt.top - stage.top + felt.height / 2;
  const a = (angle * Math.PI) / 180;
  return { x: cx + Math.cos(a) * ((felt.width / 2) * fx + pad), y: cy + Math.sin(a) * ((felt.height / 2) * fy + pad) };
}

// ------------------------------------------------------------------ the table

function render() {
  drawBar();
  if (document.body.dataset.screen !== "table" || !room) return;
  fitFelt();
  if (room.phase === "lobby" || !game()) return drawLobby();
  const g = game()!;
  const hand = g.hand;
  const me = myWallet();
  const n = g.players.length;
  const mySeat = me ? g.players.findIndex((w) => w.toLowerCase() === me) : -1;
  const myIndex = hand ? seatOf(hand, me) : null;
  const ended = !!hand && !isBetting(hand);
  const handId = g.hands;

  // Board and pot.
  const board = hand?.board ?? [];
  const best = new Set<number>();
  if (ended && hand?.showdown) for (const pot of hand.showdown.pots) for (const w of pot.winners) for (const c of hand.showdown.best[w] ?? []) best.add(c);
  $("#board").innerHTML = [0, 1, 2, 3, 4]
    .map((k) => {
      if (k >= board.length) return `<div class="slot"></div>`;
      const c = board[k];
      const key = `${handId}:b${k}`;
      const fresh = !dealtKeys.has(key);
      dealtKeys.add(key);
      return cardHTML(c, `${fresh ? "flip" : ""} ${ended && hand?.showdown ? (best.has(c) ? "win" : "dim") : ""}`);
    })
    .join("");
  if (hand) {
    const pots = hand.showdown?.pots ?? [];
    $("#pot").innerHTML = `<span class="stack"></span>Pot ${hand.pot}${pots.length > 1 ? `<span class="side">main ${pots[0].amount} · ${pots.slice(1).map((p) => `side ${p.amount}`).join(" · ")}</span>` : ""}`;
  } else $("#pot").innerHTML = "";

  // Seats.
  let html = "";
  for (let s = 0; s < n; s++) {
    const angle = slotOf(s, mySeat >= 0 ? mySeat : null, n);
    const pos = polar(angle, 1, 1, 34);
    const wallet = g.players[s];
    const nm = nameOf(wallet, s);
    const kind = kindOf(wallet, nm);
    const i = hand ? g.seats.indexOf(s) : -1;
    if (i < 0 || !hand) {
      const out = g.chips[s] === 0;
      html += `<div class="seat folded" style="left:${pos.x}px;top:${pos.y}px">${plate(wallet, nm, kind, g.chips[s], false, out ? "OUT" : null)}<div class="did">${out ? `out · hand ${g.busted[s] ?? ""}` : "waiting"}</div></div>`;
      continue;
    }
    const turn = !ended && hand.turn === i;
    const folded = hand.folded[i];
    const shown = !!hand.showdown?.shown[i];
    const hole = hand.hole[i];
    let cards = "";
    if (hole) {
      const win = ended && hand.showdown?.pots.some((pt) => pt.winners.includes(i));
      cards = hole
        .map((c, k) => {
          const key = `${handId}:h${i}:${k}:${shown ? "s" : "o"}`;
          const fresh = !dealtKeys.has(key);
          dealtKeys.add(key);
          return cardHTML(c, `${fresh ? (shown && i !== myIndex ? "flip" : "deal") : ""} ${ended && hand.showdown ? (win && best.has(c) ? "win" : "dim") : ""} ${folded ? "sealed" : ""}`);
        })
        .join("");
    } else if (!folded && hand.street !== "Folded") {
      cards = [0, 1]
        .map((k) => {
          const key = `${handId}:h${i}:${k}:b`;
          const fresh = !dealtKeys.has(key);
          dealtKeys.add(key);
          return cardHTML(null, fresh ? "deal" : "");
        })
        .join("");
    }
    const stack = hand.left[i] + (ended && hand.won ? hand.won[i] : 0);
    const d = hand.last[i];
    let under = d ? `<div class="did ${/raise|bet|all/.test(d.act) ? "hot" : ""}">${esc(d.act)}</div>` : `<div class="did"></div>`;
    if (folded) under = `<div class="did">folded</div>`;
    if (ended) {
      const delta = hand.result?.[i] ?? 0;
      under = `<div class="hn">${esc(hand.showdown?.names[i] ?? "")}</div>${delta ? `<div class="net ${delta > 0 ? "up" : "down"}">${delta > 0 ? "+" : ""}${delta}</div>` : ""}`;
    }
    html += `<div class="seat ${kind === "you" ? "me" : ""} ${turn ? "turn" : ""} ${folded ? "folded" : ""}" style="left:${pos.x}px;top:${pos.y}px">
      <div class="cards">${cards}</div>${plate(wallet, nm, kind, stack, turn, hand.all_in[i] && !ended ? "ALL IN" : null)}${under}</div>`;
    if (!ended && hand.street_bet[i] > 0) {
      // Top and bottom seats put their chips beside the line to the pot, clear of the pot and labels.
      const vertical = Math.abs(Math.cos((angle * Math.PI) / 180)) < 0.35;
      const b = polar(angle, 0.66, vertical ? 0.62 : 0.8, 0);
      if (vertical) b.x += 74;
      html += `<div class="bet" style="left:${b.x}px;top:${b.y}px"><i></i>${hand.street_bet[i]}</div>`;
    }
    if (i === hand.button) {
      const b = polar(angle + 360 / n / 3.2, 0.82, 0.78, 0);
      html += `<div class="dealer" style="left:${b.x}px;top:${b.y}px">D</div>`;
    }
  }
  $("#seats").innerHTML = html;

  // How a hand ended, under the board.
  let note = "";
  if (ended && hand) {
    const rec = records.get(handId);
    const name = (i: number) => (rec ? nameAt(rec, i) : nameOf(hand.players[i].wallet, g.seats[i]));
    let line = "";
    if (hand.showdown) {
      const main = hand.showdown.pots[0];
      const who = main.winners.map(name).join(" & ");
      line = `${esc(who)} ${main.winners.length > 1 ? "split the pot" : who === "You" ? "win" : "wins"} · ${esc(hand.showdown.names[main.winners[0]] ?? "")}`;
    } else if (hand.won) {
      const w = hand.won.findIndex((x, i) => x > 0 && !hand.folded[i]);
      if (w >= 0) line = `${esc(name(w))} ${name(w) === "You" ? "take" : "takes"} the pot · ${hand.pot}`;
    }
    const mine = myIndex !== null && hand.result ? hand.result[myIndex] : 0;
    note = `<div class="banner"><div class="w">${line}</div>${mine ? `<div class="m net ${mine > 0 ? "up" : "down"}">${mine > 0 ? "+" : ""}${mine} chips for you</div>` : ""}${g.finished ? "" : `<div class="m" style="color:var(--muted)">Next hand in <span id="nextdeal"></span></div>`}</div>`;
  }
  $("#note").innerHTML = note;

  drawDock(hand && !ended ? hand : null, myIndex);
  drawLog();
  if (autoplay && hand && !ended && !sent && !autoTimer && myIndex !== null && hand.options?.player === myIndex) {
    const seq = g.seq;
    autoTimer = setTimeout(() => {
      autoTimer = null;
      const now = game();
      if (!now?.hand || now.seq !== seq) return render();
      const move = scriptedMove(now.hand, myIndex, autoRandom, { aggression: 0.55, looseness: 0.55 });
      if (move) void act(move, move.move);
    }, 900);
  }
}

function plate(wallet: string, name: string, kind: string, stack: number, turn: boolean, flag: string | null) {
  const tag = kind === "you" ? `<span class="tag you">You</span>` : kind === "ai" ? `<span class="tag ai">AI · TEE</span>` : kind === "cpu" ? `<span class="tag cpu">CPU</span>` : "";
  const status = room?.players.find((p) => p.id?.toLowerCase() === wallet.toLowerCase())?.status;
  const away = status && status !== "connected" && kind !== "cpu" ? ` <span style="color:var(--dim);font-size:10px">${esc(status)}</span>` : "";
  return `<div class="plate">${turn ? `<span class="clock"></span>` : ""}<span class="av" style="--c:${colorOf(wallet)}">${esc(name.slice(0, 1).toUpperCase())}</span><div><div class="nm">${esc(name)}${away}</div><div class="sk">${flag ?? stack}</div></div>${tag}</div>`;
}

/** The room's lobby, on the felt: who has joined, the invite link, Join or Start. */
function drawLobby() {
  if (!room) return;
  const L = room.lobby;
  $("#board").innerHTML = "";
  $("#pot").innerHTML = "";
  $("#seats").innerHTML = "";
  const joined = L.seats.filter((s) => s.id).length;
  const kind = L.entry ? `Paid match · ${esc(L.entry.stake)} ${esc(L.entry.token)} · ${L.access === "open" ? "discoverable" : "invite only"}` : "Free match · invite only";
  const hostName = L.host ? nameOf(L.host, -1) : "the host";
  let action = "";
  if (!room.me) action = `<button class="btn" id="joinbtn">${L.entry ? `Join · ${esc(L.entry.stake)} ${esc(L.entry.token)}` : "Join"}</button>`;
  else if (room.me.host) action = `<button class="btn" id="startbtn" ${L.canStart ? "" : "disabled"}>Start with ${joined}</button>`;
  else action = `<div class="status">Waiting for <b>${esc(hostName)}</b> to start · ${joined} joined</div>`;
  const need = Math.max(0, L.min - joined);
  $("#note").innerHTML = `<div style="display:grid;gap:10px;justify-items:center;max-width:440px">
    <div class="kicker">${kind}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center">${L.seats.map((s) => `<span class="chip ${s.id ? "ok" : ""}">${s.id ? esc(s.id.toLowerCase() === myWallet() ? "You" : s.name ?? short(s.id)) : "Open seat"}${s.id && s.id === L.host ? " · host" : ""}</span>`).join("")}</div>
    <div>${joined} joined · up to ${L.max}${need ? ` · needs ${L.min} to start · ${need} more` : ""}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">${action}<button class="btn ghost sm" id="copylink">Copy invite link</button></div>
    ${L.deadline ? `<div class="status">Entries close in <span id="lobbyclock"></span></div>` : ""}</div>`;
  const copy = document.getElementById("copylink");
  if (copy) copy.onclick = () => void navigator.clipboard?.writeText(room?.link ?? location.href).then(() => toast("Invite link copied"));
  const start = document.getElementById("startbtn");
  if (start) start.onclick = () => room?.start().catch((e: unknown) => toast(errText(e)));
  const join = document.getElementById("joinbtn");
  if (join) join.onclick = () => room?.pay().catch((e: unknown) => toast(errText(e)));
  $("#dock").innerHTML = `<div class="acts"><button class="btn sm ghost" id="leavebtn">Leave</button></div>`;
  $("#leavebtn").onclick = () => leave();
}

// ------------------------------------------------------------------ my moves

function drawDock(hand: HandView | null, me: number | null) {
  const dock = $("#dock");
  const o = hand?.options;
  const mine = !!(hand && o && me !== null && o.player === me);
  if (!mine) raiseOpen = false;
  let status = "";
  if (hand && hand.turn !== null && !mine) {
    const rec = records.get(game()?.hands ?? -1);
    status = `<b>${esc(rec ? nameAt(rec, hand.turn) : "Next player")}</b> is thinking<span id="secs"></span>`;
  } else if (hand && me !== null && hand.folded[me]) status = "You folded. Your cards stay sealed.";
  else if (game()?.finished) status = "The game is over.";
  if (sent) status = Date.now() - sent.since > 1500 ? "The dealer is checking your move…" : "Sending…";
  if (!mine) {
    dock.innerHTML = `<div class="status">${status}</div><div class="acts"><button class="btn sm ghost" id="leavebtn">Leave</button><button class="btn sm ghost" id="rcptbtn">Receipt</button></div>`;
  } else {
    const busy = (l: string) => (sent && sent.label === l ? "busy" : "");
    const dis = sent ? "disabled" : "";
    const range = o!.raise;
    if (range && (raiseTo < range.min_to || raiseTo > range.max_to)) raiseTo = range.min_to;
    const callBtn = o!.check
      ? `<button class="btn ${busy("check")}" data-act="check" ${dis}>Check<span class="k">C</span></button>`
      : `<button class="btn ${busy("call")}" data-act="call" ${dis}>Call ${o!.call}<span class="k">C</span></button>`;
    const raiseWord = hand!.current_bet === 0 ? "Bet" : "Raise";
    const raisebox =
      raiseOpen && range
        ? `<div class="raisebox"><div class="row"><div class="amt" id="ramt">${raiseTo}</div><input type="range" id="rslider" min="${range.min_to}" max="${range.max_to}" step="1" value="${raiseTo}" aria-label="${raiseWord} to"></div>
         <div class="presets">${presets(hand!, o!).map(([l, v]) => `<button data-pre="${v}" class="${v === raiseTo ? "on" : ""}">${l}</button>`).join("")}</div>
         <div class="row"><button class="btn ghost sm" id="rcancel" style="flex:1">Back</button><button class="btn sunny ${busy("raise")}" id="rgo" style="flex:2" ${dis}>${raiseTo === range.max_to ? "All in" : `${raiseWord} to ${raiseTo}`}</button></div></div>`
        : "";
    dock.innerHTML = `<div class="status">${status || `Your move<span id="secs"></span>`}</div>${raisebox}
      <div class="acts" ${raiseOpen ? 'style="display:none"' : ""}>
        ${o!.check ? "" : `<button class="btn ember ${busy("fold")}" data-act="fold" ${dis}>Fold<span class="k">F</span></button>`}
        ${callBtn}
        ${range ? `<button class="btn sunny" id="ropen" ${dis}>${raiseWord}<span class="k">R</span></button>` : ""}
        ${o!.allin > 0 && (range || o!.allin <= o!.call) ? `<button class="btn pip ${busy("allin")}" data-act="allin" ${dis}>All in ${o!.allin}<span class="k">A</span></button>` : ""}
      </div>`;
    dock.querySelectorAll<HTMLElement>("[data-act]").forEach((b) => (b.onclick = () => void act({ move: b.dataset.act } as Move, b.dataset.act!)));
    const ropen = dock.querySelector<HTMLElement>("#ropen");
    if (ropen) ropen.onclick = () => ((raiseOpen = true), render());
    const slider = dock.querySelector<HTMLInputElement>("#rslider");
    if (slider)
      slider.oninput = () => {
        raiseTo = Number(slider.value);
        $("#ramt").textContent = String(raiseTo);
        $("#rgo").textContent = raiseTo === range!.max_to ? "All in" : `${raiseWord} to ${raiseTo}`;
      };
    dock.querySelectorAll<HTMLElement>("[data-pre]").forEach((b) => (b.onclick = () => ((raiseTo = Number(b.dataset.pre)), render())));
    const rc = dock.querySelector<HTMLElement>("#rcancel");
    if (rc) rc.onclick = () => ((raiseOpen = false), render());
    const rg = dock.querySelector<HTMLElement>("#rgo");
    if (rg) rg.onclick = () => void act(raiseTo === range!.max_to ? { move: "allin" } : { move: "raise", to: raiseTo }, "raise");
  }
  const lb = dock.querySelector<HTMLElement>("#leavebtn");
  if (lb) lb.onclick = () => leave();
  const rb = dock.querySelector<HTMLElement>("#rcptbtn");
  if (rb) rb.onclick = () => show("receipt");
  if (!raiseOpen) document.documentElement.style.setProperty("--dockh", `${dock.offsetHeight || 150}px`);
}

function presets(hand: HandView, o: NonNullable<HandView["options"]>): [string, number][] {
  const r = o.raise!;
  const potAfter = hand.pot + o.call;
  const at = (f: number) => Math.max(r.min_to, Math.min(r.max_to, hand.current_bet + Math.round(potAfter * f)));
  const list: [string, number][] = [["Min", r.min_to], ["½ pot", at(0.5)], ["¾ pot", at(0.75)], ["Pot", at(1)], ["All in", r.max_to]];
  return list.filter(([, v], k) => k === 0 || k === list.length - 1 || (v > r.min_to && v < r.max_to));
}

async function act(move: Move, label: string) {
  const g = game();
  if (!room || !g?.hand || sent || room.pending) return;
  sent = { label, hands: g.hands, seq: g.seq, since: Date.now() };
  raiseOpen = false;
  render();
  try {
    await room.move(move);
  } catch (error) {
    sent = null;
    toast(errText(error));
  }
  render();
}

addEventListener("keydown", (e) => {
  if (document.body.dataset.screen !== "table" || (e.target instanceof HTMLInputElement && e.key !== "Enter")) return;
  const k = e.key.toLowerCase();
  const pick = (sel: string) => document.querySelector<HTMLButtonElement>(sel)?.click();
  if (k === "f") pick('[data-act="fold"]');
  else if (k === "c") {
    pick('[data-act="check"]');
    pick('[data-act="call"]');
  } else if (k === "r") pick("#ropen");
  else if (k === "a") pick('[data-act="allin"]');
  else if (k === "enter") pick("#rgo");
  else if (k === "escape") pick("#rcancel");
});

function leave() {
  if (room && room.phase === "playing" && !practice && !confirm("Leave the game? Your seat stays in: each of your turns checks or folds on the clock.")) return;
  room?.leave();
  room = null;
  show("title");
}

// ------------------------------------------------------------------ the end

function showResult(end: MakeoEnd) {
  const g = game();
  const outcome = end.outcome;
  const me = myWallet();
  let head = "Game over";
  let rows = "";
  const seatOfWallet = (w: string) => (g ? g.players.findIndex((x) => x.toLowerCase() === w.toLowerCase()) : -1);
  if (outcome && outcome.kind === "Ranking") {
    const tiers = outcome.tiers;
    const won = !!me && tiers[0]?.some((w) => w.toLowerCase() === me);
    head = won ? (tiers[0].length > 1 ? "You split the pot" : "You win the pot") : `${esc(nameOf(tiers[0][0], seatOfWallet(tiers[0][0])))} wins`;
    let place = 1;
    rows = tiers
      .map((tier) => {
        const r = tier
          .map((w) => {
            const s = seatOfWallet(w);
            const chips = g && s >= 0 ? `${g.chips[s]} chips${g.busted[s] ? ` · out in hand ${g.busted[s]}` : ""}` : "";
            return `<div class="trow"><b style="width:28px">${place}</b><div><div class="tn">${esc(nameOf(w, s))}</div><div class="tm">${chips}</div></div></div>`;
          })
          .join("");
        place += tier.length;
        return r;
      })
      .join("");
  } else if (outcome && outcome.kind === "Void") head = "Game called off";
  const voidLine = outcome && outcome.kind === "Void" ? `<p>${esc(outcome.reason)} · every entry was refunded.</p>` : "";
  const paid = room?.kind === "paid";
  const payoutLine = end.payout?.error || (end.payout?.finalAfter && end.payout.finalAfter < Date.now() && end.payout.phase !== "settled") ? `<p>Payout delayed.</p>` : "";
  sheet(
    `<div class="kicker">${practice ? "Practice" : paid ? "Paid match" : "Free match"}</div><h3>${head}</h3>${voidLine}${payoutLine}<div style="display:grid;gap:6px">${rows}</div>
     ${g ? `<p>${g.hands} hands played. The final state is public: open the Receipt to check every opened card and the settlement data.</p>` : ""}
     <div style="display:flex;gap:8px;flex-wrap:wrap">${paid ? `<button class="btn sunny" id="payout">See payout</button>` : ""}<button class="btn zip" id="endrcpt">Receipt</button><button class="btn" id="again">Play again</button></div>`,
    "",
  );
  const pay = document.getElementById("payout");
  if (pay) pay.onclick = async () => void (await Makeo.games())?.contests.showResult(room?.id ?? "");
  $("#endrcpt").onclick = () => {
    closeSheet();
    show("receipt");
  };
  $("#again").onclick = () => {
    closeSheet();
    room?.leave();
    room = null;
    show("title");
  };
}

// ------------------------------------------------------------------ clock

function tick() {
  const g = game();
  const hand = g?.hand;
  if (hand && hand.turn !== null && hand.deadline_ms && document.body.dataset.screen === "table") {
    const left = Math.max(0, hand.deadline_ms - Date.now());
    const clock = document.querySelector<HTMLElement>(".seat.turn .clock");
    if (clock) {
      clock.style.setProperty("--p", String(Math.min(1, left / 25_000)));
      clock.classList.toggle("low", left < 6000);
    }
    const secs = document.getElementById("secs");
    if (secs) secs.textContent = ` · ${Math.ceil(left / 1000)}s`;
  }
  const nd = document.getElementById("nextdeal");
  if (nd && g?.next_deal_ms) nd.textContent = `${Math.max(0, Math.ceil((g.next_deal_ms - Date.now()) / 1000))}s`;
  const lc = document.getElementById("lobbyclock");
  if (lc && room?.lobby.deadline) {
    const m = Math.max(0, room.lobby.deadline - Date.now());
    lc.textContent = `${Math.floor(m / 60000)}:${String(Math.floor((m % 60000) / 1000)).padStart(2, "0")}`;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ------------------------------------------------------------------ log and bar

function log(html: string) {
  logLines.push(html);
  if (logLines.length > 200) logLines.shift();
}
function drawLog() {
  const el = $("#loglines");
  el.innerHTML = logLines.map((l) => `<div>${l}</div>`).join("");
  el.scrollTop = el.scrollHeight;
}
function drawBar() {
  const info = $("#tableinfo");
  const btns = $("#barbtns");
  const screen = document.body.dataset.screen;
  const g = game();
  if (screen === "table" && room) {
    const kind = practice ? "Practice" : room.lobby?.entry ? "Paid match" : "Free match";
    const level = g
      ? `<span class="sep"></span>Blinds ${g.blinds[0]}/${g.blinds[1]}${g.next_blinds[1] !== g.blinds[1] && !g.finished ? ` · ${g.next_blinds[0]}/${g.next_blinds[1]} next hand` : ""}<span class="sep"></span>Hand ${g.hands} of ${g.max_hands}`
      : "";
    info.innerHTML = `<b>${kind}</b>${level}${practice ? '<span class="chip">no money</span>' : ""}${autoplay ? '<span class="chip ai">autoplay</span>' : ""}`;
    btns.innerHTML = "";
  } else if (screen === "receipt") {
    info.innerHTML = `<b>Receipt</b>`;
    btns.innerHTML = `<button class="btn sm ghost" id="rback">${room ? "Back to the table" : "Back"}</button>`;
    $("#rback").onclick = () => show(room ? "table" : "title");
  } else {
    info.innerHTML = "";
    btns.innerHTML = "";
  }
}

// ------------------------------------------------------------------ receipt

async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return "0x" + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** The rules' commitment to a card: SHA-256 of `{"domain":…,"value":{"card":c,"salt":s}}`, keys sorted. */
const commitOf = (domain: string, card: Card, salt: string) => sha256Hex(JSON.stringify({ domain, value: { card, salt } }));

async function drawReceipt() {
  const wrap = $("#rwrap");
  const hands = [...records.values()].sort((a, b) => b.id - a.id);
  let checks = 0;
  let good = 0;
  const handHTML: string[] = [];
  for (const r of hands) {
    const h = r.last;
    const domain = r.commitments.domain;
    const rows: string[] = [];
    for (const [k, o] of (h.openings?.board ?? []).entries()) {
      const ok = (await commitOf(domain, o.card, o.salt)) === r.commitments.board[k];
      checks++;
      if (ok) good++;
      rows.push(`<div class="crow"><span>Board ${k + 1}</span><span class="minicards">${cardHTML(o.card)}</span><span class="h">${esc(r.commitments.board[k])}</span><span class="${ok ? "ok" : "no"}">${ok ? "✓ matches" : "✗ mismatch"}</span></div>`);
    }
    for (let k = (h.openings?.board ?? []).length; k < 5; k++) rows.push(`<div class="crow"><span>Board ${k + 1}</span><span></span><span class="h">${esc(r.commitments.board[k])}</span><span class="seal">never dealt · sealed</span></div>`);
    for (let i = 0; i < r.players.length; i++) {
      const opened = h.openings?.hole?.[i] ?? (i === r.me ? r.mine?.openings : null);
      const nm = nameAt(r, i);
      if (opened) {
        const oks = await Promise.all(opened.map((o, j) => commitOf(domain, o.card, o.salt).then((x) => x === r.commitments.hole[i][j])));
        const ok = oks.every(Boolean);
        checks++;
        if (ok) good++;
        const why = h.showdown?.shown[i] ? "shown down" : "your own, opened to you only";
        rows.push(`<div class="crow"><span>${esc(nm)}</span><span class="minicards">${opened.map((o) => cardHTML(o.card)).join("")}</span><span class="h">${esc(why)} · ${esc(r.commitments.hole[i][0].slice(0, 18))}…</span><span class="${ok ? "ok" : "no"}">${ok ? "✓ matches" : "✗ mismatch"}</span></div>`);
      } else {
        rows.push(`<div class="crow"><span>${esc(nm)}</span><span class="minicards">${cardHTML(null)}${cardHTML(null)}</span><span class="h">${esc(r.commitments.hole[i][0].slice(0, 18))}…</span><span class="seal">${h.folded[i] ? "folded · never opened" : "sealed"}</span></div>`);
      }
    }
    const result = h.street === "Showdown" ? `${h.showdown?.names.filter(Boolean).length} hands shown` : h.street === "Folded" ? "won without a showdown" : "in play";
    handHTML.push(`<details class="hand" ${r === hands[0] ? "open" : ""}><summary><b>Hand ${r.id}</b><span class="chip">${esc(result)}</span><span class="minicards">${(h.board ?? []).map((c) => cardHTML(c)).join("")}</span></summary><div class="body">${rows.join("")}</div></details>`);
  }
  const allOk = checks > 0 && good === checks;
  for (const r of aiReceipts) await checkReceipt(r);
  const g = game();
  const settle = g?.finished
    ? `<div class="hashbox"><span class="k">Winners</span><span class="val">${g.winners.map((w) => esc(w)).join("<br>")}</span><span class="k">Shares (chips)</span><span class="val">${g.shares.join(" · ")}</span><span class="k">Final state</span><span class="val">${esc(await sha256Hex(JSON.stringify(g.state ?? null)))} · SHA-256 of the published JSON</span></div>`
    : `<div class="empty">When the game ends, its winners, their chip shares and the full final state are published here and settle the pot.</div>`;
  wrap.innerHTML = `
    <div class="rh"><div><div class="kicker">Receipt</div><h1>Check the deal yourself</h1><p>The keeper, an attested AWS Nitro enclave, deals every hand. At the deal it publishes a salted SHA-256 commitment to each hole card and each of the five board cards, before anyone bets. Below, your browser recomputes every card that was opened. Folded hands are never opened during play.</p></div>
      <div class="allok ${checks && !allOk ? "bad" : ""}">${checks ? `${good} of ${checks} openings match` : "No hands yet"}</div></div>
    <div class="panel check"><div class="ck-h"><div class="ck-n">1</div><div><div class="ck-t">Cards were fixed before the first bet</div><div class="ck-d">Commitment = SHA-256 of <code>{"domain":"makeo:holdem:card:v1","value":{"card":n,"salt":s}}</code>. The board's five commitments exist from the deal, so the turn and river cannot be changed later.</div></div><div class="ck-ok ${checks && !allOk ? "bad" : checks ? "" : "wait"}">${checks ? (allOk ? "✓ all match" : "✗ check failed") : "play a hand"}</div></div>
      ${handHTML.join("") || `<div class="empty">Play a hand and its commitments appear here.</div>`}</div>
    <div class="panel check"><div class="ck-h"><div class="ck-n">2</div><div><div class="ck-t">Every AI decision came from attested private inference</div><div class="ck-d">AI players run on NEAR AI Cloud inside a TEE. Each decision's request and response are hashed and signed by the enclave's key; the runner checks the attestation (<code>verify/nearai.ts</code>) and publishes every receipt, with the AI's private reasoning, once the game ends.</div></div><div class="ck-ok ${aiReceipts.length ? "" : "wait"}">${aiReceipts.length ? `${aiReceipts.filter((r) => r.verified).length}/${aiReceipts.length} verified` : practice ? "practice CPUs are scripted" : "no receipts loaded"}</div></div>
      ${aiReceiptsHTML()}
      <div class="dropzone"><button class="btn sm pip" id="demorcpt">Load a live AI run</button><label class="btn sm ghost">Load receipts file<input type="file" id="rfile" accept="application/json" hidden></label><span>or open this page with <code>?receipts=&lt;url&gt;</code></span></div></div>
    <div class="panel check"><div class="ck-h"><div class="ck-n">3</div><div><div class="ck-t">The result settles on NEAR</div><div class="ck-d">The keeper signs the game's final step. Once the game ends its full final state is public, with the winners and their chip shares; the NEAR pot contract checks it against the keeper's signed hash and pays the winners (<code>verify/near.ts</code>, <code>verify/keeper.ts</code>). The seed is published too, so anyone can replay every hand with these rules.</div></div></div>${settle}</div>
    <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap"><button class="btn ghost" id="rback2">${room ? "Back to the table" : "Back"}</button></div>`;
  $("#rback2").onclick = () => show(room ? "table" : "title");
  const demo = document.getElementById("demorcpt");
  if (demo)
    demo.onclick = async () => {
      try {
        loadReceipts(await (await fetch("./demo-receipts.json")).json());
        void drawReceipt();
      } catch {
        toast("Couldn't load the demo receipts");
      }
    };
  const file = document.getElementById("rfile") as HTMLInputElement | null;
  if (file)
    file.onchange = async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        loadReceipts(JSON.parse(await f.text()));
        void drawReceipt();
      } catch {
        toast("That file isn't a receipts file");
      }
    };
}

function loadReceipts(json: any) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.receipts) ? json.receipts : [];
  aiReceipts = list.filter((r: any) => r && typeof r === "object" && "seat" in r);
  aiEvidence = new Map((Array.isArray(json?.evidence) ? json.evidence : []).map((e: any) => [String(e.chat_id), e]));
  aiChecks.clear();
}

/** Rechecks a receipt here: the request and response hash to what was signed, and the EIP-191
 * signature over `signed_text` recovers to the receipt's signing address (the model's TEE key). */
async function checkReceipt(r: any) {
  const id = String(r.chat_id ?? "");
  if (aiChecks.has(id)) return aiChecks.get(id)!;
  let hashes = false;
  let recovered: string | null = null;
  try {
    const ev = aiEvidence.get(id);
    if (ev) {
      const req = (await sha256Hex(ev.request_body)).slice(2);
      const res = (await sha256Hex(ev.response_body)).slice(2);
      hashes = req === r.request_sha256 && res === r.response_sha256 && String(r.signed_text ?? "").endsWith(`${req}:${res}`);
    }
    if (r.signature && r.signed_text) {
      const msg = new TextEncoder().encode(String(r.signed_text));
      const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`);
      const digest = keccak_256(new Uint8Array([...prefix, ...msg]));
      const sig = String(r.signature).replace(/^0x/, "");
      const v = parseInt(sig.slice(128, 130), 16);
      const pub = secp256k1.Signature.fromCompact(sig.slice(0, 128)).addRecoveryBit(v >= 27 ? v - 27 : v).recoverPublicKey(digest).toRawBytes(false);
      const addr = keccak_256(pub.slice(1)).slice(-20);
      recovered = "0x" + [...addr].map((b: number) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    /* shown as not rechecked */
  }
  const out = { hashes, recovered };
  aiChecks.set(id, out);
  return out;
}

function aiReceiptsHTML() {
  if (!aiReceipts.length) return "";
  const bySeat = new Map<string, any[]>();
  for (const r of aiReceipts) bySeat.set(String(r.seat), [...(bySeat.get(String(r.seat)) ?? []), r]);
  return [...bySeat.entries()]
    .map(([seat, rs]) => {
      const ok = rs.filter((r) => {
        const c = aiChecks.get(String(r.chat_id ?? ""));
        return r.verified && c?.hashes && c.recovered?.toLowerCase() === String(r.signing_address).toLowerCase();
      }).length;
      const moves = rs
        .map((r) => {
          const m = r.move && typeof r.move === "object" ? (r.move.move === "raise" ? `raise to ${r.move.to}` : r.move.move) : String(r.move);
          const c = aiChecks.get(String(r.chat_id ?? ""));
          const here = c && c.recovered && c.recovered.toLowerCase() === String(r.signing_address).toLowerCase() && c.hashes;
          const sig = r.signature ? `sig ${String(r.signature).slice(0, 10)}…${String(r.signature).slice(-6)} ${here ? "✓ rechecked here" : r.verified ? "✓ runner" : "✗"}` : r.fallback ? `scripted: ${r.fallback}` : "unsigned";
          return `<div class="amv"><span>Hand ${esc(r.round)}</span><span>${esc(m)}${r.say ? ` · “${esc(r.say)}”` : ""}</span><span class="sig">${esc(sig)}</span>${r.reasoning ? `<div class="why">${esc(r.reasoning)}</div>` : ""}</div>`;
        })
        .join("");
      const first = rs[0];
      return `<div class="aiseat"><div class="ah"><span class="av" style="--c:${colorOf(seat)}">AI</span><div><b>${esc(first.name ?? nameOf(seat, -1))}</b><div class="mono" style="font-size:11px;color:var(--dim)">${esc(first.model ?? "")} · signer ${esc(short(String(first.signing_address ?? "—")))}</div></div><span class="ck-ok">${ok}/${rs.length} rechecked in your browser</span></div>${moves}</div>`;
    })
    .join("");
}

// ------------------------------------------------------------------ boot

(async () => {
  const url = new URL(location.href).searchParams.get("receipts");
  if (url) {
    try {
      loadReceipts(await (await fetch(url)).json());
    } catch {
      /* receipts are optional */
    }
  }
})();

show("title");
void enter(() => Makeo.room() as Promise<MakeoRoom<MatchView> | null>);
