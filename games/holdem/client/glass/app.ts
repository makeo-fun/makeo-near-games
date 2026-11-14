// @ts-nocheck
// Copied from games/holdem/ui2/app.js (Zero-G Glass Casino, Fable session snapshot 20:32Z); LIVE marks the changes.
/* NEAR HOLD'EM · Zero-G Glass Casino — timeline engine, 3D table, all screens.
 * Everything on screen is a pure function of one timeline time t (ms): render(t). No Math.random, no wall clock in the picture.
 *   play mode:      index.html            (mock adapter unless window.HOLDEM_BOOT.adapter is set)
 *   viewer's cut:   ?omni=1               TEE stamps on AI decisions during the hand
 *   director mode:  ?director=1           window.director = { duration, seek(ms), scenes, ready }
 * Data contract: HoldemView (see story.js). */
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { EffectComposer } from 'https://unpkg.com/three@0.160.0/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'https://unpkg.com/three@0.160.0/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'https://unpkg.com/three@0.160.0/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'https://unpkg.com/three@0.160.0/examples/jsm/postprocessing/OutputPass.js';

const HD = (window.HOLDEM = window.HOLDEM || {}), PI = Math.PI;
const Q = new URLSearchParams(location.search);
const DIRECTOR = Q.has('director'), OMNI = DIRECTOR || Q.has('omni');
if (DIRECTOR) document.documentElement.classList.add('director');
const $ = (s) => document.querySelector(s);
const ui = $('#ui'), tbl = $('#tbl'), glc = $('#gl'), flashEl = $('#flash'), flatEl = $('#flat');
const hudPhase = $('#hud-phase'), hudPot = $('#hud-pot'), hudDemo = $('#hud-demo');

// ---------- math ----------
const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, x) => a + (b - a) * x;
const ss = (x) => { x = sat(x); return x * x * x * (x * (x * 6 - 15) + 10); };
const eo = (x) => 1 - Math.pow(1 - sat(x), 3);
const ei = (x) => { x = sat(x); return x * x * x; };
const spr = (x) => (x <= 0 ? 0 : x >= 1.6 ? 1 : 1 - Math.exp(-5.5 * x) * Math.cos(9 * x));   // springy overshoot
const io = (lt, dur, a, b) => sat(lt / (a || 350)) * sat((dur - lt) / (b || 350));
function prng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sh = (s, n) => { s = String(s || ''); return s.length > (n || 8) + 6 ? s.slice(0, n || 8) + '…' + s.slice(-4) : s; };
const setH = (el, html) => { if (el._h !== html) { el._h = html; el.innerHTML = html; } };

// ---------- cards (HTML) ----------
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' }, VS = '︎';
const SUITCOL = { s: '#2a2f8f', h: '#ff2f92', d: '#ff7a1a', c: '#0a9fb0' };
const rk = (c) => (c[0] === 'T' ? '10' : c[0]);
const pc = (c, cls) => (c ? '<span class="pc ' + c[1] + ' ' + (cls || '') + '">' + rk(c) + '<i>' + SUIT[c[1]] + VS + '</i></span>' : '<span class="pc bk ' + (cls || '') + '"></span>');
const ctext = (c) => rk(c) + SUIT[c[1]] + VS;

// ---------- seats (from the adapter) ----------
const PAL = ['#35e0ff', '#ff4fc3', '#ffb070', '#8b5cff', '#5b8cff', '#ffe066'];
let SEATS = null, N = 0, ME = 0, idx = {}, MOCK = false, KINDS = null;
let joinT, stackK, betK, tagK, actK, stampK;
const short = (id) => (idx[id] === ME ? 'YOU' : esc((SEATS[idx[id]] || { name: id }).name).toUpperCase());
let AX = 4.3, AZ = 3.0, PORT = false;                       // table half-axes (swapped on portrait screens)
const ang = (i) => { const k = (i - ME + N) % N; return k === 0 ? PI / 2 : N < 3 ? 1.5 * PI : PI / 2 + 2 * PI * (.19 + (.62 * (k - 1)) / (N - 2)); };
const rp = (i, f, lat) => { const a = ang(i), l = lat || 0; return [Math.cos(a) * (AX + (PORT ? .5 : 1.05)) * f - Math.sin(a) * l, Math.sin(a) * (AZ + 1.0) * f + Math.cos(a) * l]; };
const ORB = () => [0, .62, PORT ? -1.0 : -.62], VAULT = () => [0, 1.6, PORT ? -2.3 : -1.55], BZ = () => (PORT ? .6 : .55), BS = () => (PORT ? .74 : 1);

// ---------- timeline ----------
const clips = [], scenes = [], tracks = {}, camKeys = [], pulses = [], hands = [], chipsRec = [];
let T = 0, holdAt = null, adapter = null, openPick = null, potMax = 600, BBV = 2;
const potK = [{ t: -1, v: 0 }];
let revealT = Infinity, burst = { t: Infinity, p: [0, 0, 0] }, rcptOn = true;

function add(s, e, fn, el) { const c = { s, e, fn, el, on: false }; clips.push(c); return c; }
function h(cls, html) { const e = document.createElement('div'); e.className = cls; e.innerHTML = html || ''; e.style.display = 'none'; ui.appendChild(e); return e; }
function scene(id, label) { if (scenes.length) scenes[scenes.length - 1].end = T; scenes.push({ id, start: T, end: T, label: label || '' }); }
function ramp(name, t0, dur, v) { const k = tracks[name] || (tracks[name] = [{ t: -1, v: 0 }]); const last = k[k.length - 1], a = Math.max(t0, last.t); k.push({ t: a, v: last.v }, { t: a + dur, v }); }
function tv(name, t) { const k = tracks[name]; if (!k) return 0; let i = k.length - 1; while (i > 0 && k[i].t > t) i--; const a = k[i], b = k[i + 1]; if (!b || b.t <= a.t) return a.v; return lerp(a.v, b.v, ss((t - a.t) / (b.t - a.t))); }
function stepv(k, t, tw) { let i = k.length - 1; while (i > 0 && k[i].t > t) i--; const a = k[i], p = k[i - 1]; return p ? lerp(p.v, a.v, eo((t - a.t) / (tw || 450))) : a.v; }
const pulse = (t, kind, p) => pulses.push({ t, kind, p: p || [0, 0, 0] });

// camera: orbit rig. pose = {az, el, d, l:[x,y,z]}
const POSE = {
  table: (az) => ({ az: az || 0, el: .7, d: 12.6, l: [0, .2, .1] }),
  wide: (az) => ({ az: az || 0, el: .42, d: 16, l: [0, .8, 0] }),
  high: (az) => ({ az: az || 0, el: 1.05, d: 16, l: [0, 0, 0] }),
  vault: (az) => ({ az: az || 0, el: .5, d: 10, l: [0, .9, -.6] }),
  board: (az) => ({ az: az || 0, el: .82, d: 11.2, l: [0, .2, .2] }),
  mine: () => ({ az: 0, el: .78, d: 10.6, l: [0, .3, .7] }),
  seat: (i) => { const a = ang(i), x = Math.cos(a), z = Math.sin(a); return { az: i === ME ? 0 : (x > .2 ? .2 : x < -.2 ? -.2 : .08), el: .66, d: 12, l: [x * AX * .16, .3, z * AZ * .12] }; },
};
function camTo(t0, dur, pose) { const last = camKeys[camKeys.length - 1]; if (last && t0 < last.t1) t0 = last.t1; camKeys.push({ t0, t1: t0 + dur, pose }); }
function camAt(t) {
  if (!camKeys.length) return POSE.wide(0);
  let i = camKeys.length - 1; while (i > 0 && camKeys[i].t0 > t) i--;
  const k = camKeys[i], a = i ? camKeys[i - 1].pose : k.pose, b = k.pose, x = k.t1 > k.t0 ? ss((t - k.t0) / (k.t1 - k.t0)) : 1;
  return { az: lerp(a.az, b.az, x), el: lerp(a.el, b.el, x), d: lerp(a.d, b.d, x), l: [0, 1, 2].map((n) => lerp(a.l[n], b.l[n], x)) };
}

// ---------- overlay helpers ----------
function kinetic(start, dur, lines, o) {
  o = o || {};
  const el = h('kin ' + (o.cls || ''), lines.map((l) => '<span class="l ' + (l.c || '') + '">' + l.t + '</span>').join(''));
  const ls = [...el.children], stg = o.stagger || 140;
  add(start, start + dur, (p, t, lt) => {
    ls.forEach((l, k) => {
      const out = sat((dur - lt) / 500);
      l.style.opacity = sat((lt - k * stg) / 500) * out;
      l.style.transform = 'translateY(' + ((1 - eo((lt - k * stg) / 700)) * 14 - (1 - out) * 8).toFixed(1) + 'px)';
    });
  }, el);
}
function cap(start, dur, html, cls) {
  const el = h('cap glass ' + (cls || ''), html);
  add(start, start + dur, (p, t, lt) => { const a = eo(lt / 600), o = sat((dur - lt) / 450); el.style.opacity = sat(lt / 400) * o; el.style.transform = 'translate(-50%,' + ((1 - a) * 12).toFixed(1) + 'px)'; }, el);
  return el;
}
function tagText(ev) {
  if (ev.label) return ev.label;
  switch (ev.kind) { case 'post': return 'BLIND ' + ev.to; case 'fold': return 'FOLD'; case 'check': return 'CHECK'; case 'call': return 'CALL ' + ev.amount; case 'bet': return 'BET ' + ev.to; case 'raise': return 'RAISE TO ' + ev.to; case 'allin': return 'ALL-IN ' + ev.to; default: return String(ev.kind || '').toUpperCase(); }
}
function tipHTML(rc) {
  const row = (k, v) => (v ? '<div><u>' + k + '</u>' + esc(v) + '</div>' : '');
  return '<div class="tip">' + '<div><b>signed in NEAR AI TEE</b></div>' + row('model', rc.model || rc.model_id) + row('signer', sh(rc.signing_address, 12)) + row('request', sh(rc.request_sha256, 14)) + row('response', sh(rc.response_sha256, 14)) + row('signature', sh(rc.signature, 14)) + row('chat', rc.chat_id)
    + (rc.verified === true ? '<div><u>attested</u><b>Intel TDX + NVIDIA ✓</b></div>' : '') + '</div>';
}
const stampHTML = (rc, show) => '<span class="stamp' + (show ? ' show' : '') + '">' + (rc.verified === true ? '✓ ' : '') + 'TEE' + tipHTML(rc) + '</span>';

