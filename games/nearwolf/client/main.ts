// NEARWOLF's page: the mock's look (Keo as the moon, seats around the fire, the public ledger, the
// Receipt) drawn from the real room. Every seat sees only its own view from the rules; the page
// never guesses a secret, never animates a choice it can't see, and reveals who sat where only
// when the rules say the game is over.
import {
  type Entry,
  type GameView,
  type Move,
  type Role,
  type Speech,
  PERSONAS,
  ROLES,
  LINE_MAX,
  alive as aliveSeats,
  contradictions,
  persona,
  scriptedMove,
  speechText,
} from "../shared/nearwolf.js";
import "./adapter.js";

/* ---------------- constants (makeo.toml [rules]) ---------------- */
const PHASE_MS: Record<string, number> = { night: 30000, dawn: 7000, council: 50000, pyre: 30000, dusk: 7000, end: 1 };
const PRACTICE_SEATS = 7;
/** NEAR pot (contracts/makeo-pot, SPEC "Contract interface"). Null until platform-near deploys it. */
const NEAR_POT: { network: string; contract: string | null; stakes: string[] } = { network: "testnet", contract: null, stakes: ["1", "5"] };

/* ---------------- tiny DOM helpers ---------------- */
const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const $$ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => [...r.querySelectorAll(s)] as T[];
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const ic = (id: string, cls = "") => `<svg class="i ${cls}"><use href="#${id}"/></svg>`;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const ROLE_ICON: Record<Role, string> = { wolf: "i-paw", seer: "i-eye", healer: "i-shield", villager: "i-wheat" };
const rtag = (r: Role, iconOn = true) => `<span class="rtag" style="--rc:${ROLES[r].color}">${iconOn ? ic(ROLE_ICON[r]) : ""}${ROLES[r].name}</span>`;

let toastT = 0;
function toast(m: string) {
  const t = $("#toast");
  t.innerHTML = esc(m);
  t.classList.add("on");
  clearTimeout(toastT);
  toastT = window.setTimeout(() => t.classList.remove("on"), 2800);
}

/* ---------------- state ---------------- */
type Screen = "landing" | "lobby" | "reveal" | "game" | "receipt";
let room: MakeoRoom | null = null;
let v: GameView | null = null;
let screen: Screen = "landing";
let ended = false;
let draft: { kind: Speech["kind"] | null; target: number | null; role: Role | null; wolf: boolean; line: string } = { kind: null, target: null, role: null, wolf: true, line: "" };
let phaseKey = "";
let recTab: "ledger" | "moves" = "ledger";
let revealedFor = "";
let sending = false;
let focusEl: Element | null = null;
const shownBurns = new Set<string>();

const me = () => v?.you ?? null;
const nm = (i: number) => (v && i === me() ? "You" : v ? persona(v, i).name : `Seat ${i + 1}`);
const fullName = (i: number) => (v ? `${persona(v, i).name}` : "");
const color = (i: number) => (v ? persona(v, i).color : "#888");
const isAlive = (i: number) => !!v?.seats[i]?.alive;
const myRole = () => v?.role ?? null;
const meAlive = () => me() != null && isAlive(me()!);

function show(id: Screen) {
  $$(".screen").forEach((s) => s.classList.toggle("on", s.id === id));
  screen = id;
  document.body.dataset.screen = id;
  window.scrollTo(0, 0);
}

/* ---------------- Keo (the moon) and avatars ---------------- */
function keoHTML(size: number | string) {
  return `<div class="keo" style="--size:${typeof size === "number" ? size + "px" : size}"><div class="keo-halo"></div><div class="keo-halo-r"></div><div class="keo-body"><div class="keo-blood"></div>
<div class="keo-crater" style="left:62%;top:20%;width:16%;height:16%"></div><div class="keo-crater" style="left:16%;top:60%;width:12%;height:12%"></div><div class="keo-crater" style="left:70%;top:66%;width:9%;height:9%"></div>
<div class="keo-face"><i class="keo-cheek l"></i><i class="keo-cheek r"></i><i class="keo-eye l"></i><i class="keo-eye r"></i><i class="keo-mouth"></i></div><div class="keo-gloss"></div></div></div>`;
}
$("#moonLanding").innerHTML = keoHTML("min(220px,48vw)");
$("#moonCard").innerHTML = keoHTML(110);
$("#moonGame").innerHTML = keoHTML(108);
const avHTML = (c: string, extra = "") => `<div class="av" style="--c:${c}" ${extra}><div class="eyes"><i></i><i></i></div></div>`;
const mini = (i: number, cls = "") => `<span class="mini ${cls} ${isAlive(i) || ended ? "" : "dead"}" style="--c:${color(i)}"></span>`;

/* ---------------- stars, glow, eyes ---------------- */
const cv = $<HTMLCanvasElement>("#stars");
const cx = cv.getContext("2d")!;
let stars: Array<{ x: number; y: number; r: number; p: number; s: number }> = [];
function initStars() {
  const d = Math.min(devicePixelRatio || 1, 2);
  cv.width = innerWidth * d;
  cv.height = innerHeight * d;
  cv.style.width = innerWidth + "px";
  cv.style.height = innerHeight + "px";
  stars = Array.from({ length: Math.round((innerWidth * innerHeight) / 7000) }, () => ({ x: Math.random() * cv.width, y: Math.random() * cv.height * 0.85, r: rand(0.3, 1.3) * d, p: rand(0, 6.28), s: rand(0.4, 1.4) }));
}
initStars();
addEventListener("resize", () => {
  initStars();
  placeSeats();
});
function drawStars(t: number) {
  if (cv.style.width !== innerWidth + "px" || cv.style.height !== innerHeight + "px") initStars();
  cx.clearRect(0, 0, cv.width, cv.height);
  const day = screen === "game" && v != null && ["council", "pyre", "dusk"].includes(v.phase);
  for (const s of stars) {
    const a = (0.35 + 0.65 * (0.5 + 0.5 * Math.sin((t / 1000) * s.s + s.p))) * (day ? 0.45 : 1);
    cx.globalAlpha = a * 0.8;
    cx.fillStyle = "#e9e6ff";
    cx.beginPath();
    cx.arc(s.x, s.y, s.r, 0, 6.283);
    cx.fill();
  }
}
let px = innerWidth / 2,
  py = innerHeight / 3,
  gx = px,
  gy = py;
addEventListener(
  "pointermove",
  (e) => {
    px = e.clientX;
    py = e.clientY;
    const b = (e.target as Element).closest?.(".btn,.pick,.mv") as HTMLElement | null;
    if (b) {
      const r = b.getBoundingClientRect();
      b.style.setProperty("--mx", e.clientX - r.left + "px");
      b.style.setProperty("--my", e.clientY - r.top + "px");
    }
    const rc = $("#rcard");
    if (screen === "reveal" && rc) {
      const r = rc.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / r.width,
        dy = (e.clientY - (r.top + r.height / 2)) / r.height;
      const flip = rc.classList.contains("flip");
      rc.style.transform = `${flip ? "rotateY(180deg)" : ""} rotateX(${dy * -8}deg) rotateY(${dx * (flip ? -10 : 10)}deg)`;
    }
  },
  { passive: true },
);
const eyeState = new WeakMap<Element, { x: number; y: number }>();
function trackEyes() {
  for (const k of $$(".keo")) {
    if (!k.offsetParent) continue;
    const r = k.getBoundingClientRect();
    const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    let tx = px,
      ty = py;
    const f = focusEl && focusEl.isConnected ? focusEl : null;
    if (f) {
      const fr = f.getBoundingClientRect();
      tx = fr.left + fr.width / 2;
      ty = fr.top + fr.height / 2;
    }
    let dx = tx - c.x,
      dy = ty - c.y;
    const d = Math.hypot(dx, dy) || 1;
    const m = Math.min(1, d / 400) * r.width * 0.07;
    dx = (dx / d) * m;
    dy = (dy / d) * m;
    const s = eyeState.get(k) || { x: 0, y: 0 };
    s.x += (dx - s.x) * 0.08;
    s.y += (dy - s.y) * 0.08;
    eyeState.set(k, s);
    ($(".keo-face", k) as HTMLElement).style.transform = `translate(${s.x}px,${s.y}px)`;
  }
}
setInterval(() => {
  $$(".keo").forEach((k) => {
    if (Math.random() < 0.5) {
      k.classList.add("blink");
      setTimeout(() => k.classList.remove("blink"), 150);
    }
  });
  const avs = $$("#seats .seat:not(.dead) .av,.lring .av");
  if (avs.length) {
    const a = avs[Math.floor(Math.random() * avs.length)];
    a.classList.add("blink");
    setTimeout(() => a.classList.remove("blink"), 140);
  }
}, 1400);

/* ---------------- landing ---------------- */
function renderDist(n: number) {
  const w = Math.max(1, Math.floor(n / 4));
  const seer = n >= 5,
    healer = n >= 6;
  const vil = n - w - (seer ? 1 : 0) - (healer ? 1 : 0);
  $("#distLabel").innerHTML = `${rtag("wolf")}<span style="color:var(--muted)">×${w}</span>${seer ? rtag("seer") : ""}${healer ? rtag("healer") : ""}${rtag("villager")}<span style="color:var(--muted)">×${vil}</span>`;
}
renderDist(PRACTICE_SEATS);
renderPot();

