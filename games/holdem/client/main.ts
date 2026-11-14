// NEAR Hold'em: the table page. Everything shown comes from the rules' view (room.view); the page
// never evaluates a hand or decides a pot. Moves go through room.table.act, sealed to the keeper.
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
} from "../shared/holdem.js";

type TableView = MakeoTableView<HandView>;
type Ended = { seats: number[]; players: { wallet: string; stack: number }[]; button: number; game: HandView };

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const short = (w: string) => (w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w);

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

let room: MakeoRoom<TableView> | null = null;
let practice = false;
let cpuCount = 3;
let menuStep: "root" | "free" | "paid" = "root";
let sitting = false;
let raiseOpen = false;
let raiseTo = 0;
let sent: { label: string; hand: number; seq: number; since: number } | null = null;
let staged: { ended: Ended; changes: Record<string, number>; until: number; hand: number } | null = null;
let lastSeen: { hand: number; game: HandView } | null = null;
const dealtKeys = new Set<string>();
const logLines: string[] = [];
type HandRecord = {
  id: number;
  seats: number[];
  players: { wallet: string; name: string }[];
  me: number | null;
  commitments: HandView["commitments"];
  mine: { hole: [Card, Card]; openings: { card: Card; salt: string }[] } | null;
  live: HandView;
  end: HandView | null;
  changes: Record<string, number> | null;
};
const records = new Map<number, HandRecord>();
let aiReceipts: any[] = [];
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
function sheet(html: string) {
  $("#sheetcard").innerHTML = `${html}<button class="btn ghost" id="sheetclose">Close</button>`;
  $("#sheet").classList.add("on");
  $("#sheetclose").onclick = () => $("#sheet").classList.remove("on");
}
$("#sheet").addEventListener("click", (e) => {
  if (e.target === $("#sheet")) $("#sheet").classList.remove("on");
});
function show(screen: "title" | "table" | "receipt") {
  document.body.dataset.screen = screen;
  if (screen === "title") drawTitle();
  if (screen === "receipt") void drawReceipt();
  drawBar();
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
  const stars = Array.from({ length: 90 }, () => ({ x: Math.random(), y: Math.random() * 0.8, r: Math.random() * 1.2 + 0.2, p: Math.random() * 6 }));
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
  free: "Free play costs nothing and saves nothing. Practice runs this exact build of the rules in your browser against computer players.",
  cpu: "You against 1 to 5 computer players, with the same blinds, timers and showdowns as a real table. Labelled practice: no money moves.",
  paid: "Sit at a table with chips bought for test money in the preview. Leave whenever you like: Makeo's sheet cashes you out.",
  open: "The public table at this stake. Your buy-in becomes your chips; you sit at the first open seat.",
  host: "A private table you host: share its link, and start dealing once two or more have sat. Invite AI players by sending them the link.",
};