// ---------- pickers (your decisions) ----------
function buildPick(pd, auto) {
  let el;
  const fire = (c) => { if (!auto && openPick && openPick.el === el) submit(c); };
  if (pd.kind === 'fill') {
    el = h('dock solo', '<button class="gbtn hero">Fill with verified agents</button><p>' + ((pd.max || N) - (pd.joined || 0)) + ' empty seats · every agent decision is signed inside a NEAR AI TEE</p>');
    el.querySelector('button').onclick = () => fire({ fill: true });
  } else if (pd.kind === 'unseal') {
    el = h('dock solo', '<button class="gbtn hero">Unseal your cards</button><p>encrypted to your key by the keeper · nobody else at the table can open this beam</p>');
    el.querySelector('button').onclick = () => fire({ unseal: true });
  } else {
    const toCall = pd.toCall || 0, canCheck = pd.canCheck != null ? pd.canCheck : toCall <= 0, canRaise = pd.canRaise != null ? pd.canRaise : pd.maxTo > pd.minTo || pd.maxTo > (pd.bet || 0) + toCall;
    const sug = pd.suggest || {}, v0 = Math.min(pd.maxTo, Math.max(pd.minTo, sug.kind === 'raise' ? sug.to : pd.minTo));
    el = h('dock glass', '<div class="info"><span>YOUR ACTION · ' + esc(String(pd.street || '').toUpperCase()) + '</span><span>POT <b>' + pd.pot + '</b> &nbsp; TO CALL <b>' + toCall + '</b> &nbsp; STACK <b>' + pd.stack + '</b></span></div><div class="row">'
      + '<button class="gbtn fold" data-k="fold">FOLD</button>'
      + (canCheck ? '<button class="gbtn call" data-k="check">CHECK</button>' : '<button class="gbtn call" data-k="call">CALL<small>' + Math.min(toCall, pd.stack) + '</small></button>')
      + (canRaise && pd.minTo < pd.maxTo ? '<div class="rz"><input type="range" min="' + pd.minTo + '" max="' + pd.maxTo + '" value="' + v0 + '"><button class="gbtn raise" data-k="raise">' + (toCall > 0 ? 'RAISE TO' : 'BET') + ' <span>' + v0 + '</span></button></div>' : '')
      + '<button class="gbtn allin" data-k="allin">ALL-IN<small>' + pd.maxTo + '</small></button></div>');
    const sl = el.querySelector('input'), rv = el.querySelector('.raise span');
    if (sl) sl.oninput = () => { rv.textContent = sl.value; };
    el.querySelectorAll('.gbtn').forEach((b) => {
      if (sug.kind === b.dataset.k) b.classList.add('sug');
      b.onclick = () => { const k = b.dataset.k; fire(k === 'raise' ? { kind: 'raise', to: +sl.value } : { kind: k }); };
    });
    el._slider = sl; el._rv = rv; el._v0 = pd.minTo;
  }
  return el;
}
function pickFn(c) {
  return (p, t, lt) => {
    const el = c.el, a = spr(lt / 600), out = c.closeT < Infinity ? sat(1 - (t - c.closeT) / 300) : 1;
    el.style.opacity = sat(lt / 200) * out; el.style.transform = 'translate(-50%,' + ((1 - a) * 90 + (1 - out) * 60).toFixed(1) + 'px)';
    el.style.pointerEvents = c.closeT < Infinity ? 'none' : '';
    if (c.auto) {   // director: the scripted choice plays itself
      const ch = c.auto, key = ch.fill ? null : ch.unseal ? null : ch.kind, btn = key ? el.querySelector('[data-k="' + key + '"]') : el.querySelector('.gbtn');
      if (el._slider && key === 'raise') { const v = Math.round(lerp(el._v0, ch.to, ss((lt - 500) / 900))); if (+el._slider.value !== v) { el._slider.value = v; el._rv.textContent = v; } }
      if (btn) btn.classList.toggle('press', t > c.pressT && t < c.pressT + 260);
    }
  };
}
function submit(choice) { const c = openPick; if (!c || DIRECTOR) return; closePicker(); adapter.act(choice); }
function openPicker(pd) {
  const c = { pd, el: buildPick(pd, false), closeT: Infinity, s: T }; c.clip = add(T, Infinity, pickFn(c), c.el);
  holdAt = T + 450; openPick = c;
}
function closePicker() {
  const c = openPick; if (!c) return; openPick = null;
  c.closeT = Math.max(c.s, Math.min(curT, holdAt == null ? curT : holdAt)); c.clip.e = c.closeT + 320; holdAt = null; T = Math.max(c.s, c.closeT) + 200;
}