function renderPot() {
  const c = NEAR_POT.contract;
  $("#potCard").innerHTML = `<div class="pk">${ic("i-near")}Pot on NEAR</div>
    <div class="pr"><span>Free play</span><b>no stake · no pot</b></div>
    <div class="pr"><span>Paid match</span><b>entry ${NEAR_POT.stakes.join(" or ")} · winners split the pot</b></div>
    <div class="pr"><span>NEAR ${esc(NEAR_POT.network)} pot</span><span class="st ${c ? "live" : ""}"><i></i>${c ? `<b>${esc(c)}</b>` : "contract not live yet: free play"}</span></div>`;
}

function menuStep(step: "main" | "free") {
  ($("#menuMain") as HTMLElement).hidden = step !== "main";
  ($("#menuFree") as HTMLElement).hidden = step !== "free";
}
$("#menu").addEventListener("click", (e) => {
  const b = (e.target as Element).closest("[data-go]") as HTMLElement | null;
  if (!b) return;
  const go = b.dataset.go;
  $("#menuErr").textContent = "";
  if (go === "free") return menuStep("free");
  if (go === "back") return menuStep("main");
  if (go === "cpu") return void enter(() => Makeo.open({ with: "cpu", seats: PRACTICE_SEATS, controllers: cpuSeats() }));
  if (go === "friends") return void enter(() => Makeo.open({ with: "friends", seats: 12 }));
  if (go === "paid") return void enter(() => Makeo.open({ with: "money", private: true }));
});

/** The page's CPU seats in practice: each plays the scripted player from its own view. */
function cpuSeats(): MakeoCpuControllers {
  const out: MakeoCpuControllers = {};
  for (let s = 1; s < PRACTICE_SEATS; s++) {
    out[s] = {
      name: PERSONAS[s].name,
      delayMs: 900 + s * 350,
      play: (view: any, _seat, rng) => {
        const g: GameView | null = view?.game ?? (view?.seats ? view : null);
        return g ? scriptedMove(g, rng) : null;
      },
    };
  }
  return out;
}

/* ---------------- the one way into a room ---------------- */
async function enter(open: () => Promise<MakeoRoom | null>) {
  try {
    const next = await open();
    if (!next) return showTitle();
    room?.leave();
    room = next;
    ended = false;
    v = null;
    phaseKey = "";
    $("#endov").classList.remove("on");
    next.onLobby(drawLobby);
    next.onPlayers(() => drawLobby(next.lobby));
    next.onStart(onStart);
    next.onChange(onView);
    next.onEnd(onEnd);
    if (next.phase === "lobby") {
      show("lobby");
      drawLobby(next.lobby);
    }
    renderRoomInfo();
  } catch (error) {
    showTitle();
    const m = error instanceof Error ? error.message : String(error);
    if (m && !/closed|cancel/i.test(m)) $("#menuErr").textContent = m;
  }
}

function showTitle() {
  show("landing");
  menuStep("main");
  document.body.dataset.sky = "night";
}

function renderRoomInfo() {
  const r = room;
  const n = v?.seats.length ?? r?.lobby.max ?? PRACTICE_SEATS;
  if (!r) {
    $("#roomInfo").innerHTML = "";
    return;
  }
  const kind = r.kind === "practice" ? `<span class="practice-tag">PRACTICE</span>` : r.kind === "paid" ? `<span>Paid match</span>` : `<span>Free match</span>`;
  $("#keeperLbl").textContent = r.hidden ? "Keeper-dealt" : "Practice";
  $("#keeperOk").textContent = r.hidden ? "hidden game" : "in your browser";
  $("#roomInfo").innerHTML = `${kind}<span class="sep"></span><span><b>${n}</b> seats</span><span class="sep"></span><span>${r.hidden ? "Keeper-dealt" : "In your browser"}</span>`;
}

/* ---------------- lobby ---------------- */
function drawLobby(lobby: MakeoLobby) {
  if (!room || room.phase !== "lobby") return;
  if (screen !== "lobby") show("lobby");
  const L = $("#lring");
  $$(".slot", L).forEach((s) => s.remove());
  const seats = lobby.seats.length ? lobby.seats : [];
  const n = Math.max(seats.length, 1);
  seats.forEach((s, i) => {
    const a = ((90 + (i * 360) / n) * Math.PI) / 180;
    const el = document.createElement("div");
    el.className = "slot" + (s.id ? " in" : "");
    el.style.left = 50 + 40 * Math.cos(a) + "%";
    el.style.top = 50 + 40 * Math.sin(a) + "%";
    const c = PERSONAS[i % PERSONAS.length].color;
    el.innerHTML = avHTML(s.id ? c : "#3a4066") + (s.id ? `<span class="cn ${s.status ?? "connected"}"></span><span class="nm2">${esc(s.id === room!.me?.id ? "You" : s.name ?? "Player")}</span>` : `<span class="nm2">Open seat</span>`);
    L.appendChild(el);
  });
  $("#lmid").innerHTML = keoHTML("clamp(80px,26vw,110px)");
  const joined = seats.filter((s) => s.id).length;
  const kind = lobby.entry ? `Paid match · ${lobby.entry.stake} ${lobby.entry.token} · ${lobby.access === "invite" ? "invite only" : "discoverable"}` : "Free match · invite only";
  $("#lstat").textContent = `${joined} joined · up to ${lobby.max}`;
  $("#lsub").textContent = `${kind}. When the host starts, the keeper deals the roles and the house fills the fire to seven seats. Every seat looks the same.`;
  const host = lobby.seats.find((s) => s.id === lobby.host);
  const link = room.link ?? location.href;
  let h = `<div class="row"><button class="btn ghost sm" id="copyLink">${ic("i-ext")}Copy invite link</button></div>`;
  if (!room.me) h += `<button class="btn" id="joinBtn">${lobby.entry ? `Join · ${esc(lobby.entry.stake)} ${esc(lobby.entry.token)}` : "Join"}</button>`;
  else if (room.me.host || lobby.canStart) {
    h += `<button class="btn" id="startBtn" ${lobby.canStart ? "" : "disabled"}>${ic("i-flame")}Start with ${joined}</button>`;
    if (joined < lobby.min) h += `<div class="muted">Needs ${lobby.min} to start · ${lobby.min - joined} more</div>`;
  } else h += `<div class="muted">Waiting for ${esc(host?.name ?? "the host")} to start · ${joined} joined</div>`;
  if (lobby.deadline) h += `<div class="muted">Entries close ${new Date(lobby.deadline).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>`;
  $("#lact").innerHTML = h;
  $("#copyLink").onclick = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast("Invite link copied.");
    } catch {
      toast(link);
    }
  };
  const join = $("#joinBtn");
  if (join) join.onclick = () => room?.pay().catch((e) => toast(e?.message ?? String(e)));
  const start = $("#startBtn");
  if (start)
    start.onclick = async () => {
      start.setAttribute("disabled", "");
      try {
        await room!.start();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
        start.removeAttribute("disabled");
      }
    };
  $("#lcommit").classList.toggle("on", !!room.hidden);
  $("#lcommit").innerHTML = room.hidden ? `roles dealt by the <b>Makeo keeper</b> from a secret committed when this room opened` : "";
}

/* ---------------- role reveal ---------------- */
function onStart() {
  const g = room?.view?.game as GameView | null | undefined;
  if (g) v = g;
  renderRoomInfo();
  const key = room?.id ?? "";
  if (v && v.role && revealedFor !== key && v.phase !== "end") {
    revealedFor = key;
    startReveal();
  } else startGame();
}
function startReveal() {
  show("reveal");
  const r = myRole()!;
  const rc = $("#rcard");
  rc.classList.remove("flip");
  rc.style.transform = "";
  ($("#enterBtn") as HTMLElement).style.cssText = "opacity:0;pointer-events:none;transition:opacity .6s";
  $("#rfront").style.setProperty("--rc", ROLES[r].color);
  const pack = r === "wolf" && v ? v.seats.filter((s) => s.role === "wolf" && s.seat !== me()).map((s) => persona(v!, s.seat).name) : [];
  const who = v && me() != null ? `${persona(v, me()!).name}, ${persona(v, me()!).trade}` : "";
  $("#rfront").innerHTML = `<div class="rk">YOU ARE THE</div><div class="ric">${ic(ROLE_ICON[r])}</div><div class="rn">${ROLES[r].name}</div><div class="rd">${esc(ROLES[r].about)}</div>
  ${pack.length ? `<div class="rd" style="margin-top:6px">Your pack: <b>${pack.map(esc).join(", ")}</b></div>` : ""}
  <div class="att">at the fire you are <b>${esc(who)}</b><br>${room?.hidden ? "sealed to you by the Makeo keeper" : "practice: dealt in your browser"}</div>`;
}
function flipCard() {
  const rc = $("#rcard");
  if (rc.classList.contains("flip")) return;
  rc.style.transform = "";
  rc.classList.add("flip");
  setTimeout(() => (($("#enterBtn") as HTMLElement).style.cssText = "opacity:1;transition:opacity .6s"), 700);
}
$("#rcard").addEventListener("click", flipCard);
$("#enterBtn").addEventListener("click", startGame);