function drawTitle() {
  const m = $("#menu");
  const choice = (id: string, label: string, detail: string, cls = "") =>
    `<div class="choice"><button class="btn ${cls}" data-go="${id}">${label}<small>${detail}</small></button><button class="info" data-info="${id}" aria-label="About ${label}">i</button></div>`;
  if (menuStep === "root") {
    m.innerHTML = choice("free", "Free play", "Practice against computer players", "") + choice("paid", "Paid table", "Chips for test money · leave any time", "sunny") +
      `<button class="back-link" data-go="fair">How the cards stay fair</button>`;
  } else if (menuStep === "free") {
    m.innerHTML = choice("cpu", "Practice vs CPU", "Just you, vs bots") +
      `<div class="stepper">Opponents <button data-cpu="-1" aria-label="Fewer">−</button><b id="cpun">${cpuCount}</b><button data-cpu="1" aria-label="More">+</button></div>` +
      `<button class="back-link" data-go="root">Back</button>`;
  } else {
    m.innerHTML = choice("open", "Join the table", "Blinds 1/2 · buy in 100 chips", "sunny") + choice("host", "Host a private table", "Invite link · you start the deal", "ghost") +
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
  void drawTables();
}

function go(id: string) {
  if (id === "root" || id === "free" || id === "paid") {
    menuStep = id;
    drawTitle();
  } else if (id === "fair") show("receipt");
  else if (id === "cpu") void startPractice();
  else if (id === "open") void enter(() => Makeo.open({ stake: "0.01" }) as Promise<MakeoRoom<TableView>>);
  else if (id === "host") void enter(() => Makeo.open({ stake: "0.01", private: true }) as Promise<MakeoRoom<TableView>>);
}

async function drawTables() {
  const box = $("#tables");
  if (menuStep !== "paid") {
    box.innerHTML = "";
    return;
  }
  try {
    const games = await Makeo.games();
    const list = ((await games?.contests.list({ status: "open" })) ?? []) as any[];
    const tables = list.filter((l) => (l.preset ?? l.format) === "table" && !l.contest?.view?.lobby);
    if (!tables.length) {
      box.innerHTML = `<div class="empty">No tables are open right now. Join the table above to open one.</div>`;
      return;
    }
    box.innerHTML = tables
      .map((l, k) => {
        const seats = Object.values(l.contest?.view?.seats ?? {}) as any[];
        const playing = l.contest?.view?.hand ? "hand on" : "between hands";
        return `<div class="trow"><div><div class="tn">Table · ${esc(l.stake)} ${esc(l.token)} a chip</div><div class="tm">${seats.length} of 6 seated · blinds 1/2 · ${playing}</div></div><button class="btn sm" data-join="${k}">Join</button></div>`;
      })
      .join("");
    box.querySelectorAll<HTMLElement>("[data-join]").forEach((b) => (b.onclick = () => void enter(() => Makeo.join(tables[Number(b.dataset.join)].room) as Promise<MakeoRoom<TableView>>)));
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
  await enter(() => Makeo.open({ with: "cpu", seats: cpuCount + 1, seat: 0, controllers }) as Promise<MakeoRoom<TableView>>);
}

async function enter(open: () => Promise<MakeoRoom<TableView> | null>) {
  try {
    const next = await open();
    if (!next) return show("title");
    room?.leave();
    room = next;
    practice = next.kind === "practice";
    records.clear();
    logLines.length = 0;
    staged = null;
    lastSeen = null;
    sent = null;
    next.onChange(onView);
    next.onPlayers(() => render());
    next.onLobby(() => render());
    next.onStart(() => show("table"));
    next.onEnd(() => {
      toast("The table has closed. Everyone was cashed out.", 4000);
      room = null;
      show("title");
    });
    next.table?.onHandEnd((hand: any) => onHandEnd(hand));
    show("table");
    if (next.view) onView(next.view);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!/closed|cancel/i.test(msg)) toast(msg);
    show("title");
  }
}

function myWallet(): string | null {
  return room?.me?.id?.toLowerCase() ?? null;
}

function onView(view: TableView) {
  if (!room) return;
  const me = myWallet();
  // Sit down once: at the first open seat.
  if (me && view.seats && !Object.values(view.seats).some((s) => s.wallet.toLowerCase() === me) && view.phase !== "Closed" && !sitting && room.table) {
    const taken = new Set(Object.keys(view.seats).map(Number));
    const max = seatCount();
    let seat = 0;
    while (taken.has(seat) && seat < max) seat++;
    if (seat < max) {
      sitting = true;
      room.table
        .sit(seat)
        .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e)))
        .finally(() => (sitting = false));
    }
  }
  const h = view.hand;
  if (h && h.game) {
    noteHand(h.id, h.seats, h.players, h.game);
    if (staged && Date.now() >= staged.until) staged = null;
    // A new hand while a showdown is still on: let the showdown finish only if it isn't our turn.
    if (staged && staged.hand !== h.id) {
      const mine = seatOf(h.game, me);
      if (mine !== null && h.game.turn === mine) staged = null;
    }
  }
  if (sent && (!h || h.id !== sent.hand || (h.game?.seq ?? 0) > sent.seq)) sent = null;
  render();
}

function noteHand(id: number, seats: number[], players: { wallet: string; stack: number }[], game: HandView) {
  const me = seatOf(game, myWallet());
  let rec = records.get(id);
  if (!rec) {
    rec = { id, seats, players: players.map((p, i) => ({ wallet: p.wallet, name: nameOf(p.wallet, seats[i]) })), me, commitments: game.commitments, mine: null, live: game, end: null, changes: null };
    records.set(id, rec);
    if (records.size > 30) records.delete(Math.min(...records.keys()));
    log(`<div class="hh">HAND ${id}</div>`);
    if (me !== null && game.hole[me]) log(`You hold <b>${game.hole[me]!.map(cardText).join(" ")}</b>`);
  }
  if (me !== null && game.hole[me] && game.openings.hole[me]) rec.mine = { hole: game.hole[me]!, openings: game.openings.hole[me]! };
  // Narrate what changed since the last view of this hand.
  if (lastSeen && lastSeen.hand === id) narrate(rec, lastSeen.game, game);
  rec.live = game;
  lastSeen = { hand: id, game };
}