// ---------- event → clips ----------
let curHand = null, curStreet = null, lobbyClip = null, lastPots = null, endSeen = false;
const newHand = () => ({ t0: T, hole: SEATS.map(() => ({ d0: Infinity, cards: null, flipT: Infinity, foldT: Infinity, slow: false })), board: [], winT: Infinity, glowT: Infinity, best: {}, winners: [], n: hands.length + 1 });
function collect(tc) { chipsRec.forEach((c) => { if (c.tc === Infinity) c.tc = tc + (c.k % 9) * 40; }); for (let i = 0; i < N; i++) { betK[i].push({ t: tc + 300, v: 0 }); colCount[i] = 0; } }
let colCount = [];
function award(tw, winners, amount) {
  const H = curHand, wi = idx[winners[0]]; H.winT = tw; H.winSeat = wi; H.winners = winners.map((w) => idx[w]);
  const p = rp(wi, .86); pulse(tw + 950, 'ring', [p[0], .1, p[1]]); pulse(tw + 950, 'flare', [.5]); burst = { t: tw + 950, p: [p[0], 1.2, p[1]], prev: burst };
  potK.push({ t: tw + 950, v: 0 });
  const share = Math.floor(amount / winners.length);
  winners.forEach((w) => { const k = stackK[idx[w]]; k.push({ t: tw + 1000, v: k[k.length - 1].v + share }); });
}
const G = {
  lobby(ev) {
    if (DIRECTOR) {
      scene('title', '');
      camTo(0, 0, POSE.wide(-.3)); camTo(200, 9000, POSE.wide(-.05));
      kinetic(500, 4300, [{ t: 'A MAKEO GAME · ON NEAR', c: 'mono' }, { t: 'NEAR Hold’em', c: 'xl' }, { t: 'The dealer is an enclave. The agents are verified.<br>Nobody has to trust the house.', c: 'sub' }], { cls: 'mid', stagger: 380 });
      T = 5000;
    } else camTo(0, 0, POSE.wide(-.25));
    scene('lobby', 'Lobby');
    joinT[ME] = T + 300;
    const max = ev.max || N, el = h('lobby glass', '');
    const html = (joined, agents) => '<div class="mono">STAKE ' + esc(ev.stake || 'FREE PLAY') + ' · NEAR TESTNET</div><div class="n">' + (joined + agents) + ' / ' + max + ' <small>players</small></div><div class="slots">'
      + Array.from({ length: max }, (_, k) => '<i class="' + (k < joined ? 'h' : k < joined + agents ? 'a' : '') + '"></i>').join('') + '</div><p>' + (agents ? 'Filled with verified agents. The keeper shuffles the seats.' : joined + ' humans have staked. ' + (max - joined) + ' seats are empty.') + '</p>';
    const c = add(T + 200, Infinity, (p, t, lt) => {
      const a = spr(lt / 700), out = c.e < Infinity ? sat((c.e - t) / 400) : 1, n = c.fillT == null ? 0 : Math.max(0, Math.min(max - ev.joined, Math.floor((t - c.fillT) / 330) + 1));
      setH(el, html(ev.joined, t < (c.fillT == null ? Infinity : c.fillT) ? 0 : n));
      el.style.opacity = sat(lt / 250) * out; el.style.transform = 'translate(-50%,-50%) translateY(' + ((1 - a) * 60 - (1 - out) * 80).toFixed(1) + 'px) scale(' + (.9 + .1 * a - (1 - out) * .1).toFixed(3) + ')';
    }, el);
    lobbyClip = c; T += 2400;
  },
  fill(ev) {
    scene('fill', 'Verified agents');
    if (lobbyClip) { lobbyClip.fillT = T + 200; lobbyClip.e = T + 3300; lobbyClip = null; }
    camTo(T, 6000, POSE.table(-.12));
    let n = 0; SEATS.forEach((s, i) => { if (i !== ME) joinT[i] = T + 1500 + ((n++ * 3 + 1) % Math.max(1, N - 1)) * 330; });
    cap(T + 1900, 3300, 'Every seat looks the same &nbsp;·&nbsp; agents run on NEAR AI Cloud' + (ev.model ? ' · ' + esc(ev.model) : '') + ', signed inside a TEE');
    T += 5200;
  },
  hand(ev) {
    const first = !hands.length;
    if (curHand) { chipsRec.forEach((c) => { if (c.tc === Infinity) c.tc = T; }); curHand.endT = T; }
    for (let i = 0; i < N; i++) if (joinT[i] === Infinity) joinT[i] = T + i * 120;
    curHand = newHand(); curHand.pos = {}; curHand.pos[idx[ev.button]] = 'D'; if (idx[ev.sb] != null && ev.sb !== ev.button) curHand.pos[idx[ev.sb]] = 'SB'; if (idx[ev.bb] != null) curHand.pos[idx[ev.bb]] = 'BB';
    hands.push(curHand); curStreet = 'preflop'; lastPots = null;
    let sum = 0; for (const id in ev.stacks || {}) if (idx[id] != null) { stackK[idx[id]].push({ t: T, v: ev.stacks[id] }); sum += ev.stacks[id]; }
    for (let i = 0; i < N; i++) { betK[i].push({ t: T, v: 0 }); colCount[i] = 0; }
    potK.push({ t: T, v: 0 }); potMax = Math.max(40, sum * .45); if (ev.blinds && ev.blinds[1]) BBV = ev.blinds[1];
    if (!first) { scene('hand-' + curHand.n, 'Hand ' + curHand.n); kinetic(T + 100, 1700, [{ t: 'Hand ' + (ev.n || curHand.n), c: 'md' }]); camTo(T, 3000, POSE.table(((curHand.n % 3) - 1) * .12)); T += 900; }
    else if (!scenes.length) camTo(0, 0, POSE.table(0));
  },
  deal(ev) {
    scene('deal', 'The deal');
    ramp('vault', T, 1200, 1); camTo(T, 5000, POSE.table(.1));
    const H = curHand, order = []; for (let k = 1; k <= N; k++) order.push((+Object.keys(H.pos).find((p) => H.pos[p] === 'D') || 0) + k);
    order.forEach((s, k) => { H.hole[s % N].d0 = T + 1300 + k * 300; });
    kinetic(T + 300, 3600, [{ t: 'THE KEEPER DEALS', c: 'mono' }, { t: N * 2 + ' cards, sealed', c: 'md' }, { t: 'One private beam per seat. Every card is committed before the first bet.', c: 'sub' }]);
    const rows = [ev.deck_commitment ? 'deck commitment <b>' + sh(ev.deck_commitment, 14) + '</b>' : '', ev.pcr0 ? 'enclave PCR0 <b>' + sh(ev.pcr0, 12) + '</b>' : '', ev.keeper ? 'keeper <b>' + sh(ev.keeper, 10) + '</b>' : ''].filter(Boolean);
    if (rows.length) cap(T + 1500, 3000, rows.join(' &nbsp;·&nbsp; '));
    ramp('vault', T + 1300 + N * 300 + 900, 900, .25);
    T += 1300 + N * 300 + 1500;
  },
  hole(ev) {
    scene('hole', 'Your cards');
    const H = curHand, m = H.hole[ME]; m.cards = ev.cards; if (m.d0 === Infinity) m.d0 = T - 1200; m.flipT = T + 350;
    camTo(T, 2600, POSE.mine());
    cap(T + 700, 2200, 'Sealed to your key &nbsp;·&nbsp; only you can see these', 'priv');
    camTo(T + 2600, 3000, POSE.table(0));
    T += 3000;
  },
  action(ev) {
    const i = idx[ev.seat]; if (i == null || !curHand) return;
    if (ev.street && ev.street !== curStreet) curStreet = ev.street;
    if (!scenes.length || (scenes[scenes.length - 1].id.split('-')[0] !== curStreet && ['deal', 'hole', 'fill', 'lobby', 'title'].indexOf(scenes[scenes.length - 1].id) >= 0) || (/^hand-/.test(scenes[scenes.length - 1].id))) scene(curStreet + (curHand.n > 1 ? '-h' + curHand.n : ''), curStreet);
    const big = ev.kind === 'allin', feat = !!ev.feature || big, me = i === ME, post = ev.kind === 'post';
    let extra = 0; const dur = post ? 650 : big ? 3600 : feat ? 2300 : me ? 1300 : 1700, t0 = T + (post ? 0 : 150);
    if (big) { scene('allin' + (curHand.n > 1 ? '-h' + curHand.n : ''), 'All-in'); camTo(T, 2600, POSE.seat(i)); pulse(t0 + 900, 'ring', ORB()); pulse(t0 + 900, 'flare', [.35]); }
    actK.push({ s: t0, e: t0 + dur, seat: i });
    tagK[i].push({ s: t0 + 200, e: t0 + Math.max(dur, 1500) + 500, text: tagText(ev), cls: big ? 'allin' : ev.kind === 'fold' ? 'fold' : '' });
    if (ev.kind === 'fold') curHand.hole[i].foldT = t0 + 300;
    if (ev.amount > 0) {
      const n = Math.min(12, Math.max(1, Math.ceil(Math.sqrt(ev.amount / BBV) * 1.3)));
      for (let k = 0; k < n; k++) chipsRec.push({ seat: i, k: colCount[i]++, tb: t0 + 250 + k * 55, tc: Infinity, tone: (i + k + (k >> 2)) % 4 });
    }
    if (ev.stack != null) stackK[i].push({ t: t0 + 300, v: ev.stack });
    if (ev.to != null && ev.amount > 0) betK[i].push({ t: t0 + 500, v: ev.to });
    if (ev.pot != null) potK.push({ t: t0 + 600, v: ev.pot });
        if (ev.receipt) {
      const st = { s: t0 + 900, e: t0 + 900 + (big && DIRECTOR ? 9000 : 5500), rc: ev.receipt, showS: Infinity, showE: Infinity }; stampK[i].push(st);
      if (big && DIRECTOR) { T = t0 + dur - 300; scene('tee', 'TEE receipt'); st.showS = T; st.showE = T + 3800; extra = 3600; }
    }
    T = t0 + dur + extra;
    if (big) camTo(T - 300, 3000, POSE.table(curStreet === 'flop' ? .16 : curStreet === 'turn' ? -.14 : .06));
  },
  street(ev) {
    const H = curHand; if (!H) return;
    curStreet = ev.name; scene(ev.name + (H.n > 1 ? '-h' + H.n : ''), ev.name);
    collect(T + 100);
    const flop = ev.cards.length > 1, az = ev.name === 'flop' ? .16 : ev.name === 'turn' ? -.14 : .06;
    ramp('rot', T, 2600, (tracks.rot ? tracks.rot[tracks.rot.length - 1].v : 0) + PI / 3);
    ramp('vault', T + 300, 600, 1);
    camTo(T + 200, 4200, POSE.board(az));
    const t0 = T + 1200; let land = t0;
    ev.cards.forEach((c, k) => {
      const slot = H.board.length, b = { c, t: t0 + k * 520, slam: !flop, commit: (ev.commitments || [])[k], slot }; H.board.push(b);
      b.land = b.t + (flop ? 1000 : 1500); land = b.land;
      pulse(b.land, 'ring', [(slot - 2) * BS(), .1, BZ()]);
    });
    const cm = (ev.commitments || []).filter(Boolean);
    if (cm.length) cap(land + 250, 2800, (MOCK ? '<b class="ok">✓</b> ' : '') + ev.cards.map(ctext).join(' ') + ' &nbsp;' + (MOCK ? 'matches the keeper’s commitment' : 'opened against the keeper’s commitment') + ' <span style="opacity:.55">' + sh(cm[0], 8) + (cm.length > 1 ? ' +' + (cm.length - 1) : '') + '</span>', 'chipv');
    ramp('vault', land + 300, 900, .25);
    camTo(land + 1200, 3200, POSE.table(az));
    T = land + 2600;
  },
  made(ev) {
    cap(T + 100, 3000, '<b>' + esc(String(ev.hand || '').replace(/^THE /, '')) + '</b> &nbsp;·&nbsp; ' + esc(ev.line || '') + ' <span style="opacity:.6">(private)</span>', 'priv'); T += 2900;
  },
  sealed(ev) {
    scene('sealed', 'Sealed reasoning');
    cap(T + 100, 3400, '<b class="ok">✓</b> ' + short(ev.seat) + '’s reasoning is signed and sealed in the TEE' + (ev.at ? ' · ' + esc(ev.at) : '') + ' &nbsp;·&nbsp; it unseals when the hand ends', 'chipv');
    T += 3300;
  },
  acted(ev) {
    if (!DIRECTOR) { T += 100; return; }
    const pd = ev.pending, dwell = pd.kind === 'act' ? 3000 : 2300;
    if (pd.kind === 'act') scene('you-' + pd.street + (scenes.filter((s) => s.id.indexOf('you-' + pd.street) === 0).length ? '-2' : ''), 'Your action');
    const c = { pd, el: buildPick(pd, true), closeT: T + dwell, auto: ev.choice, pressT: T + dwell - 420 }; c.clip = add(T, T + dwell + 320, pickFn(c), c.el);
    T += dwell + 150;
  },
  showdown(ev) {
    const H = curHand; if (!H) return;
    scene('showdown' + (H.n > 1 ? '-h' + H.n : ''), 'Showdown');
    collect(T + 100); camTo(T, 3000, POSE.board(.22)); camTo(T + 3000, 6500, POSE.board(-.22));
    const ft = T + 1500;
    for (const id in ev.hands || {}) { const i = idx[id]; if (i == null) continue; const hh = H.hole[i]; hh.cards = ev.hands[id]; if (hh.d0 === Infinity) hh.d0 = T - 2000; if (i !== ME || hh.flipT === Infinity) { hh.flipT = ft; hh.slow = true; } hh.showT = ft; }
    kinetic(T + 300, 2600, [{ t: 'SHOWDOWN', c: 'mono' }]);
    const ws = ev.winners || [], lines = Object.keys(ev.hands || {}).map((id) => '<b>' + short(id) + '</b> ' + (ev.hands[id] || []).map((c) => pc(c, 'sm')).join('') + ' ' + esc((ev.rank || {})[id] || '')).join(' &nbsp;&nbsp; ');
    if (lines) cap(ft + 2300, 4200, lines);
    H.best = {}; ws.forEach((w) => ((ev.best || {})[w] || []).forEach((c) => (H.best[c] = 1))); H.glowT = ft + 3200;
    T = ft + 5200;
    const amount = (ev.pots || []).reduce((a, p) => a + (p.amount || 0), 0);
    if (ws.length && idx[ws[0]] != null) G.won({ seat: ws[0], winners: ws, pot: amount, rank: (ev.rank || {})[ws[0]] });
  },
  won(ev) {
    const H = curHand; if (!H || ev.seat == null || idx[ev.seat] == null) return;
    scene('win' + (H.n > 1 ? '-h' + H.n : ''), 'Winner');
    collect(T); const ws = ev.winners || [ev.seat], i = idx[ev.seat];
    camTo(T, 3500, POSE.table(0)); award(T + 500, ws, ev.pot || 0);
    kinetic(T + 1300, 3600, [{ t: ev.rank ? esc(ev.rank).toUpperCase() : 'TAKES IT DOWN', c: 'mono' }, { t: (ws.length > 1 ? 'Split pot' : (i === ME ? 'You win' : esc(SEATS[i].name) + ' wins')) + (ev.pot ? ' <span class="grad">' + ev.pot + '</span>' : ''), c: 'lg' }]);
    T += 5400;
  },
  end(ev) {
    if (endSeen) return; endSeen = true;
    if (lobbyClip) { lobbyClip.e = T; lobbyClip = null; }
    const kinds = ev.kinds || {}, known = Object.keys(kinds).filter((k) => idx[k] != null);
    if (known.length) {
      scene('reveal', 'Who was AI');
      KINDS = kinds; revealT = T + 900; camTo(T, 6000, POSE.table(.12));
      const ai = known.filter((k) => kinds[k] === 'AI');
      kinetic(T + 400, 5200, [{ t: 'THE SEATS UNMASK', c: 'mono' }, { t: ai.length + ' of ' + N + ' were AI', c: 'md' }, { t: ai.length ? ai.map(short).join(' · ') + (ev.model ? '<br>' + esc(ev.model) + ' inside a NEAR AI TEE' : '') : 'Every seat was human.', c: 'sub' }]);
      T += 6200;
    }
    const rcs = ev.receipts || [], f = ev.feature, frc = f && rcs.filter((r) => r.seat === f.seat && r.round === f.street).pop();
    if (frc && frc.reasoning) {
      scene('unseal', 'Reasoning unsealed');
      if (idx[f.seat] != null) camTo(T, 4000, POSE.seat(idx[f.seat]));
      const el = h('holo glass', '<div class="hd"><span>' + short(f.seat) + ' · ' + esc(f.street) + ' · ' + esc(tagText({ kind: frc.move.kind, to: frc.move.to, amount: frc.move.amount })) + '</span><span>UNSEALED</span></div><div class="q"></div><div class="ft">signed in NEAR AI TEE' + (frc.verified === true ? ' <b class="ok">✓</b>' : '') + ' · ' + esc(frc.model || '') + '<br>signer ' + sh(frc.signing_address, 12) + ' · response ' + sh(frc.response_sha256, 14) + '</div>');
      const q = el.querySelector('.q'), txt = frc.reasoning, D = 7600;
      add(T + 300, T + 300 + D, (p, t, lt) => { const a = spr(lt / 650), o = sat((D - lt) / 350); el.style.opacity = sat(lt / 220) * o; el.style.transform = 'translate(-50%,' + ((1 - eo(lt / 600)) * 14).toFixed(1) + 'px)'; const n = Math.floor(sat((lt - 700) / 3600) * txt.length); const s = '“' + esc(txt.slice(0, n)) + (n < txt.length ? '▍' : '”'); if (q._s !== s) { q._s = s; q.innerHTML = s; } }, el);
      T += D + 500;
    }
    scene('receipt', 'Receipt');
    camTo(T, 5000, POSE.wide(.15)); camTo(T + 5000, 14000, POSE.wide(-.15));
    receipt(ev);
  },
};