/* ---------------- the board ---------------- */
function seatCount() {
  return v?.seats.length ?? 0;
}
function pos(i: number) {
  const n = seatCount() || 9;
  const a = ((90 + (i * 360) / n) * Math.PI) / 180;
  return { x: 50 + 40.5 * Math.cos(a), y: 50 + 40.5 * Math.sin(a) };
}
let builtFor = "";
function buildSeats() {
  if (!v) return;
  const key = `${room?.id}:${v.seats.length}:${v.you}`;
  if (builtFor === key) return;
  builtFor = key;
  const S = $("#seats");
  S.innerHTML = "";
  v.seats.forEach((s, i) => {
    const el = document.createElement("div");
    const p = persona(v!, i);
    el.className = "seat" + (i === me() ? " you" : "");
    el.dataset.i = String(i);
    const q = pos(i);
    const ex = (((50 - q.x) / 40) * 2.2).toFixed(1),
      ey = (((50 - q.y) / 40) * 1.6).toFixed(1);
    el.innerHTML = `<div class="bub"></div><div class="avw">${avHTML(p.color, `style="--c:${p.color};--ex:${ex}px;--ey:${ey}px"`)}<div class="tick">${ic("i-check")}</div><div class="markw"></div><div class="vc"></div></div>
  <div class="nm">${i === me() ? "You" : esc(p.name)}</div><div class="tt">${i === me() ? esc(p.name + ", " + p.trade) : esc(p.trade)}</div><div class="role"></div><div class="hum"></div>`;
    el.addEventListener("click", () => seatClick(i));
    el.addEventListener("mouseenter", () => {
      if (el.classList.contains("pickable")) focusEl = el;
    });
    el.addEventListener("mouseleave", () => (focusEl = draft.target != null ? seatEl(draft.target) : null));
    S.appendChild(el);
  });
  placeSeats();
}
function placeSeats() {
  $$("#seats .seat").forEach((s) => {
    const q = pos(+s.dataset.i!);
    s.style.left = q.x + "%";
    s.style.top = q.y + "%";
  });
}
const seatEl = (i: number) => $(`#seats .seat[data-i="${i}"]`);

function startGame() {
  show("game");
  buildSeats();
  if (v) onView(room?.view ?? { game: v });
}

function setSky() {
  if (!v) return;
  const p = v.phase;
  document.body.dataset.phase = p;
  document.body.dataset.sky = p === "night" ? "night" : p === "dawn" || p === "end" ? "dawn" : p === "pyre" || p === "dusk" ? "pyre" : "day";
  const f = ({ night: 0.42, dawn: 0.7, council: 0.85, pyre: 1.25, dusk: 1.5, end: 0.9 } as Record<string, number>)[p] ?? 0.5;
  document.documentElement.style.setProperty("--fire", String(f));
  const nights = v.log.filter((e) => e.kind === "dawn").length;
  document.documentElement.style.setProperty("--lum", p === "end" ? "1.5" : (0.7 + 0.2 * nights).toFixed(2));
}
function moonBlood(on: boolean) {
  $$("#moonGame .keo").forEach((k) => k.classList.toggle("blood", on));
}

const lastOf = <K extends Entry["kind"]>(kind: K, round?: number) =>
  [...(v?.log ?? [])].reverse().find((e) => e.kind === kind && (round == null || e.round === round)) as Extract<Entry, { kind: K }> | undefined;

function onView(view: unknown) {
  const g = (view as { game?: GameView | null })?.game ?? null;
  if (!g) return;
  v = g;
  if (screen === "lobby" || screen === "landing") {
    // The board is ready (a reload or a late view): onStart switches screens; draw nothing yet.
    if (room?.phase !== "playing" && v.phase !== "end") return;
  }
  const key = `${v.round}:${v.phase}`;
  if (key !== phaseKey) {
    phaseKey = key;
    draft = { kind: null, target: null, role: null, wolf: true, line: "" };
    focusEl = null;
    enterPhase();
  }
  if (screen === "game") renderAll();
  if (v.phase === "end" && !ended) endGame();
}

function enterPhase() {
  if (!v || screen !== "game") return;
  buildSeats();
  $("#lineG").innerHTML = "";
  $$(".seat .bub,.seat .vc").forEach((b) => b.classList.remove("on"));
  const d = $("#dawn");
  d.classList.remove("on");
  moonBlood(false);
  if (v.phase === "dawn") showDawn();
  if (v.phase === "pyre") drawCouncil();
  if (v.phase === "dusk") drawVotes();
  setSky();
}

function showDawn() {
  const e = lastOf("dawn", v!.round);
  if (!e) return;
  const d = $("#dawn");
  d.className = "dawn panel " + (e.died != null ? "death" : "saved");
  if (e.died != null) {
    moonBlood(true);
    d.innerHTML = `<div class="dk">Dawn · Day ${e.round}</div><div class="dav">${avHTML(color(e.died), `style="--c:${color(e.died)};filter:grayscale(1) brightness(.5)"`)}</div><div class="dt">${esc(e.died === me() ? "You" : fullName(e.died))} did not wake.</div><div class="dd">The keeper reveals: ${rtag(e.role!)}</div>`;
  } else d.innerHTML = `<div class="dk">Dawn · Day ${e.round}</div><div class="dt">Everyone woke.</div><div class="dd">Nobody died in the night.</div>`;
  requestAnimationFrame(() => {
    if (v?.phase === "dawn") d.classList.add("on");
  });
}

function curve(a: number, b: number, col: string, mk: string, op = 0.8) {
  const A = pos(a),
    B = pos(b);
  const C = { x: (A.x + B.x) / 2 + (50 - (A.x + B.x) / 2) * 0.45, y: (A.y + B.y) / 2 + (50 - (A.y + B.y) / 2) * 0.45 };
  const sh2 = (P1: { x: number; y: number }, P2: { x: number; y: number }, d: number) => {
    const dx = P2.x - P1.x,
      dy = P2.y - P1.y,
      l = Math.hypot(dx, dy) || 1;
    return { x: P1.x + (dx / l) * d, y: P1.y + (dy / l) * d };
  };
  const a2 = sh2(A, C, 5.5),
    b2 = sh2(B, C, 6.5);
  const len = Math.hypot(C.x - a2.x, C.y - a2.y) + Math.hypot(b2.x - C.x, b2.y - C.y) + 2;
  return `<path d="M${a2.x} ${a2.y} Q${C.x} ${C.y} ${b2.x} ${b2.y}" stroke="${col}" opacity="${op}" marker-end="url(#ah-${mk})" style="--len:${len}"/>`;
}

/** At the pyre, the council's moves (revealed together) hang over the seats. */
function drawCouncil() {
  const c = lastOf("council", v!.round);
  if (!c) return;
  const paths: string[] = [];
  const ph = phaseKey;
  c.moves.forEach(([i, m], k) => {
    const b = $(".bub", seatEl(i));
    if (!b) return;
    b.textContent = speechText(m, nm);
    setTimeout(() => {
      if (phaseKey === ph) b.classList.add("on");
    }, k * 140);
    if (m.target != null && ["accuse", "vouch", "report"].includes(m.kind)) {
      const good = m.kind === "vouch" || (m.kind === "report" && !m.wolf);
      paths.push(curve(i, m.target, good ? "#3ddc97" : "#ffd166", good ? "g" : "s", 0.5));
    }
  });
  $("#lineG").innerHTML = paths.join("");
}

/** At dusk (and at the end, if the pyre ended it), the votes and who burned. */
function drawVotes() {
  const p = lastOf("pyre", v!.round);
  if (!p) return;
  const paths = p.votes.filter(([, t]) => t != null).map(([i, t]) => curve(i, t!, "#ff8a6b", "e", 0.85));
  $("#lineG").innerHTML = paths.join("");
  const tally: Record<number, number> = {};
  p.votes.forEach(([, t]) => {
    if (t != null) tally[t] = (tally[t] ?? 0) + 1;
  });
  const ph = phaseKey;
  setTimeout(() => {
    if (phaseKey !== ph) return;
    Object.entries(tally).forEach(([i, n]) => {
      const vc = $(".vc", seatEl(+i));
      if (vc) {
        vc.textContent = String(n);
        vc.classList.add("on");
      }
    });
  }, 500);
  const key = `${room?.id}:${p.round}`;
  if (p.burned != null && !shownBurns.has(key)) {
    shownBurns.add(key);
    const s = seatEl(p.burned);
    s?.classList.add("burn");
    setTimeout(() => s?.classList.remove("burn"), 2400);
  }
}