/** "You calls" → "You call": second person for this player. */
function you(name: string, phrase: string) {
  if (name !== "You") return phrase;
  const [verb, ...rest] = phrase.split(" ");
  const base: Record<string, string> = { calls: "call", checks: "check", raises: "raise", bets: "bet", is: "are", folds: "fold", shows: "show", wins: "win" };
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

function narrate(rec: HandRecord, a: HandView, game: HandView) {
  for (let i = 0; i < game.players.length; i++) {
    const d = game.last[i];
    const was = a.last[i];
    if (d && JSON.stringify(d) !== JSON.stringify(was) && !/blind/.test(d.act)) log(`<b>${esc(nameAt(rec, i))}</b> ${you(nameAt(rec, i), actWords(d.act, d.to))}`);
    else if (!d && game.folded[i] && !a.folded[i]) log(`<b>${esc(nameAt(rec, i))}</b> ${you(nameAt(rec, i), "folds")}`);
  }
  if (game.board.length > a.board.length) {
    const b = game.board.length;
    const street = a.board.length === 0 && b === 5 ? "Board" : b === 3 ? "Flop" : b === 4 ? "Turn" : a.board.length < 4 ? "Board" : "River";
    log(`${street}: <b>${game.board.slice(a.board.length).map(cardText).join(" ")}</b>`);
  }
}

function onHandEnd(hand: { hand: number; changes: Record<string, number>; void: boolean; public_hand?: Ended | null }) {
  const end = hand.public_hand;
  if (!end || !end.game) return;
  const rec = records.get(hand.hand);
  if (rec) {
    rec.end = end.game;
    rec.changes = hand.changes;
  } else {
    records.set(hand.hand, {
      id: hand.hand, seats: end.seats, players: end.players.map((p, i) => ({ wallet: p.wallet, name: nameOf(p.wallet, end.seats[i]) })), me: null,
      commitments: end.game.commitments, mine: null, live: end.game, end: end.game, changes: hand.changes,
    });
  }
  const r = records.get(hand.hand)!;
  const g = end.game;
  if (lastSeen && lastSeen.hand === hand.hand) {
    narrate(r, lastSeen.game, g);
    lastSeen = null;
  }
  const mineDelta = myWallet() ? hand.changes[myWallet()!] ?? hand.changes[Object.keys(hand.changes).find((k) => k.toLowerCase() === myWallet()) ?? ""] : undefined;
  if (g.street === "Showdown" && g.showdown) {
    staged = { ended: end, changes: hand.changes, until: Date.now() + 7200, hand: hand.hand };
    for (let i = 0; i < g.players.length; i++) if (g.showdown.shown[i]) log(`<span class="sd"><b>${esc(nameAt(r, i))}</b> ${you(nameAt(r, i), "shows")} ${g.hole[i]!.map(cardText).join(" ")} · ${esc(g.showdown.names[i])}</span>`);
    for (const [k, pot] of g.showdown.pots.entries()) {
      const who = pot.winners.map((w) => nameAt(r, w)).join(" and ");
      log(`<span class="sd"><b>${esc(who)}</b> ${pot.winners.length > 1 ? "split" : you(who, "wins")} the ${k === 0 ? "pot" : "side pot"} · ${pot.amount}</span>`);
    }
  } else {
    const w = g.won ? g.won.findIndex((x, i) => x > 0 && !g.folded[i]) : -1;
    if (w >= 0) {
      log(`<b>${esc(nameAt(r, w))}</b> takes the pot · ${g.pot}`);
      toast(`${w === r.me ? "You take" : nameAt(r, w) + " takes"} the pot · ${g.pot}`);
    }
  }
  if (mineDelta) log(`Your hand: <b class="net ${mineDelta > 0 ? "up" : "down"}">${mineDelta > 0 ? "+" : ""}${mineDelta} chips</b>`);
  render();
}

// ------------------------------------------------------------------ names

function nameOf(wallet: string, physical: number): string {
  if (myWallet() && wallet.toLowerCase() === myWallet()) return "You";
  const players = room?.players ?? [];
  const p = players.find((x) => x.id?.toLowerCase() === wallet.toLowerCase()) ?? players.find((x) => x.seat === physical);
  return p?.name || `Player ${short(wallet)}`;
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
  for (const ch of wallet) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

// ------------------------------------------------------------------ layout

function seatCount(): number {
  const max = room?.lobby?.max;
  return practice ? cpuCount + 1 : Math.max(2, Math.min(6, typeof max === "number" && max > 0 ? max : 6));
}
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

/** Where physical seat `s` sits on screen: this player at the bottom, the rest clockwise. */
function slotOf(s: number, mySeat: number | null, n: number) {
  const k = (s - (mySeat ?? 0) + n) % n;
  const angle = 90 + (360 / n) * k;
  return angle;
}
function polar(angle: number, fx: number, fy: number, pad: number) {
  const felt = $("#felt").getBoundingClientRect();
  const stage = $("#stage").getBoundingClientRect();
  const cx = felt.left - stage.left + felt.width / 2;
  const cy = felt.top - stage.top + felt.height / 2;
  const a = (angle * Math.PI) / 180;
  return { x: cx + Math.cos(a) * (felt.width / 2 * fx + pad), y: cy + Math.sin(a) * (felt.height / 2 * fy + pad) };
}

// ------------------------------------------------------------------ the table

function render() {
  if (document.body.dataset.screen !== "table" || !room) {
    drawBar();
    return;
  }
  fitFelt();
  const view = room.view;
  const live = view?.hand && view.hand.game ? view.hand : null;
  const showing = staged && Date.now() < staged.until ? staged : null;
  const seats = showing ? showing.ended.seats : live?.seats ?? [];
  const players = showing ? showing.ended.players : live?.players ?? [];
  const game: HandView | null = showing ? showing.ended.game : live?.game ?? null;
  const me = myWallet();
  const n = seatCount();
  const mySeatPhysical = (() => {
    const entry = Object.entries(view?.seats ?? {}).find(([, s]) => s.wallet.toLowerCase() === me);
    return entry ? Number(entry[0]) : null;
  })();
  const myIndex = game ? seatOf(game, me) : null;
  const handId = showing ? showing.hand : live?.id ?? 0;
  const rec = records.get(handId);

  // Board and pot.
  const board = game?.board ?? [];
  const best = new Set<number>();
  if (showing && game?.showdown) {
    for (const pot of game.showdown.pots) for (const w of pot.winners) for (const c of game.showdown.best[w] ?? []) best.add(c);
  }
  $("#board").innerHTML = [0, 1, 2, 3, 4]
    .map((k) => {
      if (k >= board.length) return `<div class="slot"></div>`;
      const c = board[k];
      const key = `${handId}:b${k}`;
      const fresh = !dealtKeys.has(key);
      dealtKeys.add(key);
      return cardHTML(c, `${fresh ? "flip" : ""} ${showing ? (best.has(c) ? "win" : "dim") : ""}`);
    })
    .join("");
  if (game) {
    const pots = game.showdown?.pots ?? [];
    $("#pot").innerHTML = `<span class="stack"></span>Pot ${game.pot}${pots.length > 1 ? `<span class="side">main ${pots[0].amount} · ${pots.slice(1).map((p) => `side ${p.amount}`).join(" · ")}</span>` : ""}`;
  } else $("#pot").innerHTML = "";

  // Seats.
  const seatsEl = $("#seats");
  let html = "";
  for (let s = 0; s < n; s++) {
    const angle = slotOf(s, mySeatPhysical, n);
    const pos = polar(angle, 1, 1, 34);
    const i = seats.indexOf(s);
    const sitter = view?.seats?.[String(s)];
    if (i < 0 || !game) {
      if (sitter) {
        const nm = nameOf(sitter.wallet, s);
        const kind = kindOf(sitter.wallet, nm);
        html += `<div class="seat out" style="left:${pos.x}px;top:${pos.y}px">${plate(sitter.wallet, nm, kind, sitter.stack, false, null)}<div class="did">${game ? "next hand" : "seated"}</div></div>`;
      } else html += `<div class="emptyseat" style="left:${pos.x}px;top:${pos.y}px">Open seat</div>`;
      continue;
    }
    const p = players[i];
    const nm = nameOf(p.wallet, s);
    const kind = kindOf(p.wallet, nm);
    const turn = !showing && game.turn === i;
    const folded = game.folded[i];
    const shown = !!game.showdown?.shown[i];
    const hole = game.hole[i];
    let cards = "";
    if (hole) {
      const win = showing && game.showdown?.pots.some((pt) => pt.winners.includes(i));
      cards = hole.map((c, k) => {
        const key = `${handId}:h${i}:${k}:${shown ? "s" : "o"}`;
        const fresh = !dealtKeys.has(key);
        dealtKeys.add(key);
        return cardHTML(c, `${fresh ? (shown && i !== myIndex ? "flip" : "deal") : ""} ${showing ? (win && best.has(c) ? "win" : "dim") : ""} ${folded ? "sealed" : ""}`);
      }).join("");
    } else if (!folded && !(game.street === "Folded")) {
      cards = [0, 1].map((k) => {
        const key = `${handId}:h${i}:${k}:b`;
        const fresh = !dealtKeys.has(key);
        dealtKeys.add(key);
        return cardHTML(null, fresh ? "deal" : "");
      }).join("");
    }
    const stack = game.left[i] + (showing && game.won ? game.won[i] : 0);
    const d = game.last[i];
    let under = d ? `<div class="did ${/raise|bet|all/.test(d.act) ? "hot" : ""}">${esc(d.act === "all in" ? "all in" : d.act)}</div>` : `<div class="did"></div>`;
    if (folded) under = `<div class="did">folded</div>`;
    if (showing) {
      const delta = showing.changes[p.wallet] ?? showing.changes[p.wallet.toLowerCase()] ?? 0;
      under = `<div class="hn">${esc(game.showdown?.names[i] ?? "")}</div>${delta ? `<div class="net ${delta > 0 ? "up" : "down"}">${delta > 0 ? "+" : ""}${delta}</div>` : ""}`;
    }
    html += `<div class="seat ${kind === "you" ? "me" : ""} ${turn ? "turn" : ""} ${folded ? "folded" : ""}" style="left:${pos.x}px;top:${pos.y}px" data-i="${i}">
      <div class="cards">${cards}</div>${plate(p.wallet, nm, kind, stack, turn, game.all_in[i] ? "ALL IN" : null)}${under}</div>`;
    // Chips in front of the seat, and the button.
    if (!showing && game.street_bet[i] > 0 && isBetting(game)) {
      const b = polar(angle, 0.66, 0.8, 0);
      html += `<div class="bet" style="left:${b.x}px;top:${b.y}px"><i></i>${game.street_bet[i]}</div>`;
    }
    if (i === game.button) {
      const b = polar(angle + 360 / n / 3.2, 0.82, 0.78, 0);
      html += `<div class="dealer" style="left:${b.x}px;top:${b.y}px">D</div>`;
    }
  }
  seatsEl.innerHTML = html;

  // How a showdown ended, under the board.
  let banner = "";
  if (showing && game?.showdown) {
    const r = records.get(showing.hand);
    const main = game.showdown.pots[0];
    const who = main.winners.map((w) => (r ? nameAt(r, w) : `Seat ${w + 1}`)).join(" & ");
    const what = game.showdown.names[main.winners[0]] ?? "";
    const myDelta = me ? Object.entries(showing.changes).find(([k]) => k.toLowerCase() === me)?.[1] : undefined;
    banner = `<div class="banner"><div class="w">${esc(who)} ${main.winners.length > 1 ? "split the pot" : who === "You" ? "win" : "wins"} · ${esc(what)}</div>${myDelta ? `<div class="m net ${myDelta > 0 ? "up" : "down"}">${myDelta > 0 ? "+" : ""}${myDelta} chips for you</div>` : ""}</div>`;
  }

  // The note under the board.
  let note = "";
  if (view?.phase === "Lobby") note = lobbyNote(view);
  else if (!game) note = Object.keys(view?.seats ?? {}).length < 2 ? "Waiting for another player to sit down" : "Shuffling the next hand…";
  else if (game.street === "Folded") note = "";
  else if (!showing && game.turn === null && isBetting(game) === false) note = "";
  $("#note").innerHTML = banner || note;
  $("#note").querySelector<HTMLElement>("#copylink")?.addEventListener("click", () => {
    void navigator.clipboard?.writeText(location.href).then(() => toast("Invite link copied"));
  });
  $("#note").querySelector<HTMLElement>("#startbtn")?.addEventListener("click", () => {
    room?.table?.start().catch((e: unknown) => toast(e instanceof Error ? e.message : String(e)));
  });

  drawDock(game && !showing ? game : null, myIndex);
  if (autoplay && live && live.game && !sent && !autoTimer) {
    const g = live.game;
    const mine = seatOf(g, me);
    if (mine !== null && g.options?.player === mine && isBetting(g)) {
      autoTimer = setTimeout(() => {
        autoTimer = null;
        const now = room?.view?.hand?.game;
        if (!now || now.seq !== g.seq) return render();
        const move = scriptedMove(now, mine, autoRandom, { aggression: 0.55, looseness: 0.55 });
        if (move) void act(move, move.move);
      }, 900);
    }
  }
  drawLog();
  drawBar();
}

function plate(wallet: string, name: string, kind: string, stack: number, turn: boolean, flag: string | null) {
  const tag = kind === "you" ? `<span class="tag you">You</span>` : kind === "ai" ? `<span class="tag ai">AI · TEE</span>` : kind === "cpu" ? `<span class="tag cpu">CPU</span>` : "";
  return `<div class="plate">${turn ? `<span class="clock"></span>` : ""}<span class="av" style="--c:${colorOf(wallet)}">${esc(name.slice(0, 1).toUpperCase())}</span><div><div class="nm">${esc(name)}</div><div class="sk">${flag ?? stack}</div></div>${tag}</div>`;
}

function lobbyNote(view: TableView) {
  const seated = Object.keys(view.seats ?? {}).length;
  const host = view.host?.toLowerCase() === myWallet();
  const link = `<button class="btn sm ghost" id="copylink">Copy invite link</button>`;
  if (host) return `<div style="display:grid;gap:8px;justify-items:center"><div><b>${seated}</b> seated · up to 6</div><div style="display:flex;gap:8px">${link}<button class="btn sm" id="startbtn" ${seated >= 2 ? "" : "disabled"}>Start with ${seated}</button></div>${seated < 2 ? "<div>Needs 2 to start · 1 more</div>" : ""}</div>`;
  const hostName = view.host ? nameOf(view.host, -1) : "the host";
  return `<div style="display:grid;gap:8px;justify-items:center"><div>Waiting for <b>${esc(hostName)}</b> to start · ${seated} seated</div>${link}</div>`;
}

// ------------------------------------------------------------------ my moves

function drawDock(game: HandView | null, me: number | null) {
  const dock = $("#dock");
  const o = game?.options;
  const mine = !!(game && o && me !== null && o.player === me && isBetting(game));
  if (!mine) raiseOpen = false;
  let status = "";
  if (game && isBetting(game) && game.turn !== null && !mine) {
    const r = records.get(room?.view?.hand?.id ?? -1);
    const who = r ? nameAt(r, game.turn) : "Next player";
    status = `<b>${esc(who)}</b> is thinking<span id="secs"></span>`;
  } else if (game && me !== null && game.folded[me]) status = "You folded. Your cards stay sealed.";
  if (sent) status = Date.now() - sent.since > 1500 ? "The dealer is checking your move…" : "Sending…";
  if (!mine) {
    dock.innerHTML = `<div class="status">${status}</div><div class="acts"><button class="btn sm ghost" id="leavebtn">Leave table</button><button class="btn sm ghost" id="rcptbtn">Receipt</button></div>`;
  } else {
    const busy = (l: string) => (sent ? (sent.label === l ? "busy" : "") : "");
    const dis = sent ? "disabled" : "";
    const range = o!.raise;
    if (range && (raiseTo < range.min_to || raiseTo > range.max_to)) raiseTo = range.min_to;
    const callBtn = o!.check
      ? `<button class="btn ${busy("check")}" data-act="check" ${dis}>Check<span class="k">C</span></button>`
      : `<button class="btn ${busy("call")}" data-act="call" ${dis}>Call ${o!.call}<span class="k">C</span></button>`;
    const raiseWord = game!.current_bet === 0 ? "Bet" : "Raise";
    const raisebox = raiseOpen && range
      ? `<div class="raisebox"><div class="row"><div class="amt" id="ramt">${raiseTo}</div><input type="range" id="rslider" min="${range.min_to}" max="${range.max_to}" step="1" value="${raiseTo}" aria-label="${raiseWord} to"></div>
         <div class="presets">${presets(game!, o!).map(([l, v]) => `<button data-pre="${v}" class="${v === raiseTo ? "on" : ""}">${l}</button>`).join("")}</div>
         <div class="row"><button class="btn ghost sm" id="rcancel" style="flex:1">Back</button><button class="btn sunny ${busy("raise")}" id="rgo" style="flex:2" ${dis}>${raiseTo === range.max_to ? "All in" : `${raiseWord} to ${raiseTo}`}</button></div></div>`
      : "";
    dock.innerHTML = `<div class="status">${status || `Your move · <span id="secs"></span>`}</div>${raisebox}
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
    if (slider) slider.oninput = () => {
      raiseTo = Number(slider.value);
      $("#ramt").textContent = String(raiseTo);
      const go = $("#rgo");
      go.textContent = raiseTo === range!.max_to ? "All in" : `${raiseWord} to ${raiseTo}`;
    };
    dock.querySelectorAll<HTMLElement>("[data-pre]").forEach((b) => (b.onclick = () => ((raiseTo = Number(b.dataset.pre)), render())));
    const rc = dock.querySelector<HTMLElement>("#rcancel");
    if (rc) rc.onclick = () => ((raiseOpen = false), render());
    const rg = dock.querySelector<HTMLElement>("#rgo");
    if (rg) rg.onclick = () => void act(raiseTo === range!.max_to ? { move: "allin" } : { move: "raise", to: raiseTo }, "raise");
  }
  const lb = dock.querySelector<HTMLElement>("#leavebtn");
  if (lb) lb.onclick = () => void leaveTable();
  const rb = dock.querySelector<HTMLElement>("#rcptbtn");
  if (rb) rb.onclick = () => show("receipt");
  if (!raiseOpen) document.documentElement.style.setProperty("--dockh", `${dock.offsetHeight || 150}px`);
}

function presets(game: HandView, o: NonNullable<HandView["options"]>): [string, number][] {
  const r = o.raise!;
  const potAfter = game.pot + o.call;
  const at = (f: number) => Math.max(r.min_to, Math.min(r.max_to, game.current_bet + Math.round(potAfter * f)));
  const list: [string, number][] = [["Min", r.min_to], ["½ pot", at(0.5)], ["¾ pot", at(0.75)], ["Pot", at(1)], ["All in", r.max_to]];
  return list.filter(([, v], k) => k === 0 || k === list.length - 1 || (v > r.min_to && v < r.max_to));
}

async function act(move: Move, label: string) {
  const view = room?.view;
  const h = view?.hand;
  if (!room?.table || !h || !h.game || sent) return;
  sent = { label, hand: h.id, seq: h.game.seq, since: Date.now() };
  raiseOpen = false;
  render();
  try {
    await room.table.act(move);
  } catch (error) {
    sent = null;
    toast(error instanceof Error ? error.message : String(error));
  }
  render();
}

addEventListener("keydown", (e) => {
  if (document.body.dataset.screen !== "table" || e.target instanceof HTMLInputElement && e.key !== "Enter") return;
  const k = e.key.toLowerCase();
  const pick = (sel: string) => document.querySelector<HTMLButtonElement>(sel)?.click();
  if (k === "f") pick('[data-act="fold"]');
  else if (k === "c") pick('[data-act="check"]') ?? pick('[data-act="call"]');
  else if (k === "r") pick("#ropen");
  else if (k === "a") pick('[data-act="allin"]');
  else if (k === "enter") pick("#rgo");
  else if (k === "escape") pick("#rcancel");
});

async function leaveTable() {
  if (!room) return show("title");
  try {
    const out = room.table ? await room.table.leave() : { left: true };
    if (out.left) {
      room.leave();
      room = null;
      show("title");
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
  }
}

// ------------------------------------------------------------------ clock

function tick() {
  const g = room?.view?.hand?.game;
  if (g && g.turn !== null && g.deadline_ms && document.body.dataset.screen === "table") {
    const total = 25_000;
    const left = Math.max(0, g.deadline_ms - Date.now());
    const p = Math.min(1, left / total);
    const clock = document.querySelector<HTMLElement>(".seat.turn .clock");
    if (clock) {
      clock.style.setProperty("--p", String(p));
      clock.classList.toggle("low", left < 6000);
    }
    const secs = document.getElementById("secs");
    if (secs) secs.textContent = ` · ${Math.ceil(left / 1000)}s`;
  }
  if (staged && Date.now() >= staged.until) {
    staged = null;
    render();
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ------------------------------------------------------------------ log and bar

function log(html: string) {
  logLines.push(html);
  if (logLines.length > 160) logLines.shift();
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
  if (screen === "table" && room) {
    const h = room.view?.hand;
    info.innerHTML = `<b>${practice ? "Practice" : room.view?.lobby ? "Private table" : "Table"}</b><span class="sep"></span>Blinds 1/2<span class="sep"></span>${h ? `Hand ${h.id}` : "Between hands"}${practice ? '<span class="chip">no money</span>' : ""}${autoplay ? '<span class="chip ai">autoplay</span>' : ""}`;
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
    const g = r.end ?? r.live;
    const domain = r.commitments.domain;
    const rows: string[] = [];
    // Board: opened as dealt.
    for (const [k, o] of (g.openings?.board ?? []).entries()) {
      const ok = (await commitOf(domain, o.card, o.salt)) === r.commitments.board[k];
      checks++;
      if (ok) good++;
      rows.push(`<div class="crow"><span>Board ${k + 1}</span><span class="minicards">${cardHTML(o.card)}</span><span class="h">${esc(r.commitments.board[k])}</span><span class="${ok ? "ok" : "no"}">${ok ? "✓ matches" : "✗ mismatch"}</span></div>`);
    }
    for (let k = (g.openings?.board ?? []).length; k < 5; k++) rows.push(`<div class="crow"><span>Board ${k + 1}</span><span></span><span class="h">${esc(r.commitments.board[k])}</span><span class="seal">never dealt · sealed</span></div>`);
    // Hole cards: shown hands and this player's own; folded hands stay sealed.
    for (let i = 0; i < r.players.length; i++) {
      const opened = g.openings?.hole?.[i] ?? (i === r.me ? r.mine?.openings : null);
      const nm = nameAt(r, i);
      if (opened) {
        const oks = await Promise.all(opened.map((o, j) => commitOf(domain, o.card, o.salt).then((h) => h === r.commitments.hole[i][j])));
        const ok = oks.every(Boolean);
        checks++;
        if (ok) good++;
        const why = g.showdown?.shown[i] ? "shown down" : "your own, opened to you only";
        rows.push(`<div class="crow"><span>${esc(nm)}</span><span class="minicards">${opened.map((o) => cardHTML(o.card)).join("")}</span><span class="h">${esc(why)} · ${esc(r.commitments.hole[i][0].slice(0, 18))}…</span><span class="${ok ? "ok" : "no"}">${ok ? "✓ matches" : "✗ mismatch"}</span></div>`);
      } else {
        rows.push(`<div class="crow"><span>${esc(nm)}</span><span class="minicards">${cardHTML(null)}${cardHTML(null)}</span><span class="h">${esc(r.commitments.hole[i][0].slice(0, 18))}…</span><span class="seal">${g.folded[i] ? "folded · never opened" : "sealed"}</span></div>`);
      }
    }
    const result = g.street === "Showdown" ? g.showdown?.names.filter(Boolean).length + " hands shown" : g.street === "Folded" ? "won without a showdown" : "in play";
    handHTML.push(`<details class="hand" ${r === hands[0] ? "open" : ""}><summary><b>Hand ${r.id}</b><span class="chip">${esc(result)}</span><span class="minicards">${(g.board ?? []).map((c) => cardHTML(c)).join("")}</span></summary><div class="body">${rows.join("")}</div></details>`);
  }
  const allOk = checks > 0 && good === checks;
  const ai = aiReceiptsHTML();
  wrap.innerHTML = `
    <div class="rh"><div><div class="kicker">Receipt</div><h1>Check the deal yourself</h1><p>The keeper, an attested AWS Nitro enclave, deals every hand. At the deal it publishes a salted SHA-256 commitment to each hole card and each of the five board cards, before anyone bets. Below, your browser recomputes every card that was opened. Folded hands are never opened.</p></div>
      <div class="allok ${checks && !allOk ? "bad" : ""}">${checks ? `${good} of ${checks} openings match` : "No hands yet"}</div></div>
    <div class="panel check"><div class="ck-h"><div class="ck-n">1</div><div><div class="ck-t">Cards were fixed before the first bet</div><div class="ck-d">Commitment = SHA-256 of <code>{"domain":"makeo:holdem:card:v1","value":{"card":n,"salt":s}}</code>. The board's five commitments exist from the deal, so the turn and river cannot be changed later.</div></div><div class="ck-ok ${checks && !allOk ? "bad" : checks ? "" : "wait"}">${checks ? (allOk ? "✓ all match" : "✗ check failed") : "play a hand"}</div></div>
      ${handHTML.join("") || `<div class="empty">Play a hand and its commitments appear here.</div>`}</div>
    <div class="panel check"><div class="ck-h"><div class="ck-n">2</div><div><div class="ck-t">Every AI decision came from attested private inference</div><div class="ck-d">AI seats run on NEAR AI Cloud inside a TEE. Each decision's request and response are hashed and signed by the enclave's key; the runner checks the attestation (<code>verify/nearai.ts</code>) and publishes every receipt, with the AI's private reasoning, once the table closes.</div></div><div class="ck-ok ${aiReceipts.length ? "" : "wait"}">${aiReceipts.length ? `${aiReceipts.filter((r) => r.verified).length}/${aiReceipts.length} verified` : practice ? "practice CPUs are scripted" : "no receipts loaded"}</div></div>
      ${ai}
      <div class="dropzone"><label class="btn sm ghost">Load receipts file<input type="file" id="rfile" accept="application/json" hidden></label><span>or open this page with <code>?receipts=&lt;url&gt;</code></span></div></div>
    <div class="panel check"><div class="ck-h"><div class="ck-n">3</div><div><div class="ck-t">The keeper is attested code</div><div class="ck-d">The table's seed is committed in its manifest before play and published when the table closes, so anyone can replay every hand with the rules in this repository. The keeper's signing key comes from an AWS Nitro attestation (<code>verify/keeper.ts</code>), and the pot settles on NEAR only on a result that key signed.</div></div></div></div>
    <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap"><button class="btn ghost" id="rback2">${room ? "Back to the table" : "Back"}</button></div>`;
  $("#rback2").onclick = () => show(room ? "table" : "title");
  const file = document.getElementById("rfile") as HTMLInputElement | null;
  if (file) file.onchange = async () => {
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
}

function aiReceiptsHTML() {
  if (!aiReceipts.length) return "";
  const bySeat = new Map<string, any[]>();
  for (const r of aiReceipts) bySeat.set(String(r.seat), [...(bySeat.get(String(r.seat)) ?? []), r]);
  return [...bySeat.entries()]
    .map(([seat, rs]) => {
      const ok = rs.filter((r) => r.verified).length;
      const moves = rs
        .map((r) => {
          const m = r.move && typeof r.move === "object" ? (r.move.move === "raise" ? `raise to ${r.move.to}` : r.move.move) : String(r.move);
          const sig = r.signature ? `sig ${String(r.signature).slice(0, 10)}…${String(r.signature).slice(-6)} ${r.verified ? "✓" : "✗"}` : r.fallback ? `scripted: ${r.fallback}` : "unsigned";
          return `<div class="amv"><span>Hand ${esc(r.round)}</span><span>${esc(m)}${r.say ? ` · “${esc(r.say)}”` : ""}</span><span class="sig">${esc(sig)}</span>${r.reasoning ? `<div class="why">${esc(r.reasoning)}</div>` : ""}</div>`;
        })
        .join("");
      const first = rs[0];
      return `<div class="aiseat"><div class="ah"><span class="av" style="--c:${colorOf(seat)}">AI</span><div><b>${esc(nameOf(seat, -1))}</b><div class="mono" style="font-size:11px;color:var(--dim)">${esc(first.model ?? "")} · signer ${esc(short(String(first.signing_address ?? "—")))}</div></div><span class="ck-ok">${ok}/${rs.length} verified</span></div>${moves}</div>`;
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
void enter(() => Makeo.room() as Promise<MakeoRoom<TableView> | null>);