function receipt(ev) {
  const cards = ev.cards || [], rcs = ev.receipts || [], near = ev.near, chips = ev.chips;
  const secs = [];
  if (cards.length) secs.push({ id: 'cards', tab: 'CARDS', html: '<p class="lead">Every card slot was committed by the keeper at the deal. Only revealed slots are ever opened; folded cards stay sealed.' + (ev.deck_commitment ? ' Deck <span class="mono">' + sh(ev.deck_commitment, 12) + '</span>' : '') + '</p>'
    + cards.map((c) => '<div class="crow' + (c.card ? '' : ' sealed') + '"><span class="lb">' + esc(c.label) + '</span><span>' + pc(c.card, 'sm') + '</span><span class="cm">' + sh(c.commitment, 12) + (c.salt ? '<br>salt ' + sh(c.salt, 8) : '') + '</span><span class="stt">' + esc(c.status || '') + (c.card && MOCK ? ' <b class="ok">✓</b>' : '') + '</span></div>').join('') });
  if (rcs.length) secs.push({ id: 'ai', tab: 'AI DECISIONS', html: '<p class="lead">Each agent decision was produced inside a NEAR AI TEE and signed there. The reasoning stayed sealed until the hand ended.</p>'
    + rcs.map((r) => '<div class="rc"><div class="top"><span class="who">' + short(r.seat) + '<span>' + esc(r.round || '') + ' · ' + esc(tagText({ kind: r.move && r.move.kind, to: r.move && r.move.to, amount: r.move && r.move.amount })) + '</span></span><span class="sg">signed in NEAR AI TEE' + (r.verified === true ? ' ✓' : '') + '</span></div>' + (r.reasoning ? '<q>' + esc(r.reasoning) + '</q>' : '')
      + '<div class="hx">' + [['model', r.model_id || r.model], ['signer', r.signing_address], ['request', r.request_sha256], ['response', r.response_sha256], ['signature', sh(r.signature, 40)]].filter((x) => x[1]).map((x) => '<u>' + x[0] + '</u>' + esc(x[1])).join('<br>') + '</div></div>').join('') });
  if (near) {
    const st = (n, t, d, cls) => '<div class="step ' + (cls || '') + '"><i>' + n + '</i><div><b>' + t + '</b><div>' + d + '</div></div></div>'; let n = 1;
    secs.push({ id: 'near', tab: 'NEAR POT', html: '<p class="lead">The stake lives in a contract on NEAR ' + esc(near.network || '') + (near.contract ? ' · <span class="mono">' + esc(near.contract) + '</span>' : '') + (near.game ? ' · game <span class="mono">' + esc(near.game) + '</span>' : '') + '</p><div class="steps">'
      + (near.open_tx ? st(n++, 'Pot opened', 'tx ' + esc(near.open_tx)) : '')
      + (near.entries || []).map((e) => st(n++, short(e.seat) + ' staked ' + esc(e.stake || ''), (e.account ? 'account ' + sh(e.account, 14) + '<br>' : '') + (e.tx ? 'tx ' + esc(e.tx) : ''))).join('')
      + (near.out && near.out.length ? st(n++, 'Agents play for free', near.out.map(short).join(' · ') + ' · no stake, no payout') : '')
      + (near.settle_tx ? st(n++, 'Keeper settles', 'tx ' + esc(near.settle_tx) + (near.keeper_sig ? '<br>keeper signature ' + sh(near.keeper_sig, 26) : '')) : '')
      + (near.payout ? st('★', short(near.payout.seat) + ' paid ' + esc(near.payout.amount || ''), near.payout.account ? 'to ' + sh(near.payout.account, 14) : '', 'pay') : '') + '</div>' });
  }
  if (chips) secs.push({ id: 'chips', tab: 'RESULT', html: '<p class="lead">Final chip counts' + (ev.hands ? ' after ' + ev.hands + ' hands' : '') + '.</p><div class="steps">' + Object.keys(chips).sort((a, b) => chips[b] - chips[a]).map((id, k) => '<div class="step' + (k ? '' : ' pay') + '"><i>' + (k + 1) + '</i><div><b>' + (idx[id] != null ? short(id) : esc(sh(id, 8))) + '</b><div>' + chips[id] + ' chips</div></div></div>').join('') + '</div>' });
  if (!secs.length) return;
  const el = h('rcpt glass', '<header><h2><small>THE RECEIPT · NOTHING TAKEN ON TRUST</small>Proof of play</h2><div class="tabs">' + secs.map((s, k) => '<button data-k="' + k + '">' + s.tab + '</button>').join('') + '</div></header><div class="body">' + secs.map((s) => '<section>' + s.html + '</section>').join('') + '</div>');
  const tabs = [...el.querySelectorAll('.tabs button')], ss_ = [...el.querySelectorAll('section')], body = el.querySelector('.body');
  let cur = -1; const show = (k) => { if (k === cur) return; cur = k; tabs.forEach((b, j) => b.classList.toggle('on', j === k)); ss_.forEach((s, j) => s.classList.toggle('on', j === k)); body.scrollTop = 0; };
  tabs.forEach((b, k) => (b.onclick = () => show(k))); show(0);
  const per = 5600, s0 = T + 600;
  if (DIRECTOR) secs.forEach((s, k) => { if (k) { T = s0 + k * per; scene('receipt-' + s.id, 'Receipt'); } });
  add(s0, DIRECTOR ? s0 + secs.length * per : Infinity, (p, t, lt) => {
    const a = spr(lt / 800), o = DIRECTOR ? sat((secs.length * per - lt) / 400) : 1;
    el.style.opacity = sat(lt / 300) * o * (rcptOn ? 1 : 0); el.style.pointerEvents = rcptOn ? '' : 'none';
    el.style.transform = 'translate(-50%,-50%) perspective(1400px) rotateX(' + ((1 - a) * 22).toFixed(2) + 'deg) translateY(' + ((1 - a) * 80).toFixed(1) + 'px) scale(' + (.9 + .1 * a).toFixed(3) + ')';
    if (DIRECTOR) { const k = Math.min(secs.length - 1, Math.floor(lt / per)); show(k); const mx = body.scrollHeight - body.clientHeight; body.scrollTop = mx > 0 ? mx * ss((lt - k * per - 1500) / (per - 2600)) : 0; }
  }, el);
  T = s0 + (DIRECTOR ? secs.length * per : 1200);
  if (!DIRECTOR) { const b = document.createElement('button'); b.textContent = 'Table ⇄ Receipt'; b.onclick = () => { rcptOn = !rcptOn; }; $('#ctl').prepend(b); }
}

// ---------- compile ----------
let consumed = 0, plates = [], betEls = [];
function initSeats(view) {
  SEATS = (view.seats && view.seats.length ? view.seats : (window.HOLDEM_BOOT || {}).seats || HD.SEATS || []).slice(0, 6); N = SEATS.length;
  idx = {}; SEATS.forEach((s, i) => (idx[s.id] = i)); ME = view.me && idx[view.me.seat] != null ? idx[view.me.seat] : 0; MOCK = !!view.mock;
  joinT = new Array(N).fill(Infinity); stackK = SEATS.map(() => [{ t: -1, v: 0 }]); betK = SEATS.map(() => [{ t: -1, v: 0 }]); tagK = SEATS.map(() => []); stampK = SEATS.map(() => []); actK = []; colCount = new Array(N).fill(0);
  SEATS.forEach((s, i) => {
    const p = document.createElement('div'); p.className = 'plate'; p.style.display = 'none'; p.style.setProperty('--c', PAL[i % PAL.length]); tbl.appendChild(p); plates.push(p);
    const b = document.createElement('div'); b.className = 'bet'; b.style.display = 'none'; tbl.appendChild(b); betEls.push(b);
  });
  if (MOCK && !DIRECTOR) hudDemo.textContent = 'Demo hand · scripted';
  if (GL) buildSeats();
}
function consume(view) {
  if (!SEATS) initSeats(view);
  if (openPick && !view.pending) closePicker();
  for (; consumed < view.log.length; consumed++) { const ev = view.log[consumed]; if (ev.omni && !OMNI) continue; if (G[ev.t]) G[ev.t](ev); }
  if (scenes.length) scenes[scenes.length - 1].end = T;
  if (view.pending && !openPick && !DIRECTOR) openPicker(view.pending);
}

// ---------- 3D ----------
let GL = false, R, SC, CAM, COMP, BLOOM, W = 1, H_ = 1, curT = 0;
let tableG, railM, decal, orbM, orbCore, orbLight, vaultG, vaultM, vaultEdges, vaultCore, planetM, starsM, deckG, shardM, glowTex;
const seatM = [], holeM = [], boardM = [], chipM = [], beamM = [], trailM = [], ringM = [], glowM = [], faceCache = {};
const V = (x, y, z) => new THREE.Vector3(x, y, z), pv = new THREE.Vector3();
const canvas = (w, hh) => { const c = document.createElement('canvas'); c.width = w; c.height = hh; return c; };
const tex = (c) => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };
const CW = .9, CH = 1.26;
function rrect(g, x, y, w, hh, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + hh, r); g.arcTo(x + w, y + hh, x, y + hh, r); g.arcTo(x, y + hh, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function faceTex(card) {
  if (faceCache[card]) return faceCache[card];
  const c = canvas(360, 504), g = c.getContext('2d'), col = SUITCOL[card[1]], s = SUIT[card[1]] + VS;
  const bg = g.createLinearGradient(0, 0, 360, 504); bg.addColorStop(0, 'rgba(255,255,255,.97)'); bg.addColorStop(.6, 'rgba(232,242,255,.95)'); bg.addColorStop(1, 'rgba(246,232,255,.96)');
  rrect(g, 4, 4, 352, 496, 34); g.fillStyle = bg; g.fill();
  const sh2 = g.createLinearGradient(0, 0, 360, 300); sh2.addColorStop(0, 'rgba(255,255,255,.9)'); sh2.addColorStop(.45, 'rgba(255,255,255,0)'); g.fillStyle = sh2; rrect(g, 4, 4, 352, 496, 34); g.fill();
  g.lineWidth = 5; const ed = g.createLinearGradient(0, 0, 360, 504); ed.addColorStop(0, '#35e0ff'); ed.addColorStop(.4, '#8b5cff'); ed.addColorStop(.7, '#ff4fc3'); ed.addColorStop(1, '#ffb070'); g.strokeStyle = ed; rrect(g, 7, 7, 346, 490, 31); g.stroke();
  g.fillStyle = col; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '700 118px "Space Grotesk", system-ui, sans-serif'; g.fillText(rk(card), 82, 86);
  g.font = '84px "Space Grotesk", system-ui, sans-serif'; g.fillText(s, 82, 186);
  g.font = '250px "Space Grotesk", system-ui, sans-serif'; g.globalAlpha = .95; g.fillText(s, 212, 342);
  return (faceCache[card] = tex(c));
}
function backTex() {
  const c = canvas(360, 504), g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, 360, 504); bg.addColorStop(0, '#35e0ff'); bg.addColorStop(.38, '#7a5cff'); bg.addColorStop(.7, '#ff4fc3'); bg.addColorStop(1, '#ffb070');
  rrect(g, 4, 4, 352, 496, 34); g.fillStyle = bg; g.globalAlpha = .88; g.fill(); g.globalAlpha = 1; g.save(); g.clip();
  g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 2; for (let r = 30; r < 420; r += 26) { g.beginPath(); g.arc(180, 252, r, 0, 7); g.stroke(); }
  g.restore(); g.fillStyle = 'rgba(255,255,255,.92)'; g.beginPath(); g.moveTo(180, 176); g.lineTo(236, 252); g.lineTo(180, 328); g.lineTo(124, 252); g.closePath(); g.fill();
  g.strokeStyle = '#fff'; g.lineWidth = 5; rrect(g, 7, 7, 346, 490, 31); g.stroke();
  return tex(c);
}
function glowTexture() { const c = canvas(128, 128), g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.25, 'rgba(255,255,255,.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return tex(c); }
function envTexture() {
  const c = canvas(1024, 512), g = c.getContext('2d'), bg = g.createLinearGradient(0, 0, 0, 512); bg.addColorStop(0, '#1a2470'); bg.addColorStop(.5, '#2a2a9a'); bg.addColorStop(.62, '#ff9a6a'); bg.addColorStop(.7, '#3a7bff'); bg.addColorStop(1, '#081040'); g.fillStyle = bg; g.fillRect(0, 0, 1024, 512);
  const blob = (x, y, r, col) => { const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2); };
  blob(512, 290, 190, 'rgba(255,230,190,1)'); blob(180, 170, 200, 'rgba(53,224,255,.95)'); blob(840, 150, 200, 'rgba(255,79,195,.95)'); blob(40, 330, 160, 'rgba(139,92,255,.9)'); blob(980, 330, 160, 'rgba(139,92,255,.9)');
  g.fillStyle = '#fff'; g.fillRect(300, 40, 420, 22); g.fillRect(90, 80, 16, 150); g.fillRect(920, 80, 16, 150);
  const t = tex(c); t.mapping = THREE.EquirectangularReflectionMapping; return t;
}
const hdr = (hex, k) => new THREE.Color(hex).multiplyScalar(k);