/* ---------------- choosing ---------------- */
function canPick(i: number): boolean {
  if (!v || !isAlive(i) || v.mine != null || !meAlive() || sending || room?.pending) return false;
  const p = v.phase;
  const r = myRole();
  if (p === "night") {
    if (r === "wolf") return v.seats[i].role !== "wolf";
    if (r === "seer") return i !== me();
    if (r === "healer") return i !== v.last_heal;
    return false;
  }
  if (p === "council") return ["report", "accuse", "vouch"].includes(draft.kind ?? "") && i !== me();
  if (p === "pyre") return i !== me();
  return false;
}
function seatClick(i: number) {
  if (!canPick(i)) return;
  draft.target = i;
  focusEl = seatEl(i);
  renderAll();
}

async function send(move: Move) {
  if (!room || room.pending || sending) return;
  sending = true;
  renderSheet();
  try {
    await room.move(move);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
  sending = false;
  renderAll();
}

function seal() {
  if (!v) return;
  const p = v.phase;
  if (p === "night") {
    if (myRole() === "villager") return void send({ move: "night" });
    if (draft.target == null) return;
    return void send({ move: "night", target: draft.target });
  }
  if (p === "council") {
    const d = draft;
    if (!d.kind) return;
    const line = d.line.trim().slice(0, LINE_MAX);
    if (d.kind === "silent") return void send({ move: "council", kind: "silent", line });
    if (d.kind === "claim") return d.role ? void send({ move: "council", kind: "claim", role: d.role, line }) : undefined;
    if (d.target == null) return;
    if (d.kind === "report") return void send({ move: "council", kind: "report", target: d.target, wolf: d.wolf, line });
    return void send({ move: "council", kind: d.kind, target: d.target, line });
  }
  if (p === "pyre") return void send({ move: "vote", target: draft.target });
}

/* ---------------- render ---------------- */
function renderAll() {
  if (!v || screen !== "game") return;
  renderBanner();
  updateSeats();
  renderSheet();
  renderRecord();
}

function renderBanner() {
  if (!v) return;
  const r = v.round,
    p = v.phase,
    sealed = v.mine != null;
  $("#phK").textContent = p === "end" ? "Game over" : (p === "night" ? "Night " : "Day ") + r;
  $("#phT").textContent = ({ night: "Moonrise", dawn: "Dawn", council: "Council", pyre: "The Pyre", dusk: "The Pyre", end: v.winner === "village" ? "Village wins" : "Wolves win" } as Record<string, string>)[p];
  let I = "";
  const role = myRole();
  if (!meAlive() && p !== "end") I = "You are dead. Watch the fire.";
  else if (p === "night") I = sealed ? "Sealed to the keeper. The village sleeps." : role === "wolf" ? "Choose tonight's victim with your pack." : role === "seer" ? "Choose one player to look at." : role === "healer" ? "Choose one player to protect." : "Seal a quiet night.";
  else if (p === "dawn") {
    const e = lastOf("dawn", r);
    I = e?.died != null ? `${nm(e.died)} did not wake.` : "Everyone woke.";
  } else if (p === "council") I = sealed ? "Move sealed. Waiting for the table." : "Pick one move. All moves reveal at once.";
  else if (p === "pyre") I = sealed ? "Vote sealed." : "Read the council. Vote to burn one player.";
  else if (p === "dusk") {
    const e = lastOf("pyre", r);
    I = e?.burned != null ? `${nm(e.burned)} burns.` : "A tie. The pyre stays dark.";
  } else if (p === "end") I = "Roles and seats revealed.";
  $("#phI").textContent = I;
}

function updateClock() {
  if (!v) return;
  const dur = PHASE_MS[v.phase] ?? 1;
  const left = v.phase === "end" ? 0 : Math.max(0, v.deadline_ms - Date.now());
  const f = Math.min(1, left / dur);
  $("#prg").style.strokeDashoffset = (188.5 * (1 - f)).toFixed(1);
  const s = Math.ceil(left / 1000);
  $("#clockT").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const acting = ["night", "council", "pyre"].includes(v.phase);
  $("#clock").classList.toggle("low", acting && left < 5000);
  const sc = $("#sealCount");
  if (v.phase === "end") sc.innerHTML = "";
  else if (acting) sc.innerHTML = room?.pending || sending ? `${ic("i-seal")}sending…` : v.mine != null ? `${ic("i-seal")}you sealed` : meAlive() ? `${ic("i-lock")}not sealed` : "watching";
  else sc.innerHTML = v.phase === "dawn" ? "keeper reveal" : "revealed";
}

function updateSeats() {
  if (!v) return;
  const p = v.phase;
  const selc = p === "pyre" ? "var(--ember)" : p === "council" ? "var(--sunny)" : "var(--zip)";
  document.documentElement.style.setProperty("--selc", selc);
  const looks = v.looks ?? [];
  $$("#seats .seat").forEach((s) => {
    const i = +s.dataset.i!;
    const seat = v!.seats[i];
    s.classList.toggle("dead", !seat.alive);
    s.classList.toggle("sealed", i === me() && v!.mine != null && ["night", "council", "pyre"].includes(p));
    s.classList.toggle("pickable", canPick(i));
    s.classList.toggle("sel", draft.target === i && v!.mine == null);
    const look = [...looks].reverse().find((l) => l.target === i);
    $(".markw", s).innerHTML = look && myRole() === "seer" ? `<div class="mark ${look.wolf ? "w" : "c"}" title="Your vision: ${look.wolf ? "wolf" : "not wolf"}">${ic(look.wolf ? "i-paw" : "i-check")}</div>` : "";
    $(".role", s).innerHTML = seat.role ? rtag(seat.role) : "";
    $(".hum", s).innerHTML = ended ? seatTag(i) : "";
  });
}

function seatTag(i: number) {
  const s = v!.seats[i];
  if (s.house) return `<span class="htag house">House</span>`;
  if (i === me()) return `<span class="htag h">You</span>`;
  const r = receiptsFor(s.wallet);
  return r.length ? `<span class="htag ai">AI · ${esc(r[0].model?.split("/").pop() ?? "")}</span>` : `<span class="htag h">Player</span>`;
}

function picksHTML(filter: (i: number) => boolean, selc: string) {
  return `<div class="picks">${aliveSeats(v!)
    .filter(filter)
    .map((i) => `<button class="pick ${draft.target === i ? "on" : ""}" style="--selc:${selc}" data-pick="${i}">${mini(i)}<span>${esc(nm(i))}<small>${esc(persona(v!, i).trade)}</small></span></button>`)
    .join("")}</div>`;
}

function moveHTML(m: Speech) {
  const t = m.target != null ? `<b>${esc(nm(m.target))}</b>` : "";
  if (m.kind === "claim") return `<span class="tg claim">${ic("i-claim")}Claims</span> <b>${m.role ? ROLES[m.role].name : ""}</b>`;
  if (m.kind === "report") return `<span class="tg report">${ic("i-eye")}Reports</span> saw ${t}: <span class="${m.wolf ? "w-wolf" : "w-clear"}">${m.wolf ? "WOLF" : "not wolf"}</span>`;
  if (m.kind === "accuse") return `<span class="tg accuse">${ic("i-accuse")}Accuses</span> ${t}`;
  if (m.kind === "vouch") return `<span class="tg vouch">${ic("i-vouch")}Vouches for</span> ${t}`;
  return `<span class="tg silent">${ic("i-silent")}Stays silent</span>`;
}

function sealBtn(i: number, r: number, kind: string, tiny = false) {
  return `<button class="sealbtn ${tiny ? "tiny" : ""}" data-seal="${i}" data-r="${r}" data-k="${kind}" aria-label="Inspect seal">${ic("i-seal")}</button>`;
}

function cardHTML(i: number, m: Speech, r: number, k: number, flags: Record<string, { soft?: boolean }>) {
  const flag = flags[`${i}-${r}`];
  return `<div class="mcard ${i === me() ? "you" : ""} ${flag && !flag.soft ? "contra" : ""}" style="animation-delay:${k * 90}ms">${mini(i)}<div><div class="who">${esc(nm(i))}<span>${esc(persona(v!, i).trade)}</span></div><div class="what">${moveHTML(m)}</div>${m.line ? `<div class="line">“${esc(m.line)}”</div>` : ""}</div>${sealBtn(i, r, "move")}</div>`;
}

function sendingNote() {
  return `<div class="sealed-note">${ic("i-seal")}<span>Sealing to the keeper… <span class="muted">${room?.pending && Date.now() - room.pending.since > 1500 ? "the keeper is checking your move" : ""}</span></span></div>`;
}

function renderSheet() {
  if (!v) return;
  const S = $("#sheet");
  const p = v.phase,
    r = v.round,
    role = myRole();
  const busy = !!room?.pending || sending;
  let h = "";
  const dead = !meAlive();
  if (p === "night") {
    h += `<div class="sh-k">${ic("i-moon")}Night ${r} · your private action</div>`;
    if (dead) h += `<div class="quiet"><div class="zz">You are dead.</div>The village sleeps. You watch.</div>`;
    else if (busy) h += sendingNote();
    else if (v.mine == null) {
      if (role === "seer") h += `<div class="sh-t">Who will the moon show you?</div><div class="sh-p">Pick one player. The keeper answers only: wolf, or not wolf. Nobody else sees the answer.</div>${picksHTML((i) => i !== me(), "var(--zip)")}<button class="btn zip wide" id="sealBtn" ${draft.target == null ? "disabled" : ""}>${ic("i-lock")}Seal to the keeper</button>`;
      else if (role === "wolf") {
        const pack = (v.pack ?? []).map((x) => `<div class="wmsg">${mini(x.seat, "sm")}<div><span class="who">${esc(nm(x.seat))}</span> ${x.target != null ? `picks <b>${esc(nm(x.target))}</b>` : "is choosing…"}</div></div>`).join("");
        h += `<div class="sh-t">Who do the wolves take?</div><div class="sh-p">The pack's most-picked seat dies at dawn, unless the Healer guards them.</div>${pack ? `<div class="peek"><div class="pk">Your pack · private</div>${pack}</div>` : ""}${picksHTML((i) => v!.seats[i].role !== "wolf", "var(--ember)")}<button class="btn ember wide" id="sealBtn" ${draft.target == null ? "disabled" : ""}>${ic("i-paw")}Seal the hunt</button>`;
      } else if (role === "healer") h += `<div class="sh-t">Who do you protect?</div><div class="sh-p">If the wolves pick them, they live. ${v.last_heal != null ? `Not ${esc(nm(v.last_heal))} again tonight.` : "You may protect yourself."}</div>${picksHTML((i) => i !== v!.last_heal, "var(--mo)")}<button class="btn wide" id="sealBtn" ${draft.target == null ? "disabled" : ""}>${ic("i-shield")}Seal protection</button>`;
      else h += `<div class="sh-t">You sleep.</div><div class="sh-p">Villagers have no power at night. Seal a quiet night: every seat seals something, so nobody can tell who has a power.</div><button class="btn ghost wide" id="sealBtn">${ic("i-lock")}Seal a quiet night</button>`;
    } else {
      const mine = v.mine as { target?: number | null };
      h += `<div class="sealed-note">${ic("i-seal")}<span>Sealed to the keeper${mine.target != null ? `: <b style="color:var(--text)">${esc(nm(mine.target))}</b>` : ""}.</span></div><div class="quiet"><div class="zz">The village sleeps.</div>${role === "seer" ? "Your vision arrives at dawn." : "Every seat sealed something tonight."}</div>`;
    }
    if (role === "seer" && (v.looks ?? []).length) h += visionsHTML();
  } else if (p === "dawn") {
    const e = lastOf("dawn", r);
    h += `<div class="sh-k">${ic("i-moon")}Dawn · Day ${r}</div><div class="sh-t">${e?.died != null ? `${esc(e.died === me() ? "You" : fullName(e.died))} did not wake.` : "Everyone woke."}</div><div class="sh-p">${e?.died != null ? `The keeper reveals the role: ${rtag(e.role!)}` : "The wolves' victim lived. The keeper does not say why."}</div>`;
    const look = (v.looks ?? []).find((l) => l.round === r);
    if (role === "seer" && look) h += `<div class="result ${look.wolf ? "w" : "c"}"><div class="rav">${avHTML(color(look.target))}</div><div class="rv">${esc(nm(look.target))} is <b>${look.wolf ? "a WOLF" : "not a wolf"}</b></div><div class="rs">sealed to you by the keeper</div></div><div class="sh-p">This stays private. Report it at the council, or keep it to yourself. Others may lie about visions too.</div>`;
    h += `<div class="sh-p">The council opens in a moment.</div>`;
  } else if (p === "council") {
    h += `<div class="sh-k">${ic("i-claim")}Day ${r} · council</div>`;
    if (dead) h += `<div class="quiet">The dead don't speak. Watch the council.</div>`;
    else if (busy) h += sendingNote();
    else if (v.mine == null) {
      const d = draft;
      h += `<div class="sh-t">Make one move</div><div class="sh-p">Everyone picks at the same time. Nothing is shown until the council closes.</div>
      <div class="moves">${(
        [
          ["claim", "i-claim", "Claim"],
          ["report", "i-eye", "Report"],
          ["accuse", "i-accuse", "Accuse"],
          ["vouch", "i-vouch", "Vouch"],
          ["silent", "i-silent", "Silent"],
        ] as const
      )
        .map(([t, icn, l]) => `<button class="mv ${d.kind === t ? "on" : ""}" data-mv="${t}">${ic(icn)}${l}</button>`)
        .join("")}</div>`;
      if (d.kind === "claim") h += `<div class="lbl">Claim the role</div><div class="picks" style="grid-template-columns:repeat(3,1fr)">${(["seer", "healer", "villager"] as Role[]).map((x) => `<button class="pick ${d.role === x ? "on" : ""}" style="--selc:${ROLES[x].color};justify-content:center" data-role="${x}">${ROLES[x].name}</button>`).join("")}</div>`;
      if (d.kind && ["report", "accuse", "vouch"].includes(d.kind)) {
        h += `<div class="lbl">${d.kind === "report" ? "Whose vision" : d.kind === "accuse" ? "Accuse" : "Vouch for"} <span style="text-transform:none;letter-spacing:0;font-weight:400">· or tap a seat</span></div>${picksHTML((i) => i !== me(), "var(--sunny)")}`;
        if (d.kind === "report") h += `<div class="toggle"><button class="w ${d.wolf ? "on" : ""}" data-w="1">WOLF</button><button class="c ${!d.wolf ? "on" : ""}" data-w="0">not wolf</button></div>`;
      }
      if (d.kind) h += `<input class="field" id="lineIn" maxlength="${LINE_MAX}" placeholder="One short line, in character (optional)" value="${esc(d.line)}">`;
      const ok = d.kind === "silent" || (d.kind === "claim" && d.role) || (d.kind != null && ["report", "accuse", "vouch"].includes(d.kind) && d.target != null);
      h += `<button class="btn sunny wide" id="sealBtn" ${ok ? "" : "disabled"}>${ic("i-lock")}Seal move</button>`;
    } else {
      const m = v.mine as Speech;
      h += `<div class="sealed-note">${ic("i-seal")}<span>Your move is sealed.</span></div><div class="mcard you" style="animation:none">${mini(me()!)}<div><div class="who">You</div><div class="what">${moveHTML(m)}</div>${m.line ? `<div class="line">“${esc(m.line)}”</div>` : ""}</div><span></span></div><div class="sh-p">All moves reveal together when the council closes.</div>`;
    }
    if (role === "seer" && (v.looks ?? []).length) h += visionsHTML();
  } else if (p === "pyre") {
    h += `<div class="sh-k">${ic("i-flame")}Day ${r} · the pyre</div>`;
    if (dead) h += `<div class="quiet">The dead don't vote.</div>`;
    else if (busy) h += sendingNote();
    else if (v.mine == null)
      h += `<div class="sh-t">Who burns?</div><div class="sh-p">One vote each. The most votes burns and the keeper reveals their role. A tie burns no one.</div>${picksHTML((i) => i !== me(), "var(--ember)")}
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px"><button class="btn ghost sm" id="abstain">Abstain</button><button class="btn ember" id="sealBtn" ${draft.target == null ? "disabled" : ""}>${ic("i-flame")}Seal vote</button></div>`;
    else {
      const t = (v.mine as { target?: number | null }).target;
      h += `<div class="sealed-note">${ic("i-seal")}<span>Vote sealed${t != null ? `: <b style="color:var(--text)">${esc(nm(t))}</b>` : " · abstain"}.</span></div><div class="sh-p">Votes reveal together.</div>`;
    }
    const c = lastOf("council", r);
    if (c) {
      const { flags } = contradictions(v, nm);
      h += `<div class="sh-k" style="margin-top:6px">${ic("i-ledger")}Day ${r} · moves revealed</div><div class="feed">${c.moves.map(([i, m], k) => cardHTML(i, m, r, k, flags)).join("")}</div>`;
    }
  } else if (p === "dusk" || (p === "end" && lastOf("pyre", r))) {
    const L = lastOf("pyre", r);
    if (L) {
      const tally: Record<number, number> = {};
      L.votes.forEach(([, t]) => {
        if (t != null) tally[t] = (tally[t] ?? 0) + 1;
      });
      const rows = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      const max = rows.length ? rows[0][1] : 1;
      h += `<div class="sh-k">${ic("i-flame")}Day ${r} · tally</div><div class="tally">${rows
        .map(([t, n]) => {
          const voters = L.votes.filter(([, x]) => x === +t).map(([i]) => i);
          return `<div class="trow ${n === max ? "top" : ""}">${mini(+t)}<span>${esc(nm(+t))}</span><div class="tbar"><i style="width:${((n / max) * 100).toFixed(0)}%"></i></div><span class="n">${n}</span><div class="voters">${voters.map((i) => `<span title="${esc(nm(i))}">${mini(i, "sm")}</span>`).join("")}</div></div>`;
        })
        .join("")}</div>`;
      if (L.burned != null) h += `<div class="verdict"><div class="vt">${esc(L.burned === me() ? "You burn" : fullName(L.burned) + " burns")}.</div><div class="vd">The keeper reveals: ${rtag(L.role!)}</div></div>`;
      else {
        const top = rows.filter(([, n]) => n === max).map(([t]) => nm(+t));
        h += `<div class="verdict tie"><div class="vt">${rows.length ? "A tie. Nobody burns." : "No votes. Nobody burns."}</div><div class="vd">${rows.length ? `${top.map(esc).join(" and ")} each drew ${max} votes.` : ""}</div></div>`;
      }
      const ab = L.votes.filter(([, x]) => x == null).map(([i]) => nm(i));
      if (ab.length) h += `<div class="sh-p" style="font-size:12px">Abstained: ${ab.map(esc).join(", ")}</div>`;
    }
  }
  if (p === "end") h = endSheet() + h;
  S.innerHTML = h;
  S.classList.toggle("busy", false);
}

function visionsHTML() {
  return `<div class="peek"><div class="pk">Your visions · private</div>${(v!.looks ?? [])
    .map((l) => `<div class="wmsg">${mini(l.target, "sm")}<div>Night ${l.round}: <b>${esc(nm(l.target))}</b></div><span class="pk2" style="color:${l.wolf ? "var(--ember)" : "var(--mo)"}">${l.wolf ? "WOLF" : "not wolf"}</span></div>`)
    .join("")}</div>`;
}

function endSheet() {
  const w = v!.winner;
  const mine = me() != null ? (v!.seats[me()!].role === "wolf" ? "wolves" : "village") : null;
  return `<div class="sh-k">${ic("i-moon")}Game over</div><div class="sh-t">${w === "village" ? "The village wins." : "The wolves win."}</div><div class="sh-p">${mine ? (mine === w ? "Your side won." : "Your side lost.") : ""} Every role and seat is revealed.</div><button class="btn wide" id="verifyBtn2">${ic("i-seal")}Verify this game</button>`;
}

/* ---------------- the record: ledger and contradictions ---------------- */
function renderRecord() {
  if (!v) return;
  const B = $("#recBody");
  const C = contradictions(v, nm);
  let h = "";
  const rounds: number[] = [];
  for (let r = 1; r <= v.round; r++) rounds.push(r);
  if (recTab === "ledger") {
    if (C.list.length) h += `<div class="rhead">Contradictions</div><div class="contras">${C.list.map((c) => `<div class="contra-i ${c.soft ? "soft" : ""}"><i></i><span>${esc(c.text)}</span></div>`).join("")}</div>`;
    h += `<div class="rhead">Public ledger</div><table class="ledger"><thead><tr><th></th>${rounds.map((r) => `<th>DAY ${r}</th>`).join("")}</tr></thead><tbody>`;
    v.seats.forEach((s) => {
      const i = s.seat;
      const rv = s.role && (!s.alive || ended) ? s.role : null;
      h += `<tr class="${s.alive ? "" : "dead"} ${i === me() ? "you" : ""}"><td><div class="pn">${mini(i, "sm")}${esc(nm(i))}</div>${rv ? `<div style="margin-top:3px"><span class="rtag" style="--rc:${ROLES[rv].color};font-size:9.5px;padding:1px 5px">${ROLES[rv].name}</span></div>` : ""}</td>`;
      rounds.forEach((r) => {
        let c = "";
        const dawn = v!.log.find((e) => e.kind === "dawn" && e.round === r) as Extract<Entry, { kind: "dawn" }> | undefined;
        if (dawn?.died === i) c += `<span class="dth">killed N${r}</span>`;
        const council = v!.log.find((e) => e.kind === "council" && e.round === r) as Extract<Entry, { kind: "council" }> | undefined;
        const m = council?.moves.find(([x]) => x === i)?.[1];
        if (m) {
          const f = C.flags[`${i}-${r}`];
          const t = speechText(m, nm);
          c += `<span class="m">${f ? `<span class="flag ${f.soft ? "soft" : ""}" title="${esc(f.text)}">${esc(t)}</span>` : esc(t)}</span>`;
        }
        const pyre = v!.log.find((e) => e.kind === "pyre" && e.round === r) as Extract<Entry, { kind: "pyre" }> | undefined;
        const vote = pyre?.votes.find(([x]) => x === i);
        if (vote) c += vote[1] != null ? `<span class="v">${ic("i-flame")} ${esc(nm(vote[1]))}</span>` : `<span class="x">abstain</span>`;
        if (pyre?.burned === i) c += `<span class="dth">burned</span>`;
        h += `<td><div class="lc">${c || '<span class="x">·</span>'}</div></td>`;
      });
      h += `</tr>`;
    });
    h += `</tbody></table><div class="legend"><span><span class="lc"><span class="flag" style="display:inline">dotted</span></span> = contradicted</span><span>${ic("i-flame")} = pyre vote</span></div>`;
  } else {
    const cs = v.log.filter((e) => e.kind === "council") as Array<Extract<Entry, { kind: "council" }>>;
    if (!cs.length) h += `<div class="quiet">No moves yet. The first council opens after dawn.</div>`;
    [...cs].reverse().forEach((c) => {
      h += `<div class="rhead">Day ${c.round}</div><div class="feed">${c.moves.map(([i, m]) => cardHTML(i, m, c.round, 0, C.flags)).join("")}</div>`;
    });
  }
  B.innerHTML = h;
}

/* ---------------- seal popover ---------------- */
const pop = $("#pop");
let popFor: Element | null = null;
function popHTML(i: number, r: number, k: string) {
  const what = k === "vote" ? `Pyre vote · Day ${r}` : `Council move · Day ${r}`;
  const keeper = room?.hidden ? "Makeo keeper (hidden game executor)" : "this browser (practice)";
  if (!ended)
    return `<div class="ph"><span class="tic">${ic("i-seal")}</span>${what}</div><dl class="kv"><dt>Seat</dt><dd>${esc(nm(i))}</dd><dt>Sealed to</dt><dd>${keeper}</dd></dl>
    <div class="ok-l">${ic("i-check")}Sealed before the reveal, opened by the executor</div><div class="note">Who sits in each seat, and any AI receipt, unseal when the game ends.</div>`;
  const s = v!.seats[i];
  const rec = receiptsFor(s.wallet).filter((x) => x.round === r);
  if (s.house) return `<div class="ph"><span class="tic">${ic("i-chip")}</span>${what}</div><dl class="kv"><dt>Seat</dt><dd>${esc(fullName(i))} · house</dd></dl><div class="note">A house seat is played by the game's rules from its own role and the public record, inside the executor. Its moves replay exactly from the published seed.</div>`;
  if (rec.length) {
    const x = rec[0];
    return `<div class="ph"><span class="tic">${ic("i-chip")}</span>NEAR AI Cloud · private inference</div><dl class="kv"><dt>Seat</dt><dd>${esc(fullName(i))} · ${what}</dd><dt>Model</dt><dd>${esc(x.model)}</dd><dt>Signer</dt><dd>${esc(x.signing_address ?? "")}</dd><dt>Request</dt><dd>${esc((x.request_sha256 ?? "").slice(0, 16))}…</dd></dl><div class="ok-l">${ic(x.verified ? "i-check" : "i-lock")}${x.verified ? "Signature verified (verify/nearai.ts)" : "Not verified"}</div>`;
  }
  return `<div class="ph"><span class="tic">${ic("i-seal")}</span>${what}</div><dl class="kv"><dt>Seat</dt><dd>${esc(fullName(i))} · ${i === me() ? "you" : "player"}</dd><dt>Wallet</dt><dd>${esc((s.wallet ?? "").slice(0, 10))}…</dd></dl><div class="ok-l">${ic("i-check")}Signed by the player's session key</div>`;
}
function openPop(btn: HTMLElement) {
  const i = +btn.dataset.seal!,
    r = +btn.dataset.r!,
    k = btn.dataset.k!;
  popFor = btn;
  pop.innerHTML = popHTML(i, r, k);
  pop.classList.add("on");
  const b = btn.getBoundingClientRect();
  const w = pop.offsetWidth,
    h = pop.offsetHeight;
  let x = b.left + b.width / 2 - w / 2,
    y = b.bottom + 8;
  if (y + h > innerHeight - 8) y = b.top - h - 8;
  x = Math.max(12, Math.min(innerWidth - w - 12, x));
  pop.style.left = x + "px";
  pop.style.top = Math.max(8, y) + "px";
}
function closePop() {
  pop.classList.remove("on");
  popFor = null;
}
document.addEventListener("mouseover", (e) => {
  const b = (e.target as Element).closest?.("[data-seal]") as HTMLElement | null;
  if (b && matchMedia("(hover:hover)").matches) openPop(b);
  else if (popFor && !(e.target as Element).closest?.("#pop") && !(e.target as Element).closest?.("[data-seal]")) closePop();
});
document.addEventListener(
  "click",
  (e) => {
    const b = (e.target as Element).closest?.("[data-seal]") as HTMLElement | null;
    if (b) {
      e.stopPropagation();
      if (popFor === b && pop.classList.contains("on")) closePop();
      else openPop(b);
      return;
    }
    if (!(e.target as Element).closest?.("#pop")) closePop();
  },
  true,
);

/* ---------------- sheet events ---------------- */
$("#sheet").addEventListener("click", (e) => {
  const t = e.target as Element;
  const pk = t.closest("[data-pick]") as HTMLElement | null;
  if (pk) return seatClick(+pk.dataset.pick!);
  const mv = t.closest("[data-mv]") as HTMLElement | null;
  if (mv) {
    draft.kind = mv.dataset.mv as Speech["kind"];
    if (!["report", "accuse", "vouch"].includes(draft.kind)) draft.target = null;
    return renderAll();
  }
  const ro = t.closest("[data-role]") as HTMLElement | null;
  if (ro) {
    draft.role = ro.dataset.role as Role;
    return renderSheet();
  }
  const w = t.closest("[data-w]") as HTMLElement | null;
  if (w) {
    draft.wolf = w.dataset.w === "1";
    return renderSheet();
  }
  if (t.closest("#abstain")) {
    draft.target = null;
    return void send({ move: "vote", target: null });
  }
  if (t.closest("#sealBtn")) return seal();
  if (t.closest("#verifyBtn2")) return void openReceipt();
});
$("#sheet").addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === "lineIn") draft.line = t.value;
});
$("#recTabs").addEventListener("click", (e) => {
  const b = (e.target as Element).closest("button") as HTMLElement | null;
  if (!b) return;
  recTab = b.dataset.t as "ledger" | "moves";
  $$("#recTabs button").forEach((x) => x.classList.toggle("on", x === b));
  renderRecord();
});
$("#recBtn").addEventListener("click", () => {
  $("#record").classList.toggle("open");
  $("#recBtn").classList.toggle("ok");
});
$("#keeperChip").addEventListener("click", () =>
  toast(room?.hidden ? "Roles and sealed moves are held by the Makeo keeper; it publishes its secret and every move when the game ends." : room ? "Practice runs this build's rules in your browser." : "Makeo's keeper deals every match."),
);