function build3D() {
  R = new THREE.WebGLRenderer({ canvas: glc, antialias: true, powerPreference: 'high-performance' });
  R.setPixelRatio(Math.min(window.devicePixelRatio || 1, DIRECTOR ? 2 : 1.5)); R.toneMapping = THREE.NoToneMapping;
  SC = new THREE.Scene(); CAM = new THREE.PerspectiveCamera(38, 1, .1, 1200);
  const pm = new THREE.PMREMGenerator(R); SC.environment = pm.fromEquirectangular(envTexture()).texture; pm.dispose();
  // space
  { const c = canvas(16, 512), g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 512); gr.addColorStop(0, '#02041a'); gr.addColorStop(.55, '#07104a'); gr.addColorStop(1, '#16289a'); g.fillStyle = gr; g.fillRect(0, 0, 16, 512); SC.background = tex(c); }
  const rnd = prng(7), sp = [], sc = [];
  for (let i = 0; i < 1800; i++) { const u = rnd() * 2 - 1, a = rnd() * 2 * PI, r = Math.sqrt(1 - u * u), d = 500; sp.push(Math.cos(a) * r * d, u * d, Math.sin(a) * r * d); const k = .5 + rnd() * 1.6, w = rnd(); sc.push(k * (w < .2 ? 1 : .8), k * .9, k * (w > .8 ? .7 : 1)); }
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3)); sg.setAttribute('color', new THREE.Float32BufferAttribute(sc, 3));
  starsM = new THREE.Points(sg, new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: .9, depthWrite: false })); SC.add(starsM);
  // planet at dawn: the lit limb curves up behind the table
  planetM = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), new THREE.ShaderMaterial({
    uniforms: { sun: { value: V(.15, .5, -1).normalize() }, tm: { value: 0 } },
    vertexShader: 'varying vec3 n; varying vec3 wp; void main(){ n = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position,1.); wp = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: 'uniform vec3 sun; uniform float tm; varying vec3 n; varying vec3 wp; void main(){ vec3 v = normalize(cameraPosition - wp); float f = pow(1. - max(dot(n, v), 0.), 5.); float d = dot(n, sun); float day = smoothstep(-.25, .35, d);'
      + ' float band = .5 + .5 * sin(n.y * 34. + sin(n.x * 9. + tm) * 2.2 + n.z * 6.); vec3 sea = mix(vec3(.004,.012,.07), vec3(.012,.07,.26), day) * (.7 + .3 * band); vec3 cloud = vec3(.5,.7,1.) * smoothstep(.72, 1., band) * day * .12;'
      + ' vec3 rim = mix(vec3(.06,.3,1.), vec3(1.1,.62,.4), smoothstep(.2, .9, d * .5 + .5)) * f * .9; gl_FragColor = vec4(sea + cloud + rim, 1.); }',
  }));
  planetM.scale.setScalar(150); planetM.position.set(0, -168, -150); SC.add(planetM);
  const sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: (glowTex = glowTexture()), color: hdr('#ffd0a0', 3.2), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })); sun.scale.setScalar(120); sun.position.set(40, -8, -330); SC.add(sun);
  // lights
  SC.add(new THREE.HemisphereLight(0x9fd0ff, 0x30208a, .9));
  const dl = new THREE.DirectionalLight(0xffd2a8, 2.2); dl.position.set(3, 4, -9); SC.add(dl);
  const kl = new THREE.DirectionalLight(0xcfe8ff, 1.4); kl.position.set(-3, 9, 7); SC.add(kl);
  const p1 = new THREE.PointLight(0x35e0ff, 60, 30); p1.position.set(-8, 4, 2); SC.add(p1);
  const p2 = new THREE.PointLight(0xff4fc3, 60, 30); p2.position.set(8, 4, 2); SC.add(p2);
  // observation deck: floor ring, pedestal, window ribs
  deckG = new THREE.Group(); SC.add(deckG);
  { const c = canvas(1024, 1024), g = c.getContext('2d'); g.strokeStyle = 'rgba(160,220,255,.5)'; g.lineWidth = 2; for (let r = 60; r <= 500; r += 55) { g.beginPath(); g.arc(512, 512, r, 0, 7); g.stroke(); } for (let a = 0; a < 36; a++) { g.beginPath(); g.moveTo(512 + Math.cos(a * PI / 18) * 60, 512 + Math.sin(a * PI / 18) * 60); g.lineTo(512 + Math.cos(a * PI / 18) * 500, 512 + Math.sin(a * PI / 18) * 500); g.stroke(); }
    const fl = new THREE.Mesh(new THREE.CircleGeometry(16, 96), new THREE.MeshBasicMaterial({ map: tex(c), transparent: true, opacity: .05, depthWrite: false, blending: THREE.AdditiveBlending })); fl.rotation.x = -PI / 2; fl.position.y = -2.2; deckG.add(fl);
    const fr = new THREE.Mesh(new THREE.TorusGeometry(16, .05, 12, 160), new THREE.MeshBasicMaterial({ color: hdr('#7fb4ff', .3) })); fr.rotation.x = PI / 2; fr.position.y = -2.2; deckG.add(fr);
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(.5, 1.3, 2.1, 48, 1, true), new THREE.MeshPhysicalMaterial({ color: 0xbfd8ff, transmission: 1, thickness: .4, roughness: .1, iridescence: 1, side: THREE.DoubleSide })); ped.position.y = -1.15; deckG.add(ped);
    const ribM = new THREE.MeshStandardMaterial({ color: 0xdfe9ff, metalness: .9, roughness: .25 });
    for (let k = -3; k <= 3; k++) { const rib = new THREE.Mesh(new THREE.TorusGeometry(26, .16, 8, 80, PI), ribM); rib.rotation.y = k * .42; rib.position.y = -2.2; deckG.add(rib); }
    for (const y of [5, 12]) { const hoop = new THREE.Mesh(new THREE.TorusGeometry(Math.sqrt(26 * 26 - (y + 2.2) * (y + 2.2)), .1, 8, 160), ribM); hoop.rotation.x = PI / 2; hoop.position.y = y; deckG.add(hoop); }
  }
  // the table: oval glass slab, velvet-glass playing surface, padded rail with an aurora light line
  tableG = new THREE.Group(); SC.add(tableG);
  const slab = new THREE.Mesh(new THREE.CylinderGeometry(1, .93, .16, 128), new THREE.MeshPhysicalMaterial({ color: 0xcfe2ff, transmission: 1, thickness: 1.2, roughness: .06, ior: 1.45, iridescence: .5, iridescenceIOR: 1.3, attenuationColor: new THREE.Color(0x6aa8ff), attenuationDistance: 5, envMapIntensity: 1.4 })); slab.position.y = -.09; tableG.add(slab);
  { const c = canvas(1024, 1024), g = c.getContext('2d'), gr = g.createRadialGradient(512, 512, 40, 512, 512, 512); gr.addColorStop(0, '#3550ff'); gr.addColorStop(.45, '#2a2ac8'); gr.addColorStop(.8, '#3a1a9a'); gr.addColorStop(1, '#1a0f66'); g.fillStyle = gr; g.beginPath(); g.arc(512, 512, 512, 0, 7); g.fill();
    g.strokeStyle = 'rgba(160,230,255,.75)'; g.lineWidth = 3; g.beginPath(); g.arc(512, 512, 410, 0, 7); g.stroke(); g.strokeStyle = 'rgba(255,255,255,.22)'; g.lineWidth = 1.5; g.beginPath(); g.arc(512, 512, 250, 0, 7); g.stroke();
    const felt = new THREE.Mesh(new THREE.CircleGeometry(.905, 128), new THREE.MeshPhysicalMaterial({ map: tex(c), roughness: .55, metalness: 0, sheen: 1, sheenColor: new THREE.Color(0x8fb8ff), sheenRoughness: .4, clearcoat: .35, clearcoatRoughness: .4, transparent: true, opacity: .86, envMapIntensity: .5 })); felt.rotation.x = -PI / 2; felt.position.y = .001; tableG.add(felt); }
  { const c = canvas(1024, 1024), g = c.getContext('2d'); g.translate(512, 512); g.strokeStyle = 'rgba(190,240,255,.9)'; g.fillStyle = 'rgba(190,240,255,.9)';
    for (let a = 0; a < 72; a++) { g.save(); g.rotate(a * PI / 36); g.lineWidth = a % 6 ? 1.5 : 4; g.beginPath(); g.moveTo(0, -385); g.lineTo(0, a % 6 ? -372 : -355); g.stroke(); g.restore(); }
    g.font = '600 22px "JetBrains Mono", monospace'; g.textAlign = 'center'; const tx = ' NEAR HOLD’EM · MAKEO KEEPER · SEALED DEAL · VERIFIED AGENTS ·'; for (let k = 0; k < tx.length * 2; k++) { g.save(); g.rotate(k * PI / tx.length); g.fillText(tx[k % tx.length], 0, -322); g.restore(); }
    decal = new THREE.Mesh(new THREE.CircleGeometry(.9, 96), new THREE.MeshBasicMaterial({ map: tex(c), transparent: true, opacity: .5, blending: THREE.AdditiveBlending, depthWrite: false })); decal.rotation.x = -PI / 2; decal.position.y = .004; tableG.add(decal); }
  railM = new THREE.Mesh(new THREE.TorusGeometry(.955, .036, 24, 160), new THREE.MeshPhysicalMaterial({ color: 0xf2f6ff, roughness: .18, metalness: .1, clearcoat: 1, iridescence: 1, iridescenceIOR: 1.6, iridescenceThicknessRange: [200, 700], envMapIntensity: 1.6 })); railM.rotation.x = PI / 2; railM.position.y = .03; railM.scale.z = 3.2; tableG.add(railM);
  { const c = canvas(1024, 8), g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 1024, 0); ['#35e0ff', '#8b5cff', '#ff4fc3', '#ffb070', '#ff4fc3', '#8b5cff', '#35e0ff'].forEach((x, k) => gr.addColorStop(k / 6, x)); g.fillStyle = gr; g.fillRect(0, 0, 1024, 8); const t = tex(c); t.wrapS = THREE.RepeatWrapping;
    const line = new THREE.Mesh(new THREE.TorusGeometry(.905, .008, 8, 200), new THREE.MeshBasicMaterial({ map: t, color: hdr('#ffffff', 1.1) })); line.rotation.x = PI / 2; line.position.y = .012; line.scale.z = 2; tableG.add(line); tableG.userData.line = t;
    const under = new THREE.Mesh(new THREE.TorusGeometry(.9, .012, 8, 200), new THREE.MeshBasicMaterial({ map: t, color: hdr('#ffffff', .8) })); under.rotation.x = PI / 2; under.position.y = -.2; tableG.add(under); }
  // pot orb
  orbM = new THREE.Mesh(new THREE.SphereGeometry(.46, 64, 48), new THREE.MeshPhysicalMaterial({ color: 0xffffff, transmission: 1, thickness: .9, roughness: 0, ior: 1.5, iridescence: 1, iridescenceIOR: 1.3, iridescenceThicknessRange: [100, 500], envMapIntensity: 1.8 })); SC.add(orbM);
  orbCore = new THREE.Mesh(new THREE.IcosahedronGeometry(.2, 3), new THREE.MeshBasicMaterial({ color: 0xffffff })); SC.add(orbCore);
  orbLight = new THREE.PointLight(0xffc8f0, 0, 12); SC.add(orbLight);
  // the keeper: a crystalline vault core
  vaultG = new THREE.Group(); SC.add(vaultG);
  const og = new THREE.OctahedronGeometry(.62, 0);
  vaultM = new THREE.Mesh(og, new THREE.MeshPhysicalMaterial({ color: 0xd8fff2, transmission: 1, thickness: 1.1, roughness: 0, ior: 1.9, iridescence: 1, iridescenceIOR: 1.5, envMapIntensity: 2, flatShading: true })); vaultG.add(vaultM);
  vaultEdges = new THREE.LineSegments(new THREE.EdgesGeometry(og), new THREE.LineBasicMaterial({ color: hdr('#7dffd8', 2) })); vaultEdges.scale.setScalar(1.02); vaultG.add(vaultEdges);
  vaultCore = new THREE.Mesh(new THREE.OctahedronGeometry(.2, 0), new THREE.MeshBasicMaterial({ color: hdr('#b8fff0', 2.5) })); vaultG.add(vaultCore);
  const cage = new THREE.Mesh(new THREE.TorusGeometry(.95, .012, 6, 90), new THREE.MeshBasicMaterial({ color: hdr('#9ff', 1.5) })); vaultG.add(cage); vaultG.userData.cage = cage;
  const cage2 = cage.clone(); vaultG.add(cage2); vaultG.userData.cage2 = cage2;
  // cards
  const shp = new THREE.Shape(), r = .075, w2 = CW / 2, h2 = CH / 2; shp.moveTo(-w2 + r, -h2); shp.lineTo(w2 - r, -h2); shp.quadraticCurveTo(w2, -h2, w2, -h2 + r); shp.lineTo(w2, h2 - r); shp.quadraticCurveTo(w2, h2, w2 - r, h2); shp.lineTo(-w2 + r, h2); shp.quadraticCurveTo(-w2, h2, -w2, h2 - r); shp.lineTo(-w2, -h2 + r); shp.quadraticCurveTo(-w2, -h2, -w2 + r, -h2);
  const cg = new THREE.ExtrudeGeometry(shp, { depth: .035, bevelEnabled: true, bevelThickness: .012, bevelSize: .012, bevelSegments: 3, curveSegments: 8 }); cg.translate(0, 0, -.0175);
  const glass = new THREE.MeshPhysicalMaterial({ color: 0xffffff, transmission: 1, thickness: .35, roughness: .03, ior: 1.6, iridescence: 1, iridescenceIOR: 1.35, iridescenceThicknessRange: [150, 650], clearcoat: 1, envMapIntensity: 2.2, attenuationColor: new THREE.Color(0xbfe0ff), attenuationDistance: 2 });
  const pg = new THREE.PlaneGeometry(CW - .07, CH - .07), bt = backTex(), backMat = new THREE.MeshBasicMaterial({ map: bt, transparent: true, color: 0xb8b8b8 });
  const mk = () => { const g = new THREE.Group(), f = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ transparent: true, color: 0xc4c4c4 })), b = new THREE.Mesh(pg, backMat); f.position.z = .031; b.position.z = -.031; b.rotation.y = PI; g.add(new THREE.Mesh(cg, glass), f, b); g.userData.f = f; g.visible = false; SC.add(g); return g; };
  for (let k = 0; k < 5; k++) boardM.push(mk());
  for (let k = 0; k < 12; k++) holeM.push(mk());
  // chips: translucent candy glass
  const chg = new THREE.CylinderGeometry(.19, .19, .055, 28), tones = ['#35e0ff', '#ff4fc3', '#ffb070', '#8b5cff'].map((c) => new THREE.MeshPhysicalMaterial({ color: c, emissive: c, emissiveIntensity: .3, roughness: .08, clearcoat: 1, transparent: true, opacity: .84, iridescence: .6, envMapIntensity: 1.6 }));
  for (let k = 0; k < 110; k++) { const m = new THREE.Mesh(chg, tones[k % 4]); m.visible = false; m.userData.tones = tones; SC.add(m); chipM.push(m); }
  // light: trails, rings, glows, shards
  for (let k = 0; k < 70; k++) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })); s.visible = false; SC.add(s); trailM.push(s); }
  for (let k = 0; k < 8; k++) { const m = new THREE.Mesh(new THREE.RingGeometry(.93, 1, 96), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })); m.rotation.x = -PI / 2; m.visible = false; SC.add(m); ringM.push(m); }
  for (let k = 0; k < 9; k++) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: hdr('#8fffe0', 1.3), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })); s.visible = false; SC.add(s); glowM.push(s); }
  shardM = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(.13, 0), new THREE.MeshPhysicalMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: .25, roughness: 0, iridescence: 1, transparent: true, opacity: .8, envMapIntensity: 2, flatShading: true }), 180);
  const sr = prng(99), pc3 = ['#35e0ff', '#ff4fc3', '#ffb070', '#8b5cff', '#ffffff', '#5dffc4'].map((c) => new THREE.Color(c)); shardM.userData.d = [];
  for (let k = 0; k < 180; k++) { const u = sr() * 1.6 - .5, a = sr() * 2 * PI, q = Math.sqrt(Math.max(0, 1 - u * u)); shardM.userData.d.push([Math.cos(a) * q, u, Math.sin(a) * q, .5 + sr() * 1.5, sr() * 6, .4 + sr() * 1.4]); shardM.setColorAt(k, pc3[k % 6]); }
  shardM.visible = false; shardM.frustumCulled = false; SC.add(shardM);
  // post: bloom
  COMP = new EffectComposer(R); COMP.addPass(new RenderPass(SC, CAM));
  BLOOM = new UnrealBloomPass(new THREE.Vector2(256, 256), .5, .7, .9); COMP.addPass(BLOOM);
  const out = new OutputPass(); COMP.addPass(out); R.toneMapping = THREE.ACESFilmicToneMapping; R.toneMappingExposure = 1.05;
  GL = true;
}
function buildSeats() {
  SEATS.forEach((s, i) => {
    const col = PAL[i % PAL.length], g = new THREE.Group();
    const orb = new THREE.Mesh(new THREE.SphereGeometry(.42, 48, 32), new THREE.MeshPhysicalMaterial({ color: col, emissive: col, emissiveIntensity: .45, roughness: .05, clearcoat: 1, transmission: .5, thickness: .6, iridescence: 1, envMapIntensity: 1.6 }));
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: hdr(col, 1.1), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: .55 })); glow.scale.setScalar(2.6);
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(.62, .5, .08, 40), new THREE.MeshPhysicalMaterial({ color: 0xe8f0ff, transmission: 1, thickness: .3, roughness: .1, iridescence: 1 })); pod.position.y = -.72;
    const podL = new THREE.Mesh(new THREE.TorusGeometry(.62, .014, 6, 60), new THREE.MeshBasicMaterial({ color: hdr(col, 1.8) })); podL.rotation.x = PI / 2; podL.position.y = -.68;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(.72, .018, 8, 90), new THREE.MeshBasicMaterial({ color: hdr('#5dffc4', 2.4) })); ring.visible = false;
    const ring2 = new THREE.Mesh(new THREE.SphereGeometry(.06, 12, 12), new THREE.MeshBasicMaterial({ color: hdr('#c8fff0', 3) })); ring.add(ring2); ring2.position.x = .72;
    g.add(orb, glow, pod, podL, ring); g.userData = { orb, glow, ring }; g.visible = false; SC.add(g); seatM.push(g);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(.02, .085, 1, 16, 1, true), new THREE.MeshBasicMaterial({ color: hdr(i === ME ? '#ffe2b0' : '#9fe8ff', .8), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })); beam.visible = false; SC.add(beam); beamM.push(beam);
  });
}
function proj(x, y, z) {
  if (!GL) return [W / 2 + (x / (AX + 1.6)) * W * .42, H_ * .47 + (z / (AZ + 1.6)) * H_ * .36 - y * 8];
  pv.set(x, y, z).project(CAM); if (pv.z > 1 || pv.z < -1) return null; return [(pv.x * .5 + .5) * W, (-pv.y * .5 + .5) * H_];
}
function resize() {
  W = window.innerWidth; H_ = window.innerHeight; PORT = W / H_ < .82; AX = PORT ? 3.0 : 4.3; AZ = PORT ? 4.3 : 3.0;
  if (!GL) return;
  R.setSize(W, H_, false); COMP.setSize(W, H_); CAM.aspect = W / H_; CAM.fov = PORT ? 50 : W / H_ < 1.3 ? 46 : 38; CAM.updateProjectionMatrix();
  tableG.scale.set(AX, 1, AZ); railM.scale.set(1, 1, 3.2);
}

// card pose → mesh
const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qc = new THREE.Quaternion(), XA = V(1, 0, 0), YA = V(0, 1, 0), ZA = V(0, 0, 1);
function place(m, P) {
  if (!P || P.s <= .001) { m.visible = false; return; }
  m.visible = true; m.position.set(P.x, P.y, P.z); m.scale.setScalar(P.s);
  qa.setFromAxisAngle(YA, P.yaw || 0); qb.setFromAxisAngle(XA, -PI / 2 + (P.tilt || 0)); qc.setFromAxisAngle(YA, (P.flip || 0) * PI); qa.multiply(qb).multiply(qc);
  if (P.roll) { qb.setFromAxisAngle(ZA, P.roll); qa.multiply(qb); }
  m.quaternion.copy(qa); m.userData.f.material.color.setScalar(P.dim != null ? P.dim : .84);
}
const arc = (a, b, x, hump) => [lerp(a[0], b[0], x), lerp(a[1], b[1], x) + Math.sin(PI * x) * hump, lerp(a[2], b[2], x)];
function holePose(Hh, i, j, t) {
  const hh = Hh.hole[i], d0 = hh.d0 + j * 150; if (t < d0) return null;
  const me = i === ME, a = ang(i), lat = (j - .5) * (me ? .98 : .56), r = rp(i, me ? .7 : .63, lat), bob = Math.sin(t / 900 + i * 1.7 + j) * .035;
  let P = { x: r[0], y: (me ? .6 : .45) + bob, z: r[1], tilt: me ? .86 : .5, yaw: PI / 2 - a, flip: 1, s: me ? 1.0 : .6, roll: (j - .5) * (me ? -.1 : -.16) };
  const x = (t - d0) / 1150;
  if (x < 1) { const e = ss(x), p = arc(VAULT(), [P.x, P.y, P.z], e, 1.5 + (i % 3) * .35); P.x = p[0] + Math.sin(x * PI) * Math.cos(a + 1.2) * .9; P.y = p[1]; P.z = p[2] + Math.sin(x * PI) * Math.sin(a + 1.2) * .9; P.flip = 1 + 4 * (1 - e); P.yaw += (1 - e) * 5; P.tilt = lerp(1.4, P.tilt, e); P.s *= .25 + .75 * eo(x * 1.4); P.fly = x; }
  if (t > hh.flipT) { const dur = hh.slow ? 2400 : 800, f = (t - hh.flipT) / dur, e = hh.slow ? ss(f) : spr(f * 1.1); P.flip = 1 - e + (hh.slow ? 2 * (1 - e) : 0); P.y += (hh.slow ? .75 * e : .12 * Math.sin(sat(f) * PI)) ; if (!me) { const g = ss(f), q = rp(i, .76), qx = q[0] + (j - .5) * .86, qz = q[1]; P.y += .25 * g; P.s = lerp(P.s, .8, g); P.tilt = lerp(P.tilt, .8, g); P.yaw = lerp(P.yaw, 0, g); P.roll = lerp(P.roll, 0, g); P.x = lerp(P.x, qx, g); P.z = lerp(P.z, qz, g); } if (hh.slow && f < 1) P.fly = f; }
  if (t > hh.foldT) { const f = (t - hh.foldT) / 900; P.y += eo(f) * 1.6; P.s *= 1 - ss(f); P.roll += f * 3; P.yaw += f * 2; }
  if (t > Hh.glowT && hh.cards) { const win = Hh.best[hh.cards[j]], g = ss((t - Hh.glowT) / 900); if (win) { P.y += .28 * g; P.glow = g; } else P.dim = lerp(.84, .4, g); }
  if (Hh.endT != null && t > Hh.endT - 500) P.s *= sat((Hh.endT - t) / 500);
  return P;
}
function boardPose(Hh, k, t) {
  const b = Hh.board[k], lt = t - b.t; if (lt < 0) return null;
  const sx = (b.slot - 2) * BS(), rest = [sx, .16, BZ()], bob = Math.sin(t / 1100 + k) * .02, v = VAULT();
  let P = { x: sx, y: .16 + bob, z: BZ(), tilt: .16, yaw: 0, flip: 0, s: PORT ? .68 : .9 };
  if (!b.slam) {
    const x = lt / 1000;
    if (x < 1) { const e = ss(x), p = arc(v, rest, e, 2.0); P.x = p[0] + Math.sin(x * PI) * (b.slot - 1) * 1.5; P.y = p[1]; P.z = p[2] + Math.sin(x * PI) * .9; P.flip = 3 * (1 - e); P.yaw = (1 - e) * (b.slot - 1) * 2.4; P.tilt = lerp(1.3, .16, e); P.s *= .2 + .8 * eo(x * 1.5); P.fly = x; }
    else { const y = (lt - 1000) / 500; P.y += Math.exp(-5 * y) * Math.abs(Math.sin(y * 7)) * .22; P.tilt += Math.exp(-4 * y) * Math.sin(y * 9) * .2; }
  } else {
    const hang = [sx, 3.3, BZ()];
    if (lt < 800) { const x = lt / 800, e = ss(x), p = arc(v, hang, e, .6); P.x = p[0]; P.y = p[1]; P.z = p[2]; P.flip = 2 * (1 - e) + 1; P.tilt = 1.45; P.s *= .2 + .9 * eo(x * 1.5); P.yaw = (1 - e) * 4; P.fly = x; }
    else if (lt < 1280) { const x = (lt - 800) / 480; P.y = 3.3 + Math.sin(x * PI) * .12; P.tilt = 1.45; P.flip = 1 - spr(x * 1.5); P.s *= 1.1; }
    else if (lt < 1500) { const x = ei((lt - 1280) / 220); P.y = lerp(3.3, .16, x); P.tilt = lerp(1.45, .16, x); P.s *= lerp(1.1, 1, x); P.fly = .5; }
    else { const y = (lt - 1500) / 500; P.y += Math.exp(-6 * y) * Math.abs(Math.sin(y * 8)) * .16; }
  }
  if (t > Hh.glowT) { const win = Hh.best[b.c], g = ss((t - Hh.glowT) / 900); if (win) { P.y += .62 * g; P.tilt += .42 * g; P.s *= 1 + .08 * g; P.glow = g; } else { P.dim = lerp(.84, .38, g); P.s *= 1 - .07 * g; } }
  if (Hh.endT != null && t > Hh.endT - 500) P.s *= sat((Hh.endT - t) / 500);
  return P;
}