/* ---------------- the end ---------------- */
function onEnd(end: MakeoEnd) {
  const g = room?.view?.game as GameView | null | undefined;
  if (g) v = g;
  if (!v || v.phase !== "end") {
    // Called off before play (nobody started it, or too few): say so on the title.
    showTitle();
    const reason = end.outcome && end.outcome.kind === "Void" ? end.outcome.reason : "";
    $("#menuErr").textContent = `Match called off${reason ? ` · ${reason}` : ""} · any entry was refunded.`;
    return;
  }
  if (!ended) endGame(end);
}

function endGame(end?: MakeoEnd) {
  if (!v) return;
  ended = true;
  if (screen !== "game" && screen !== "receipt") {
    show("game");
    buildSeats();
  }
  closePop();
  setSky();
  renderAll();
  void loadReceipts().then(() => {
    updateSeats();
    drawEnd(end);
  });
  drawEnd(end);
}

function drawEnd(end?: MakeoEnd) {
  if (!v) return;
  const w = v.winner;
  const house = v.seats.filter((s) => s.house).length;
  const entrants = v.seats.length - house;
  const ai = v.seats.filter((s) => !s.house && receiptsFor(s.wallet).length).length;
  const days = v.round;
  const wolves = v.seats.filter((s) => s.role === "wolf").map((s) => fullName(s.seat));
  const E = $("#endov");
  const paid = room?.kind === "paid";
  E.innerHTML = `<div class="panel endcard">
   <div class="ek">GAME OVER · ${days} ${days === 1 ? "DAY" : "DAYS"}</div><div class="et">${w === "village" ? "The village wins." : "The wolves win."}</div>
   <div class="ed">The wolves were ${wolves.map(esc).join(" and ")}.</div>
   <div class="split"><span class="h">${entrants - ai} ${entrants - ai === 1 ? "player" : "players"}</span><span class="sep"></span><span class="a">${ai} AI actors</span><span class="sep"></span><span class="a">${house} house seats</span></div>
   <div class="roster">${v.seats
     .map(
       (s, k) =>
         `<div class="rcell" style="animation-delay:${k * 70}ms"><span class="mini" style="--c:${color(s.seat)}"></span><div><div class="rn2">${s.seat === me() ? `You (${esc(fullName(s.seat))})` : esc(fullName(s.seat))}</div><div class="rm">${s.role ? rtag(s.role) : ""}${seatTag(s.seat)}</div></div></div>`,
     )
     .join("")}</div>
   ${paid ? `<div class="sh-p" style="text-align:center">${end?.payout?.error ? "Payout delayed." : end?.payout?.finalAfter && end.payout.finalAfter > Date.now() ? "Winnings are held until the audit window closes." : "Winners are paid automatically."}</div>` : ""}
   <div class="ebtns"><button class="btn" id="verifyBtn">${ic("i-seal")}Verify this game</button><button class="btn ghost" id="closeEnd">See the table</button>${paid ? `<button class="btn ghost" id="payoutBtn">See payout</button>` : ""}<button class="btn ghost" id="againBtn">Play again</button></div></div>`;
  E.classList.add("on");
  $("#verifyBtn").onclick = () => {
    E.classList.remove("on");
    void openReceipt();
  };
  $("#closeEnd").onclick = () => E.classList.remove("on");
  $("#againBtn").onclick = again;
  const po = $("#payoutBtn");
  if (po)
    po.onclick = async () => {
      const games = await Makeo.games();
      const choice = await (games as any)?.contests?.showResult?.(room!.id);
      if (choice === "again") again();
    };
}

function again() {
  $("#endov").classList.remove("on");
  room?.leave();
  room = null;
  v = null;
  ended = false;
  builtFor = "";
  phaseKey = "";
  $("#lineG").innerHTML = "";
  moonBlood(false);
  document.body.dataset.phase = "";
  renderRoomInfo();
  showTitle();
}

/* ---------------- AI receipts (actors/, published at game end) ---------------- */
type Receipt = { game: string; seat: string; round: number; model: string; request_sha256: string | null; response_sha256: string | null; signature: string | null; signing_address: string | null; verified: boolean; move: unknown; reasoning: string | null; say?: string | null };
let receipts: Receipt[] = [];
function receiptsFor(wallet: string | null | undefined) {
  if (!wallet) return [];
  return receipts.filter((r) => r.seat?.toLowerCase() === wallet.toLowerCase());
}
/** The actor runner publishes `<instance>.receipts.json`; a page may be told where with ?receipts=<url>. */
async function loadReceipts() {
  const url = new URLSearchParams(location.search).get("receipts");
  if (!url || !/^https:\/\//.test(url)) return;
  try {
    const res = await fetch(url);
    const body = await res.json();
    receipts = Array.isArray(body) ? body : Array.isArray(body?.receipts) ? body.receipts : [];
  } catch {
    receipts = [];
  }
}

/* ---------------- receipt ---------------- */
async function sha256(text: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function openReceipt() {
  if (!v) return;
  show("receipt");
  const g = v;
  const contest = (room?.view ?? {}) as Record<string, unknown>;
  const recordHash = await sha256(JSON.stringify(g.log));
  const rolesText = g.seats.map((s) => `${fullName(s.seat)}: ${s.role ? ROLES[s.role].name : "?"}`).join(" · ");
  const ais = g.seats.filter((s) => !s.house && receiptsFor(s.wallet).length);
  const commit = ["seed", "seed_commitment", "commitment", "hidden"].map((k) => contest[k]).find((x) => x != null);
  const repo = "https://github.com/makeo-fun/makeo-near-games/blob/main";
  const src = (path: string, label = path) => `<a class="src" href="${repo}/${path}" target="_blank" rel="noopener">${esc(label)} ${ic("i-ext")}</a>`;
  const checks: string[] = [];
  checks.push(`<div class="panel check"><div class="ck-h"><div class="ck-n">1</div><div><div class="ck-t">Roles were dealt by the keeper, not by any player</div><div class="ck-d">${room?.hidden ? "This was a hidden game: Makeo's keeper ran the rules with a secret committed when the room opened, and publishes that secret and every opened move now that the game is over, so anyone can replay the deal." : "Practice: the rules ran in this browser with a local secret. Matches are dealt by the keeper."}</div></div><div class="ck-ok">${ic(room?.hidden ? "i-check" : "i-lock")}${room?.hidden ? "keeper" : "practice"}</div></div>
     <div class="hashbox"><span class="k">Executor</span><span class="val" style="font-family:var(--body);font-size:12px">${room?.hidden ? "Makeo keeper · hidden game" : "this browser"}</span><span></span>${commit != null ? `<span class="k">Commitment</span><span class="val">${esc(typeof commit === "string" ? commit : JSON.stringify(commit))}</span><span></span>` : ""}<span class="k">Reveal</span><span class="val" style="font-family:var(--body);font-size:12px">${esc(rolesText)}</span><span></span></div>
     <div>${src("games/nearwolf/rules/src/lib.rs", "games/nearwolf/rules/src/lib.rs · fn setup")}</div></div>`);
  checks.push(`<div class="panel check"><div class="ck-h"><div class="ck-n">2</div><div><div class="ck-t">Every seat saw only its own view</div><div class="ck-d">The rules' <code>view</code> shows a seat its own role (a wolf its pack, the Seer its visions), its own sealed choice, the dead's roles and the public record. Nothing else, until the end. A rule test checks it for every seat.</div></div><div class="ck-ok">${ic("i-check")}tested</div></div>
     <div>${src("games/nearwolf/rules/tests/game.rs", "rules/tests/game.rs · no_seat_sees_another_seats_secret")}</div></div>`);
  const aiBlock = (s: (typeof g.seats)[number]) => {
    const rs = receiptsFor(s.wallet);
    const ok = rs.filter((r) => r.verified).length;
    return `<details class="ai"><summary>${mini(s.seat)}<div><div class="an">${esc(fullName(s.seat))} ${s.role ? rtag(s.role) : ""}</div><div class="am">${esc(rs[0]?.model ?? "")} · signer ${esc((rs[0]?.signing_address ?? "").slice(0, 10))}…</div></div><span class="ck-ok" style="margin-left:auto">${ic("i-check")}${ok}/${rs.length} verified</span><svg class="i chev"><use href="#i-chev"/></svg></summary>
     <div class="body"><div class="lbl">Every move, signed inside the TEE</div><div class="aimoves">${rs.map((r) => `<div class="amv"><span class="when">Round ${r.round}</span><span>${esc(JSON.stringify(r.move))}</span><span class="sig">${r.verified ? "sig ✓" : "unverified"}</span></div>`).join("")}</div>
     <div class="lbl">Private reasoning, unsealed after the game</div><div class="reason">${rs.filter((r) => r.reasoning).map((r) => `<div class="rsn"><b>Round ${r.round}</b>${esc(r.reasoning)}</div>`).join("")}</div>
     <div>${src("verify/nearai.ts")}</div></div></details>`;
  };
  checks.push(`<div class="panel check"><div class="ck-h"><div class="ck-n">3</div><div><div class="ck-t">AI moves came from attested private inference</div><div class="ck-d">${ais.length ? `${ais.length} AI actors on NEAR AI Cloud. Each move's signature recovers to a key bound to a TEE attestation.` : "No AI actor receipts were published for this fire. House seats are played by the rules themselves, from their own role and the public record, and replay exactly from the keeper's published secret."}</div></div><div class="ck-ok">${ic(ais.length ? "i-check" : "i-chip")}${ais.length ? "signed" : "house only"}</div></div>
     ${ais.map(aiBlock).join("")}</div>`);
  checks.push(`<div class="panel check"><div class="ck-h"><div class="ck-n">4</div><div><div class="ck-t">The public record</div><div class="ck-d">Every council move and vote, in order, exactly as every seat saw it. Hash it yourself.</div></div><div class="ck-ok">${ic("i-ledger")}${g.log.length} entries</div></div>
     <div class="hashbox"><span class="k">sha256(record)</span><span class="val">${recordHash}</span><span></span><span class="k">Result</span><span class="val" style="font-family:var(--body)">${g.winner} · ${g.round} days · ${g.seats.length} seats</span><span></span></div></div>`);
  checks.push(`<div class="panel check"><div class="ck-h"><div class="ck-n">5</div><div><div class="ck-t">Pot and record on NEAR</div><div class="ck-d">${NEAR_POT.contract ? `Settled by <code>${esc(NEAR_POT.contract)}</code> on NEAR ${esc(NEAR_POT.network)} from the keeper's signed result.` : room?.kind === "paid" ? "This match was paid through Makeo's vault. The NEAR pot contract (contracts/makeo-pot) is not live for this build yet." : "Free play: no stake, no pot. The NEAR pot contract settles paid matches once it is live."}</div></div><div class="ck-ok">${ic(NEAR_POT.contract ? "i-check" : "i-near")}${NEAR_POT.contract ? "on NEAR" : "pending"}</div></div>
     <div>${src("contracts/makeo-pot", "contracts/makeo-pot")}</div></div>`);
  $("#rwrap").innerHTML = `
   <div class="rh"><div><div class="sh-k">${ic("i-seal")}Receipt · ${esc(room?.kind ?? "")} · ${new Date().toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}</div><h1>Verify this game</h1><p>Each check says what it rests on. Nothing here asks you to trust this page.</p></div></div>
   ${checks.join("")}
   <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:8px"><button class="btn ghost" id="backTable">Back to the table</button><button class="btn" id="again2">Play again</button></div>`;
  $("#backTable").onclick = () => {
    show("game");
    document.body.dataset.sky = "dawn";
  };
  $("#again2").onclick = again;
}

/* ---------------- loop ---------------- */
function frame(t: number) {
  if (screen === "game" && v) updateClock();
  trackEyes();
  drawStars(t);
  gx += (px - gx) * 0.08;
  gy += (py - gy) * 0.08;
  $("#glow").style.transform = `translate(${gx}px,${gy}px)`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ---------------- design review (preview only): sample views, never a real room ---------------- */
function reviewView(phase: GameView["phase"], round: number): GameView {
  const roles: Role[] = ["seer", "villager", "wolf", "villager", "villager", "wolf", "healer", "villager", "villager"];
  const over = phase === "end";
  const log: Entry[] = [
    { kind: "dawn", round: 1, died: 4, role: "villager" },
    { kind: "council", round: 1, moves: [
      [0, { kind: "report", target: 5, wolf: true, line: "I am the Seer. Hale is a wolf." }],
      [1, { kind: "accuse", target: 2, line: "Corin was down by the ferry at midnight." }],
      [2, { kind: "vouch", target: 5, line: "Hale's kept the treeline all winter. I trust him." }],
      [3, { kind: "silent", line: "Grind slow. Speak slower." }],
      [5, { kind: "report", target: 6, wolf: true, line: "I am the Seer. The moon showed me Maud. Wolf." }],
      [6, { kind: "vouch", target: 1, line: "Wren's hands are for healing." }],
      [7, { kind: "accuse", target: 8, line: "Pell's bread tastes of guilt." }],
      [8, { kind: "accuse", target: 7, line: "Tobias can't account for a single night." }],
    ] },
    { kind: "pyre", round: 1, votes: [[0, 5], [1, 2], [2, 7], [3, 7], [5, 6], [6, 7], [7, 8], [8, 7]], burned: 7, role: "villager" },
    { kind: "dawn", round: 2, died: 6, role: "healer" },
  ];
  if (round >= 2 && ["pyre", "dusk", "end"].includes(phase))
    log.push({ kind: "council", round: 2, moves: [
      [0, { kind: "report", target: 5, wolf: true, line: "Maud was the Healer. Hale called her a wolf. Hale lies." }],
      [1, { kind: "accuse", target: 5, line: "A Seer who names the healer first? Convenient." }],
      [2, { kind: "accuse", target: 0, line: "Two voices say Ash." }],
      [3, { kind: "accuse", target: 5, line: "The flour has settled. Hale." }],
      [5, { kind: "claim", role: "seer", line: "I stand by every vision." }],
      [8, { kind: "accuse", target: 5, line: "I voted wrong yesterday. Not again." }],
    ] });
  if (["dusk", "end"].includes(phase)) log.push({ kind: "pyre", round: 2, votes: [[0, 5], [1, 5], [2, 0], [3, 5], [5, 0], [8, 5]], burned: 5, role: "wolf" });
  const dead = new Set<number>();
  for (const e of log) {
    if (e.kind === "dawn" && e.died != null) dead.add(e.died);
    if (e.kind === "pyre" && e.burned != null) dead.add(e.burned);
  }
  return {
    seats: roles.map((r, i) => ({ seat: i, persona: i, alive: !dead.has(i), role: over || dead.has(i) || i === 0 ? r : null, house: over ? i % 2 === 1 : null, wallet: over && i % 2 === 0 ? `0x${String(i).repeat(40)}` : null })),
    you: 0, role: "seer", phase, round, deadline_ms: Date.now() + 23000, seq: 1,
    mine: null, pack: null, looks: [{ round: 1, target: 5, wolf: true }, { round: 2, target: 2, wolf: true }], last_heal: null,
    log, winner: over ? "village" : null, deal: { wolves: 2, seer: true, healer: true, seats: 9 },
  };
}
function bootReview(name: string) {
  const spec: Record<string, [GameView["phase"], number]> = { play: ["council", 2], night: ["night", 2], dawn: ["dawn", 2], pyre: ["pyre", 2], dusk: ["dusk", 2], end: ["end", 2], receipt: ["end", 2], reveal: ["night", 1] };
  if (!spec[name]) return false;
  v = reviewView(...spec[name]);
  if (name === "reveal") {
    startReveal();
    setTimeout(flipCard, 300);
    return true;
  }
  show("game");
  buildSeats();
  phaseKey = "";
  onView({ game: v });
  if (name === "receipt") setTimeout(() => void openReceipt(), 200);
  return true;
}

/* ---------------- start ---------------- */
showTitle();
const review = window.makeoReview?.screen;
if (!(review && bootReview(review))) void enter(() => Makeo.room());