function render(t) {
  curT = t;
  const Hh = (() => { for (let i = hands.length - 1; i >= 0; i--) if (hands[i].t0 <= t) return hands[i]; return null; })();
  // pulses → flare, shake
  let flare = 0, shake = 0; const rings = [];
  for (const p of pulses) { const lt = t - p.t; if (lt < 0 || lt > 2200) continue; if (p.kind === 'flare') flare = Math.max(flare, Math.exp(-lt / 380) * (p.p[0] || 1)); if (p.kind === 'shock') { rings.push({ p: p.p, x: lt / 1500, big: 1 }); rings.push({ p: p.p, x: (lt - 160) / 1500, big: 1 }); } if (p.kind === 'ring') rings.push({ p: p.p, x: lt / 700, big: 0 }); if (p.kind === 'burst') { rings.push({ p: [p.p[0], .1, p.p[2]], x: lt / 1600, big: 1 }); shake = Math.max(shake, Math.exp(-lt / 300) * .6); } }
  flashEl.style.opacity = (flare * .06).toFixed(3);
  const pot = stepv(potK, t, 500), fill = sat(pot / potMax);
  if (GL) {
    const c = camAt(t); if (PORT) c.l[2] += 1.5; const k = PORT ? 1.85 : W / H_ < 1.3 ? 1.12 : 1, el = PORT ? Math.min(1.25, c.el + .34) : c.el, az = c.az * (PORT ? .3 : 1) + Math.sin(t / 5200) * .02, d = c.d * k;
    CAM.position.set(c.l[0] + Math.sin(az) * Math.cos(el) * d + Math.sin(t / 37) * shake * .12, c.l[1] + Math.sin(el) * d + Math.sin(t / 2700) * .1 + Math.sin(t / 29) * shake * .12, c.l[2] + Math.cos(az) * Math.cos(el) * d);
    CAM.lookAt(c.l[0], c.l[1], c.l[2]);
    planetM.material.uniforms.tm.value = t / 9000; planetM.rotation.y = t / 240000; starsM.rotation.y = t / 400000;
    decal.rotation.z = tv('rot', t) + t / 60000; tableG.userData.line.offset.x = t / 14000;
    // vault
    const vp = VAULT(), va = tv('vault', t) || 0; vaultG.position.set(vp[0], vp[1] + Math.sin(t / 1300) * .08, vp[2]); vaultG.rotation.y = t / 2300; vaultM.rotation.x = Math.sin(t / 3100) * .2;
    vaultG.scale.setScalar(.72 + va * .16); vaultCore.scale.setScalar(.8 + va * .8 + Math.sin(t / 500) * .06 * va); vaultCore.rotation.y = -t / 700;
    vaultG.userData.cage.rotation.set(t / 1900, 0, t / 2700); vaultG.userData.cage2.rotation.set(PI / 2 + t / 2300, t / 1700, 0);
    // pot orb (travels to the winner, bursts)
    let op = ORB(), os = .55 + fill * .75, oe = fill;
    if (Hh && t >= Hh.winT) { const lt = t - Hh.winT, w = rp(Hh.winSeat, .86); if (lt < 950) { const e = ei(lt / 950); op = arc(op, [w[0], 1.2, w[1]], e, 1.6); os *= 1 + e * .5; oe = 1 + e * 2; } else { const back = sat((lt - 2600) / 900); os = .55 * spr(back); oe = 0; if (!back) os = 0; } }
    orbM.position.set(op[0], op[1] + Math.sin(t / 1000) * .05, op[2]); orbM.scale.setScalar(Math.max(.001, os)); orbM.rotation.y = t / 1500; orbM.visible = os > .01;
    orbCore.position.copy(orbM.position); orbCore.scale.setScalar(Math.max(.001, os * (.28 + Math.min(oe, 1.4) * .26 + flare * .2))); orbCore.rotation.set(t / 900, t / 700, 0); orbCore.visible = orbM.visible;
    { const q = Math.min(oe, 1.4); orbCore.material.color.setRGB(.45 + q * .5 + flare * .5, .5 + q * .28 + flare * .4, .9 + q * .12 + flare * .4); }
    orbLight.position.copy(orbM.position); orbLight.intensity = (oe * 8 + flare * 14) * (orbM.visible ? 1 : 0);
    BLOOM.strength = .36 + flare * .2; R.toneMappingExposure = .98 + flare * .06;
    // seats
    let actor = -1; for (const a of actK) if (t >= a.s && t < a.e) actor = a.seat;
    for (let i = 0; i < N && i < seatM.length; i++) {
      const g = seatM[i], lt = t - joinT[i]; if (lt < 0) { g.visible = false; continue; }
      const me = i === ME, p = rp(i, me ? 1.16 : 1), a = spr(lt / 900), far = 1 - eo(lt / 900), out = Hh && t > Hh.hole[i].foldT, ac = actor === i ? 1 : 0;
      g.visible = true; g.position.set(p[0] * (1 + far * 4), (me ? .2 : .95) + Math.sin(t / 1000 + i * 2.1) * .08 + far * 9, p[1] * (1 + far * 4)); g.scale.setScalar((.2 + .8 * a) * (me ? .8 : 1));
      g.userData.orb.scale.setScalar((out ? .78 : 1) * (1 + ac * (.06 + Math.sin(t / 400) * .03))); g.userData.orb.material.emissiveIntensity = out ? .12 : .45 + ac * .5; g.userData.glow.material.opacity = out ? .06 : .2 + ac * .22 + far * .5;
      g.userData.glow.scale.setScalar(2.4 + ac * .6 + far * 3);
      const rg = g.userData.ring, isAI = KINDS && KINDS[SEATS[i].id] === 'AI', rl = t - revealT - i * 180; rg.visible = !!isAI && rl > 0; if (rg.visible) { rg.scale.setScalar(spr(rl / 800)); rg.rotation.set(PI / 2 + Math.sin(t / 1400 + i) * .5, t / 900 + i, 0); }
    }
    // hole cards, beams, trails, glows
    let ti = 0, gi = 0; const trail = (fn, col) => { for (let q = 1; q <= 4 && ti < trailM.length; q++) { const P = fn(t - q * 28); if (!P || P.fly == null) break; const s = trailM[ti++]; s.visible = true; s.position.set(P.x, P.y, P.z); s.scale.setScalar(1.1 * P.s * (1 - q / 7)); s.material.opacity = .2 * (1 - q / 5); s.material.color.set(col); } };
    const glowAt = (P) => { if (P && P.glow && gi < glowM.length) { const s = glowM[gi++]; s.visible = true; s.position.set(P.x, P.y - .05, P.z); s.scale.setScalar(2.2 * P.s); s.material.opacity = P.glow * (.32 + Math.sin(t / 600 + gi) * .05); } };
    for (let i = 0; i < 6; i++) for (let j = 0; j < 2; j++) {
      const m = holeM[i * 2 + j]; if (!Hh || i >= N) { m.visible = false; continue; }
      const P = holePose(Hh, i, j, t), hh = Hh.hole[i]; place(m, P);
      if (P) { const f = m.userData.f; if (hh.cards) { const tx = faceTex(hh.cards[j]); if (f.material.map !== tx) { f.material.map = tx; f.material.needsUpdate = true; } f.visible = true; } else f.visible = false; if (P.fly != null) trail((tt) => holePose(Hh, i, j, tt), i === ME ? '#ffd9a8' : PAL[i % PAL.length]); glowAt(P); }
    }
    for (let i = 0; i < beamM.length; i++) {
      const b = beamM[i], d0 = Hh ? Hh.hole[i].d0 : Infinity, lt = t - d0, o = lt > -200 && lt < 2400 ? sat((lt + 200) / 300) * sat((2400 - lt) / 900) : 0; b.visible = o > .01;
      if (b.visible) { const r = rp(i, .78), a = V(vp[0], vp[1], vp[2]), e = V(r[0], .7, r[1]); b.position.copy(a).lerp(e, .5); b.scale.set(1, a.distanceTo(e), 1); b.quaternion.setFromUnitVectors(YA, e.sub(a).normalize()); b.material.opacity = o * .22; }
    }
    for (let k = 0; k < 5; k++) { const m = boardM[k]; if (!Hh || k >= Hh.board.length) { m.visible = false; continue; } const P = boardPose(Hh, k, t); place(m, P); if (P) { const f = m.userData.f, tx = faceTex(Hh.board[k].c); if (f.material.map !== tx) { f.material.map = tx; f.material.needsUpdate = true; } if (P.fly != null) trail((tt) => boardPose(Hh, k, tt), '#bff6ff'); glowAt(P); } }
    for (; ti < trailM.length; ti++) trailM[ti].visible = false; for (; gi < glowM.length; gi++) glowM[gi].visible = false;
    // chips arc from the seat to the bet line, then into the orb
    let ci = 0; const o0 = ORB();
    for (const c of chipsRec) {
      if (t < c.tb || t > c.tc + 800 || ci >= chipM.length) continue;
      const m = chipM[ci++], s = rp(c.seat, .92), col = Math.floor(c.k / 7), b = rp(c.seat, c.seat === ME ? .36 : .44, (c.seat === ME ? 1.25 : .7) + col * .42), rest = [b[0], .09 + (c.k % 7) * .062, b[1]];
      let p = rest, sc = 1; const x = (t - c.tb) / 620;
      if (x < 1) { p = arc([s[0], .8, s[1]], rest, eo(x), 1.3); m.rotation.set(x * 9, 0, x * 5); } else { m.rotation.set(0, c.k, 0); p = [rest[0], rest[1] + Math.sin(t / 700 + c.k * .8 + c.seat) * .012 + Math.exp(-(x - 1) * 4) * Math.abs(Math.sin((x - 1) * 8)) * .1, rest[2]]; }
      if (t > c.tc) { const y = (t - c.tc) / 760; p = arc(rest, o0, ei(y) * .5 + ss(y) * .5, 1.5); sc = 1 - ei(y) * .8; m.rotation.set(y * 12, 0, y * 7); }
      m.visible = true; m.position.set(p[0], p[1], p[2]); m.scale.setScalar(sc); const mt = m.userData.tones[c.tone]; if (m.material !== mt) m.material = mt;
    }
    for (; ci < chipM.length; ci++) chipM[ci].visible = false;
    // shockwaves
    let ri = 0; for (const r of rings) { if (r.x <= 0 || r.x >= 1 || ri >= ringM.length) continue; const m = ringM[ri++]; m.visible = true; m.position.set(r.p[0], .05, r.p[2]); m.scale.setScalar(r.big ? .3 + eo(r.x) * 7 : .25 + eo(r.x) * 1.1); m.material.opacity = (1 - r.x) * .3; m.material.color.setRGB(.6, 1.0, 1.1); }
    for (; ri < ringM.length; ri++) ringM[ri].visible = false;
    // glass shards
    let B = burst; while (B && B.t > t) B = B.prev; const bl = B ? (t - B.t) / 1000 : -1; shardM.visible = bl >= 0 && bl < 4.2;
    if (shardM.visible) { const M = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sv = V(1, 1, 1), ps = V(0, 0, 0), dd = shardM.userData.d; for (let k = 0; k < 180; k++) { const d = dd[k], r = (1 - Math.exp(-1.7 * bl)) * 3.4 * d[3]; ps.set(B.p[0] + d[0] * r, B.p[1] + d[1] * r + bl * .35, B.p[2] + d[2] * r); e.set(d[4] + bl * 3 * d[5], d[4] * 2 + bl * 2, bl * d[5]); q.setFromEuler(e); sv.setScalar(k % 3 ? 0 : d[5] * .6 * sat(1 - bl / 4.2) * sat(bl * 8)); M.compose(ps, q, sv); shardM.setMatrixAt(k, M); } shardM.instanceMatrix.needsUpdate = true; }
    COMP.render();
  } else if (Hh) {
    setH(flatEl, '<div>' + Hh.board.filter((b) => t >= b.land).map((b) => pc(b.c)).join('') + '</div><div>' + (Hh.hole[ME].cards && t > Hh.hole[ME].flipT ? Hh.hole[ME].cards.map((c) => pc(c)).join('') : t > Hh.hole[ME].d0 ? pc(null) + pc(null) : '') + '</div>');
  }
  // plates
  if (SEATS) {
    let actor = -1; for (const a of actK) if (t >= a.s && t < a.e) actor = a.seat;
    for (let i = 0; i < N; i++) {
      const p = plates[i], lt = t - joinT[i]; if (lt < 300) { p.style.display = 'none'; betEls[i].style.display = 'none'; continue; }
      const me = i === ME, s = rp(i, me ? 1.16 : 1.02), xy = proj(s[0], me ? -.75 : 1.7, s[1] + (me ? .3 : 0)); if (!xy) { p.style.display = 'none'; continue; }
      const out = Hh && t > Hh.hole[i].foldT; let tag = null; for (const k of tagK[i]) if (t >= k.s && t < k.e) tag = k;
      const kd = KINDS && t > revealT + i * 180 ? KINDS[SEATS[i].id] : null, pos = Hh && Hh.pos ? Hh.pos[i] : null; let stamp = ''; for (const k of stampK[i]) if (t >= k.s && t < k.e && (!Hh || k.s >= Hh.t0)) stamp = stampHTML(k.rc, t >= k.showS && t < k.showE);
      const low = xy[1] < H_ * .3;
      const card = '<div class="card"><span class="nm">' + (me ? 'YOU' : esc(SEATS[i].name).toUpperCase()) + (pos ? '<i>' + pos + '</i>' : '') + '</span><span class="st">' + Math.round(stepv(stackK[i], t)) + '</span></div>';
      const tg = tag ? '<span class="tag ' + tag.cls + '" style="transform:scale(' + (.6 + .4 * spr((t - tag.s) / 500)).toFixed(3) + ');opacity:' + sat((tag.e - t) / 300).toFixed(2) + '">' + esc(tag.text) + '</span>' : '';
      const kh = kd ? '<span class="kind ' + (kd === 'AI' ? 'ai' : '') + '">' + (kd === 'AI' ? 'AI · VERIFIED AGENT' : esc(kd)) + '</span>' : KINDS && t > revealT ? '<span class="kind unk">UNKNOWN</span>' : '';
      setH(p, me ? tg + card + stamp + kh : (low ? card + tg + stamp + kh : tg + card + stamp + kh));
      p.className = 'plate' + (actor === i ? ' act' : '') + (out ? ' out' : '') + (low ? ' low' : '');
      p.style.display = ''; p.style.opacity = sat((lt - 300) / 400); p.style.transform = 'translate(' + xy[0].toFixed(1) + 'px,' + xy[1].toFixed(1) + 'px) translate(-50%,' + (me ? '-100%' : low ? '0' : '-100%') + ')';
      const bv = stepv(betK[i], t, 1), be = betEls[i];
      if (bv > 0) { const b = rp(i, me ? .36 : .44, (me ? 1.25 : .7) + .2), bxy = proj(b[0], .75, b[1]); if (bxy) { be.style.display = ''; setH(be, String(bv)); be.style.transform = 'translate(' + bxy[0].toFixed(1) + 'px,' + bxy[1].toFixed(1) + 'px) translate(-50%,-50%)'; } else be.style.display = 'none'; } else be.style.display = 'none';
    }
  }
  // clips
  for (const c of clips) { const on = t >= c.s && t < c.e; if (on !== c.on) { c.on = on; if (c.el) c.el.style.display = on ? '' : 'none'; } if (on) c.fn((t - c.s) / (c.e - c.s), t, t - c.s); }
  let sc = null; for (let i = scenes.length - 1; i >= 0; i--) if (t >= scenes[i].start) { sc = scenes[i]; break; }
  setH(hudPhase, sc && sc.label ? esc(sc.label) : ''); setH(hudPot, pot > 0 ? 'Pot <b>' + Math.round(pot) + '</b>' : '');
}

// ---------- boot ----------
async function boot(opts) {
  opts = opts || {};
  try { await Promise.race([Promise.all(['800 96px Syne', '700 96px "Space Grotesk"', '500 14px "JetBrains Mono"'].map((f) => document.fonts.load(f))), new Promise((r) => setTimeout(r, 3000))]); } catch (e) { /* offline: fallbacks */ }
  try { if (Q.has('nogl')) throw new Error('nogl'); build3D(); } catch (e) { GL = false; document.documentElement.classList.add('nogl'); if (!Q.has('nogl')) console.warn('WebGL unavailable, using the flat table:', e && e.message); }
  resize(); window.addEventListener('resize', () => { resize(); render(curT); });
  adapter = opts.adapter || HD.createMockAdapter({ auto: DIRECTOR, omni: OMNI });
  let manual = Q.has('t'), playT = manual ? +Q.get('t') : 0, last = null, speed = +(Q.get('speed') || 1), paused = false;
  curT = playT;
  adapter.start(consume);
  const limit = () => (holdAt != null ? holdAt : T);
  function tick(now) {
    if (!manual && !paused && last != null) playT = Math.min(playT + Math.min(now - last, 100) * speed, limit());
    last = now; if (SEATS) render(playT); requestAnimationFrame(tick);
  }
  if (DIRECTOR) {
    window.director = { duration: T, scenes: scenes.map((s) => ({ id: s.id, start: s.start, end: s.end })), seek(ms) { manual = true; playT = Math.max(0, Math.min(ms, T)); render(playT); }, play() { manual = false; }, get time() { return playT; } };
  } else {
    const ctl = $('#ctl');
    if (!opts.adapter) { const v = document.createElement('button'); v.textContent = OMNI ? 'Player’s view' : 'Viewer’s cut'; v.title = OMNI ? 'Hide the TEE stamps until the hand ends' : 'Show the TEE stamp on every AI decision while the hand runs'; v.onclick = () => { const q = new URLSearchParams(location.search); if (OMNI) q.delete('omni'); else q.set('omni', '1'); location.search = q.toString(); }; ctl.appendChild(v); }
    const b = document.createElement('button'); b.textContent = 'Skip ▸▸'; b.title = 'Jump to the next beat';
    b.onclick = () => { const nx = scenes.find((s) => s.start > playT + 50); playT = Math.min(nx ? nx.start : limit(), limit()); };
    ctl.appendChild(b);
    window.addEventListener('keydown', (e) => { if (e.target.tagName === 'INPUT') return; if (e.code === 'Space') { paused = !paused; e.preventDefault(); } if (e.code === 'ArrowRight') b.onclick(); });
  }
  window.holdem = { get time() { return playT; }, get end() { return T; }, get gate() { return holdAt; }, scenes, seek(ms) { manual = true; playT = ms; render(ms); }, resume() { manual = false; }, get gl() { return GL; } };
  if (SEATS) render(playT); requestAnimationFrame(tick);
  return window.holdem;
}
HD.boot = boot;
// LIVE: client/main.ts mounts the table once the room's play starts (window.HOLDEM_BOOT is set then).
HD.mount = () => { HD.ready = boot(window.HOLDEM_BOOT || {}); if (DIRECTOR) HD.ready.then(() => { window.director.ready = true; }); return HD.ready; };
