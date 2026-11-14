// @ts-nocheck
// Copied from games/holdem/ui/app.js (the noir show engine, Fable session snapshot 20:04Z); adapted for the live game where marked LIVE.
/* NEAR HOLD'EM — the show engine (same engine family as NEARWOLF).
 * Everything on screen is a pure function of one timeline time t (ms): render(t).
 * Events from a HoldemView (see story.js) are compiled into clips on that timeline.
 *   play mode:      a clock advances t and stops at "gates" until you act.
 *   director mode:  ?director=1  → window.director = { duration, seek(ms), scenes, ready }
 *   ?omni=1         viewer's cut in play mode: AI decisions show their TEE seal while the hand is still running.
 * No Math.random, no wall-clock inside render.
 */
// LIVE: mounted by client/main.ts once the table's seats are known (HOLDEM.SEATS, 2 to 6).
(window.HOLDEM = window.HOLDEM || {}).mount = function () {
  'use strict';
  const HD = window.HOLDEM, SEATS = HD.SEATS, N = SEATS.length, PI = Math.PI;
  const Q = new URLSearchParams(location.search);
  const DIRECTOR = Q.has('director'), OMNI = DIRECTOR || Q.has('omni');
  if (DIRECTOR) document.documentElement.classList.add('director');
  const idx = {}; SEATS.forEach((s, i) => (idx[s.id] = i));
  let ME = 0;
  const short = (id) => (idx[id] === ME ? 'YOU' : SEATS[idx[id]].name.toUpperCase());
  const $ = (s) => document.querySelector(s);
  const ui = $('#ui'), tbl = $('#tbl'), glc = $('#gl'), dimEl = $('#dim'), grainEl = $('#grain'), hud = $('#hud');

  // ---------- math ----------
  const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const lerp = (a, b, x) => a + (b - a) * x;
  const ss = (x) => { x = sat(x); return x * x * x * (x * (x * 6 - 15) + 10); };
  const eo = (x) => 1 - Math.pow(1 - sat(x), 3);
  const eox = (x) => { x = sat(x); return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x); };
  const eio = (x) => { x = sat(x); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  function prng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
  // your own seat is always nearest the camera; the other seats fan out across the far side so nobody blocks the felt
  const ang = (i) => { const k = (i - ME + N) % N; return k === 0 ? PI / 2 : N < 3 ? 1.5 * PI : PI / 2 + 2 * PI * (.2 + (.6 * (k - 1)) / (N - 2)); };
  const sp = (i, r) => [Math.cos(ang(i)) * r, Math.sin(ang(i)) * r];
  const sh = (s, n) => s.slice(0, n) + '…' + s.slice(-4);

  const ORDW = ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE'];
  // ---------- cards ----------
  const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' }, RED = { h: 1, d: 1 }, VS = '︎';
  const rk = (c) => (c[0] === 'T' ? '10' : c[0]);
  const ctext = (c) => rk(c) + SUIT[c[1]] + VS;
  const pc = (c, cls) => (c ? '<span class="pc ' + (RED[c[1]] ? 'r ' : '') + (cls || '') + '"><b>' + rk(c) + '</b><i>' + SUIT[c[1]] + VS + '</i></span>' : '<span class="pc bk ' + (cls || '') + '"></span>');

  // ---------- timeline ----------
  const clips = [], scenes = [], tracks = {}, camKeys = [];
  let T = 0, holdAt = null, FINAL = false;
  const joinT = new Array(N).fill(Infinity);
  let foldT = new Array(N).fill(Infinity);
  const stackK = SEATS.map(() => [{ t: -1, v: 0 }]), betK = SEATS.map(() => [{ t: -1, v: 0 }]), potK = [{ t: -1, v: 0 }], tagK = SEATS.map(() => []);
  let holes = SEATS.map(() => ({ d0: Infinity, cards: null, flipT: Infinity }));
  let board = [];
  const chips = [], colCount = new Array(N).fill(0), POS = {};
  let potCount = 0, btnT = Infinity, btnSeat = 0, curStreet = null, handT = Infinity, myHole = null, lastShow = null, winT = Infinity;
  let P = null, adapter = null, openPick = null, lastEnv = null;
  let F = null; // per-frame state
  // LIVE: a sit-and-go deals hand after hand. Each hand's holes, board and folds are a generation that
  // starts at its own timeline time; render(t) draws the generation in play at t.
  const GEN = [{ t: -Infinity, holes, board, foldT }];
  let handsSeen = 0;
  function newHand(t0) {
    holes = SEATS.map(() => ({ d0: Infinity, cards: null, flipT: Infinity }));
    board = []; foldT = new Array(N).fill(Infinity);
    GEN.push({ t: t0, holes, board, foldT });
    chips.forEach((c) => { if (c.gone === undefined || c.gone === Infinity) c.gone = t0; });
    tagK.forEach((k) => k.forEach((g) => { if (g.e > t0) g.e = t0; }));
    colCount.fill(0); potCount = 0; curStreet = null; lastShow = null; myHole = null; handT = Infinity;
    for (const k in POS) delete POS[k];
  }
  function genAt(t) { for (let k = GEN.length - 1; k >= 0; k--) if (GEN[k].t <= t) return GEN[k]; return GEN[0]; }

  function add(s, e, fn, el) { const c = { s, e, fn, el, on: false }; clips.push(c); return c; }
  function h(cls, html) { const e = document.createElement('div'); e.className = cls; e.innerHTML = html || ''; e.style.display = 'none'; ui.appendChild(e); return e; }
  function scene(id, label) { if (scenes.length) scenes[scenes.length - 1].end = T; scenes.push({ id, start: T, end: T, label: label || '' }); }
  function ramp(name, t0, dur, v) {
    const k = tracks[name] || (tracks[name] = [{ t: -1, v: 0 }]);
    const last = k[k.length - 1]; k.push({ t: Math.max(t0, last.t), v: last.v }, { t: Math.max(t0, last.t) + dur, v });
  }
  function tv(name, t) {
    const k = tracks[name]; if (!k) return 0; let i = k.length - 1; while (i > 0 && k[i].t > t) i--;
    const a = k[i], b = k[i + 1]; if (!b || b.t <= a.t) return a.v; return lerp(a.v, b.v, ss((t - a.t) / (b.t - a.t)));
  }
  const stepAt = (k, t) => { let i = k.length - 1; while (i > 0 && k[i].t > t) i--; return k[i].v; };
  const POSE = {
    wide: (az) => ({ az: az == null ? PI / 2 : az, el: .6, d: 17.5, lx: 0, ly: .2, lz: 0, fov: 36 }),
    high: () => ({ az: PI / 2 - .5, el: 1.0, d: 25, lx: 0, ly: 0, lz: 0, fov: 36 }),
    table: (az) => ({ az: az == null ? PI / 2 : az, el: .7, d: 16.2, lx: 0, ly: .3, lz: -.2, fov: 36 }),
    board: () => ({ az: PI / 2 + .1, el: .95, d: 10.8, lx: 0, ly: .3, lz: -.75, fov: 34 }),
    center: () => ({ az: PI / 2 + .35, el: .42, d: 9.5, lx: 0, ly: 1.0, lz: 0, fov: 34 }),
    seat: (i) => { const a = ang(i); return { az: a + PI + .22, el: .3, d: 8.4, lx: Math.cos(a) * 5.6, ly: 1.5, lz: Math.sin(a) * 5.6, fov: 32, ox: Math.sin(a) * 1.9, oz: -Math.cos(a) * 1.9 }; },
  };
  function camTo(t0, dur, pose) {
    const last = camKeys[camKeys.length - 1];
    pose = Object.assign({ ox: 0, oz: 0 }, pose);
    if (!last) { camKeys.push(Object.assign({ t: t0 }, pose)); return; }
    const p = Object.assign({}, pose); while (p.az - last.az > PI) p.az -= 2 * PI; while (p.az - last.az < -PI) p.az += 2 * PI;
    const s = Math.max(t0, last.t);
    camKeys.push(Object.assign({}, last, { t: s }), Object.assign(p, { t: s + dur }));
  }
  function camAt(t) {
    let i = camKeys.length - 1; while (i > 0 && camKeys[i].t > t) i--;
    const a = camKeys[i], b = camKeys[i + 1]; if (!b || b.t <= a.t) return a;
    const x = ss((t - a.t) / (b.t - a.t)), o = {}; for (const k of ['az', 'el', 'd', 'lx', 'ly', 'lz', 'fov', 'ox', 'oz']) o[k] = lerp(a[k], b[k], x); return o;
  }

  // ---------- chips (they slide as towers, with weight) ----------
  const chipN = (amount) => Math.min(12, Math.max(1, Math.round(Math.sqrt(amount) * 1.1)));
  const COLX = [0, .46, -.46, .92, -.92, 1.38, -1.38];
  function addChips(i, t0, amount) {
    const n = chipN(amount), col = COLX[Math.min(colCount[i]++, COLX.length - 1)];
    for (let k = 0; k < n; k++) chips.push({ i, col, lvl: k, t0: t0 + k * 9, tc: Infinity, tw: Infinity, tone: (chips.length * 7 + k * 3 + (amount > 20 ? 1 : 0)) % 3 });
  }
  function collect(tc) {
    let k = 0;
    chips.forEach((c) => { if (c.tc !== Infinity) return; const j = potCount++; c.tc = tc + (k++) * 14; c.p = [((j % 6) - 2.5) * .44, .205 + Math.floor(j / 12) * .055, 1.5 + (Math.floor(j / 6) % 2) * .44]; });
    colCount.fill(0);
  }
  function award(tw, i) { winT = tw; chips.forEach((c, k) => { c.tw = tw + (k % 12) * 30 + Math.floor(k / 12) * 12; c.wi = i; c.w = [((k % 5) - 2) * .44, .205 + Math.floor(k / 10) * .055, (Math.floor(k / 5) % 2) * .44]; }); }

  // ---------- reusable clips ----------
  /** big kinetic type. lines: [{t: html, c: 'red sm xl serif mono'}] */
  function kinetic(start, dur, ls, o) {
    o = o || {};
    const el = h('kin ' + (o.cls || ''), ls.map((l) => '<span class="ln ' + (l.c || '') + '">' + l.t + '</span>').join(''));
    const spans = Array.from(el.children), stag = o.stagger == null ? 140 : o.stagger; let fitW = -1, fits = [];
    spans.forEach((s) => { if (!/serif/.test(s.className)) s.style.whiteSpace = 'nowrap'; });
    add(start, start + dur, (p, t, lt) => {
      const W = ui.clientWidth;
      if (fitW !== W) { fitW = W; fits = spans.map((s) => { s.style.transform = 'none'; const w = s.scrollWidth; return /serif/.test(s.className) ? 1 : Math.min(1, (W * .92) / (w || 1)); }); }
      const out = sat((dur - lt) / 360); let vis = 0;
      spans.forEach((s, i) => {
        const a = sat((lt - i * stag) / (o.slow ? 900 : 380)); vis = Math.max(vis, a * out);
        s.style.opacity = Math.min(1, a * 1.6) * out;
        s.style.transform = 'scale(' + fits[i] * lerp(o.slow ? 1.12 : 1.7, 1, eox(a)) * lerp(1.04, 1, out) + ')';
        s.style.filter = a < 1 ? 'blur(' + ((1 - a) * 12).toFixed(1) + 'px)' : 'none';
      });
      F.blur = Math.max(F.blur, (o.blur == null ? 5 : o.blur) * vis);
      F.dim = Math.max(F.dim, (o.dim == null ? .28 : o.dim) * vis);
      if (o.slam) F.shake += Math.exp(-Math.max(0, lt - 60) / 170) * (o.slam === true ? .1 : o.slam) * (lt > 60 ? 1 : 0);
    }, el);
  }
  function tagText(ev) {
    switch (ev.kind) {
      case 'post': return ev.label || 'POSTS ' + ev.amount;
      case 'fold': return 'FOLD'; case 'check': return 'CHECK'; case 'call': return 'CALL ' + ev.to;
      case 'bet': return 'BET ' + ev.to; case 'raise': return 'RAISE TO ' + ev.to; default: return 'ALL-IN ' + ev.to;
    }
  }
  function moveText(m) {
    switch (m.kind) {
      case 'fold': return 'folds'; case 'check': return 'checks'; case 'call': return 'calls ' + m.to;
      case 'bet': return 'bets ' + m.to; case 'raise': return 'raises to ' + m.to; case 'allin': return 'all-in for ' + m.to; default: return m.kind;
    }
  }
  function tipHTML(rc) {
    return '<div class="tip"><h6>TEE receipt<span>verified ✓</span></h6><div class="kv">' +
      '<span>model</span><span>' + rc.model + ' · NEAR AI Cloud</span>' +
      '<span>signer</span><span>' + rc.signing_address + '</span>' +
      '<span>request sha256</span><span>' + rc.request_sha256 + '</span>' +
      '<span>response sha256</span><span>' + rc.response_sha256 + '</span>' +
      '<span>signature</span><span>' + sh(rc.signature, 34) + '</span>' +
      '<span>attestation</span><span>Intel TDX + NVIDIA confidential GPU <b class="chk">✓</b></span></div></div>';
  }
  /** lower third for a big action: who, what, the sealed reasoning (redacted), the wax seal */
  function lower(start, dur, ev, tipAuto) {
    const i = idx[ev.seat], s = SEATS[i], rc = ev.receipt;
    let bars = '';
    if (rc) { const hx = rc.response_sha256; for (let k = 0; k < 15; k++) bars += '<span class="rd">' + 'x'.repeat(2 + (parseInt(hx[k], 16) % 8)) + '</span> '; }
    const sealHtml = rc
      ? '<div class="seal tipw"><span class="wax">TEE</span><span>Signed in NEAR AI TEE <b class="ok">✓</b></span>' + tipHTML(rc) + '</div>'
      : '<div class="seal"><span>Sealed move · opened by the keeper <b class="ok">✓</b></span></div>';
    const el = h('l3', '<div class="bar"></div><div class="who">' + s.name + '<small>' + s.title + '</small></div><div class="mv">' + tagText(ev) + ' · POT ' + ev.pot + '</div>' +
      (rc ? '<div class="say sealed">' + bars + '</div><div class="note">Private reasoning · sealed until the hand ends</div>' : '') + sealHtml);
    const rds = Array.from(el.querySelectorAll('.rd')), seal = el.querySelector('.seal'), wax = el.querySelector('.wax'), bar = el.querySelector('.bar'), tip = el.querySelector('.tip');
    const sealAt = rc ? 1400 : 700; let shown = -1;
    add(start, start + dur, (p, t, lt) => {
      const a = eo(lt / 350), out = sat((dur - lt) / 300), vis = a * out;
      el.style.opacity = vis; el.style.transform = 'translateY(' + (1 - a) * 30 + 'px)'; bar.style.transform = 'scaleX(' + eo(lt / 600) + ')';
      const n = Math.floor(sat((lt - 300) / 900) * rds.length); if (n !== shown) { shown = n; rds.forEach((r, k) => { r.style.visibility = k < n ? 'visible' : 'hidden'; }); }
      const q = sat((lt - sealAt) / 260); seal.style.opacity = q > 0 ? 1 : 0;
      if (wax) { wax.style.transform = 'scale(' + lerp(2.6, 1, eox(q)) + ') rotate(' + lerp(-30, -8, eox(q)) + 'deg)'; if (q > 0) F.shake += Math.exp(-(lt - sealAt) / 120) * .03; }
      if (tip && tipAuto) { const tq = sat((lt - 2500) / 260) * sat((dur - 600 - lt) / 260); tip.style.opacity = tq; tip.style.visibility = tq > 0 ? 'visible' : 'hidden'; tip.style.transform = 'translateY(' + (1 - eo(tq)) * 10 + 'px)'; }
      for (let k = 0; k < N; k++) F.lit[k] = lerp(F.lit[k], k === i ? 1.25 : F.lit[k] * .3, vis);
      F.spot = i; F.spotI = Math.max(F.spotI, vis); F.plates = Math.min(F.plates, 1 - vis);
    }, el);
  }
  function confessional(start, dur, seat, street, at, text, rc) {
    const s = SEATS[idx[seat]], sealed = text == null;
    const body = sealed ? 'I am not going to tell you why I did that. What I hold, what I think you hold and what I want you to believe stays in here until the last card is turned.' : text;
    const el = h('conf', '<div class="pt"><i style="background-image:url(\'' + P[seat].url + '\')"></i></div><div class="tx">' +
      '<div class="rec"><b>●</b> REC &nbsp; SEALED REASONING · THE ' + street.toUpperCase() + ' · ' + at + ' UTC</div><h3>' + s.name + '</h3>' +
      '<div class="body"></div><div class="st"></div><div class="stamp ' + (sealed ? '' : 'okk') + '">' + (sealed ? 'Sealed until the hand ends' : 'Unsealed ✓ signature verified') + '</div></div>');
    const pt = el.querySelector('.pt i'), bd = el.querySelector('.body'), st = el.querySelector('.st'), stamp = el.querySelector('.stamp'), rec = el.querySelector('.rec b');
    const st1 = 'Private reasoning · NEAR AI Cloud · Intel TDX + NVIDIA confidential GPU';
    const st2 = sealed ? 'Nobody can read this. Not the table. Not us.' : 'response_sha256 ' + sh(rc.response_sha256, 12) + ' · signer ' + sh(rc.signing_address, 10) + ' <b class="ok">✓</b>';
    const t0 = 900, t1 = sealed ? dur * .55 : dur * .62; let shown = -1, stK = -1;
    add(start, start + dur, (p, t, lt) => {
      const vis = sat(lt / 450) * sat((dur - lt) / 450);
      el.style.opacity = vis; pt.style.transform = 'scale(' + (1 + p * .09) + ') translateX(' + (-p * 1.5) + '%)';
      rec.style.opacity = Math.floor(lt / 600) % 2 ? .25 : 1;
      const n = Math.floor(sat((lt - t0) / (t1 - t0)) * body.length);
      if (n !== shown) { shown = n; const tx = body.slice(0, n); bd.innerHTML = (sealed ? tx.split(' ').map((w) => '<span class="rd">' + w + '</span>').join(' ') : tx) + (n < body.length ? '<span class="cur"></span>' : ''); }
      const k = (lt > 500 ? 1 : 0) + (lt > t1 + 200 ? 1 : 0); if (k !== stK) { stK = k; st.innerHTML = (k > 0 ? st1 : '') + (k > 1 ? '<br>' + st2 : ''); }
      const q = sat((lt - t1 - 500) / 240); stamp.style.opacity = q > 0 ? 1 : 0; stamp.style.transform = 'rotate(-7deg) scale(' + lerp(3, 1, eox(q)) + ')';
      F.blur = Math.max(F.blur, 10 * vis); F.hudHide = Math.max(F.hudHide, vis);
    }, el);
  }

  // ---------- pickers (your own actions) ----------
  function mkPicker(pd) {
    const sel = Object.assign({}, pd.suggest || {});
    if (pd.kind === 'unseal') {
      const el = h('env', '<div class="card"><small>Your hand · sealed to you alone</small><div class="cs">' + pc(null) + pc(null) + '</div><em></em></div><div class="flap"><div class="paper"></div><div class="wx"><i class="a"></i><i class="b"></i></div></div><div class="cap">Dealt inside the enclave · only you can open this<br><b class="hint">Tap the seal to break it</b></div>');
      el.style.pointerEvents = 'auto'; el.style.cursor = 'pointer'; el.onclick = () => submit({ unseal: true });
      return { el, sel };
    }
    const el = h('pick', '');
    const rows = {};
    function row(key, label, items) {
      const r = document.createElement('div'); r.className = 'row'; r.innerHTML = '<span class="lab">' + label + '</span>';
      items.forEach((it) => { const b = document.createElement('button'); b.className = 'chip ' + (it.cls || ''); b.innerHTML = it.label; b._k = key; b._v = it.v; b.onclick = () => { if (it.set) it.set(); else sel[key] = it.v; sync(); }; r.appendChild(b); });
      el.appendChild(r); rows[key] = r; return r;
    }
    const head = (a, b, c) => { el.innerHTML = '<h4>' + a + '<small>' + b + '</small></h4><p>' + c + '</p>'; };
    let goLabel = () => 'GO', range = null, outp = null;
    if (pd.kind === 'fill') {
      head('The lobby · ' + pd.joined + ' / ' + pd.max + ' players', 'stake ' + (pd.stake || 'free play') + ' · NEAR testnet', 'You and one other human have staked. ' + (pd.max - pd.joined) + ' seats are empty. Agents play without a wallet and are counted out of the payout.');
      goLabel = () => 'FILL WITH VERIFIED AGENTS';
    }
    if (pd.kind === 'act') {
      const canRaise = pd.maxTo > pd.minTo && pd.stack > pd.toCall;
      head('Your action', (pd.toCall ? 'to call ' + pd.toCall : 'no bet to you') + ' · pot ' + pd.pot + ' · your stack ' + pd.stack, 'Your cards are sealed to you alone. The table only sees what you do.');
      const items = [{ v: 'fold', label: 'Fold', cls: 'red' }, pd.toCall ? { v: 'call', label: (pd.toCall >= pd.stack ? 'Call all-in ' : 'Call ') + Math.min(pd.toCall, pd.stack) } : { v: 'check', label: 'Check' }];
      if (canRaise) items.push({ v: 'raise', label: pd.toCall ? 'Raise' : 'Bet' }, { v: 'allin', label: 'All-in ' + pd.maxTo, cls: 'red' });
      row('kind', 'action', items);
      if (canRaise) {
        if (!(sel.to >= pd.minTo && sel.to <= pd.maxTo) || sel.kind !== 'raise') sel.to = sel.kind === 'raise' && sel.to ? sel.to : pd.minTo;
        const clamp = (v) => Math.max(pd.minTo, Math.min(pd.maxTo, Math.round(v)));
        const r = row('amt', 'raise to', [{ label: 'Min', set: () => { sel.to = pd.minTo; } }, { label: '½ pot', set: () => { sel.to = clamp(pd.bet + pd.toCall + (pd.pot + pd.toCall) / 2); } }, { label: 'Pot', set: () => { sel.to = clamp(pd.bet + pd.toCall + pd.pot + pd.toCall); } }]);
        const w = document.createElement('div'); w.className = 'amt'; outp = document.createElement('output'); range = document.createElement('input'); range.type = 'range'; range.min = pd.minTo; range.max = pd.maxTo; range.step = 1; range.value = sel.to;
        range.oninput = () => { sel.to = +range.value; sync(); }; w.appendChild(outp); w.appendChild(range); r.insertBefore(w, r.children[1]);
      }
      goLabel = () => ({ fold: 'FOLD', check: 'CHECK', call: 'CALL ' + Math.min(pd.toCall, pd.stack), raise: 'RAISE TO ' + sel.to, allin: 'ALL-IN ' + pd.maxTo }[sel.kind] || 'CHOOSE');
    }
    const fr = document.createElement('div'); fr.className = 'row'; const go = document.createElement('button'); go.className = 'go'; fr.appendChild(go); el.appendChild(fr);
    function sync() {
      el.querySelectorAll('.chip').forEach((b) => { if (b._v !== undefined) b.classList.toggle('on', sel[b._k] === b._v); });
      if (rows.amt) rows.amt.style.display = sel.kind === 'raise' ? '' : 'none';
      if (range) { range.value = sel.to; outp.textContent = sel.to; }
      go.textContent = goLabel(); go.disabled = pd.kind === 'act' && !sel.kind;
    }
    sync();
    go.onclick = () => { if (go.disabled) return; const c = Object.assign({}, sel); if (c.kind !== 'raise') delete c.to; submit(c); };
    return { el, sel, go };
  }
  function submit(choice) { if (openPick && !openPick.closed && !DIRECTOR) adapter.act(choice); }

  function openPicker(pd) {
    const pk = mkPicker(pd), c = { pd, pk, s: T, gate: T + (pd.kind === 'unseal' ? 1500 : 650), closeT: Infinity, closed: false };
    if (pd.kind === 'unseal') {
      lastEnv = pk.el; const wa = pk.el.querySelector('.a'), wb = pk.el.querySelector('.b'), paper = pk.el.querySelector('.flap'), card = pk.el.querySelector('.card'), hint = pk.el.querySelector('.hint'), cap = pk.el.querySelector('.cap');
      c.clip = add(T, Infinity, (p, t, lt) => {
        const a = eo(lt / 1300), k = t - c.closeT, out = c.closed ? sat((c.clip.e - t) / 500) : 1;
        pk.el.style.opacity = sat(lt / 500) * out;
        pk.el.style.transform = 'translate(-50%,-50%) translateY(' + (1 - a) * 40 + 'vh) scale(' + lerp(.25, 1, a) + ') rotate(' + (1 - a) * -14 + 'deg)';
        const b = sat(k / 500), o = eo((k - 350) / 900);
        wa.style.transform = 'translate(' + -b * 60 + '%,' + b * 30 + '%) rotate(' + -b * 35 + 'deg)'; wb.style.transform = 'translate(' + b * 70 + '%,' + b * 20 + '%) rotate(' + b * 40 + 'deg)';
        wa.style.opacity = wb.style.opacity = 1 - sat((k - 300) / 300);
        paper.style.opacity = 1 - o; paper.style.transform = 'translateY(' + o * 30 + '%)'; card.style.transform = 'scale(' + lerp(.9, 1.06, o) + ')';
        hint.style.opacity = c.closed ? 0 : .4 + .6 * Math.abs(Math.sin(lt / 500)); cap.style.opacity = 1 - sat(k / 300);
        if (k > 0 && k < 600) F.shake += Math.exp(-k / 140) * .08;
        F.blur = Math.max(F.blur, 9 * sat(lt / 800) * out); F.dim = Math.max(F.dim, .5 * sat(lt / 800) * out);
      }, pk.el);
    } else {
      c.clip = add(T, Infinity, (p, t, lt) => {
        const a = eo(lt / 500), out = c.closed ? sat((c.clip.e - t) / 350) : 1;
        pk.el.style.opacity = a * out; pk.el.style.transform = 'translateX(-50%) translateY(' + ((1 - a) * 50 + (1 - out) * 30) + 'px)';
        if (pk.go) pk.go.classList.toggle('press', c.closed && t > c.closeT - 260);
        if (pd.kind === 'act') { F.act = ME; F.mine = Math.max(F.mine, a * out); }
      }, pk.el);
    }
    openPick = c; T = c.gate; if (!DIRECTOR) holdAt = c.gate; return c;
  }
  function closePicker(c, dwell) {
    c.closed = true; c.closeT = c.gate + dwell; holdAt = null; openPick = null;
    if (c.pd.kind === 'unseal') { c.clip.e = c.closeT + 4300; T = c.closeT + 3900; ramp('vault', c.closeT + 600, 1500, 0); ramp('night', c.closeT + 1200, 1800, 0); camTo(c.closeT + 1500, 2400, POSE.table(PI / 2 + .12)); }
    else { c.clip.e = c.closeT + 380; T = c.closeT + 200; }
  }

  // ---------- event → clips ----------
  const pips = (n, max) => '<span class="red">' + '◆ '.repeat(n) + '</span><span style="opacity:.35">' + '◇ '.repeat(max - n) + '</span>';
  const G = {
    lobby(ev) {
      if (DIRECTOR) {
        scene('title', '');
        ramp('house', 4300, 2400, 1); camTo(0, 0, POSE.high());
        kinetic(500, 4600, [{ t: 'A MAKEO GAME · ON NEAR', c: 'mono' }, { t: 'NEAR <span class="red">HOLD’EM</span>', c: 'xl' }, { t: 'The dealer is an enclave. The AI players are verified.<br>Nobody has to trust the house.', c: 'serif' }], { slow: true, stagger: 500, blur: 0, dim: 0 });
        T = 5200;
      } else { ramp('house', 0, 1800, 1); camTo(0, 0, POSE.high()); }
      scene('lobby', 'THE LOBBY');
      camTo(T - 600, 5200, POSE.wide(PI / 2 - .12));
      kinetic(T + 700, 3900, [{ t: pips(ev.joined, ev.max) + '&nbsp; STAKE ' + (ev.stake || 'FREE PLAY') + ' · NEAR TESTNET', c: 'mono' }, { t: ev.joined + ' / ' + ev.max + ' PLAYERS', c: '' }, { t: ev.line || 'Humans and verified AI agents, one table. Every seat looks the same.', c: 'serif' }], { cls: 'high', blur: 0, dim: .1 });
      T += 2700;
    },
    fill(ev) {
      scene('fill', 'VERIFIED AGENTS');
      camTo(T, 4200, POSE.wide(PI / 2 + .14));
      SEATS.forEach((s, i) => { joinT[i] = T + 500 + ((i * 5 + 2) % N) * 380; });   // the keeper shuffles the seats: all six sit down together
      kinetic(T + 300, 4300, [{ t: pips(N, N) + '&nbsp; FILLED WITH VERIFIED AGENTS', c: 'mono' }, { t: N + ' / ' + N + ' PLAYERS', c: '' }, { t: 'The keeper shuffles the seats. Human or AI, every seat looks the same.', c: 'serif' }], { cls: 'high', blur: 0, dim: .1, slam: .05 });
      const el = h('cap2', 'Every agent decision · NEAR AI Cloud · <b>' + (ev.model || 'TEE model') + '</b><br>signed inside a TEE · Intel TDX + NVIDIA <b class="ok">✓</b>');
      add(T + 1500, T + 4600, (p, t, lt) => { el.style.opacity = sat(lt / 400) * sat((3100 - lt) / 400); }, el);
      T += 4800;
    },
    hand(ev) {
      if (handsSeen++ > 0) { scene('hand-' + (ev.n || handsSeen), 'HAND ' + (ev.n || handsSeen)); kinetic(T + 100, 1500, [{ t: 'HAND ' + (ev.n || handsSeen), c: 'mono' }, { t: 'BLINDS ' + ev.blinds[0] + ' / ' + ev.blinds[1], c: 'sm' }], { cls: 'high', blur: 0, dim: .08 }); T += 1700; newHand(T); }
      btnSeat = idx[ev.button]; btnT = T; POS[idx[ev.button]] = 'D'; POS[idx[ev.sb]] = 'SB'; POS[idx[ev.bb]] = 'BB';
      for (const id in ev.stacks) stackK[idx[id]].push({ t: T - 1, v: ev.stacks[id] });
    },
    deal(ev) {
      scene('deal', 'THE DEAL');
      ramp('night', T, 1500, .7); ramp('vault', T + 200, 1600, 1); ramp('selfhide', T, 1200, 1); camTo(T, 2600, POSE.center());
      kinetic(T + 500, 2700, [{ t: 'THE KEEPER', c: 'mono' }, { t: (ORDW[(ev.seats ? ev.seats.length : N) * 2] || ((ev.seats ? ev.seats.length : N) * 2)) + ' CARDS', c: 'sm' }, { t: 'DEALT SEALED', c: 'sm red' }], { cls: 'high', blur: 0, dim: .1, slam: true });
      { let k = 0; for (let j = 0; j < N; j++) { const i = (btnSeat + 1 + j) % N; if (ev.seats && !ev.seats.includes(SEATS[i].id)) continue; holes[i].d0 = T + 2300 + (k++) * 330; } } // LIVE: only seats in this hand
      const el = h('cap2', 'Makeo keeper · AWS Nitro enclave · attested <b class="ok">✓</b><br>' + (ev.pcr0 ? 'PCR0 <b>' + sh(ev.pcr0, 14) + '</b> &nbsp;·&nbsp; ' : '') + (ev.cardCount ? ev.cardCount + ' card commitments, first <b>' : 'deck commitment <b>') + sh(ev.deck_commitment, 14) + '</b>');
      add(T + 2400, T + 7400, (p, t, lt) => { el.style.opacity = sat(lt / 400) * sat((5000 - lt) / 400); }, el);
      camTo(T + 3000, 3300, Object.assign(POSE.wide(PI / 2 + .1), { el: .78, d: 15 }));
      T += 6100;
    },
    hole(ev) {
      myHole = ev.cards; holes[ME].cards = ev.cards; holes[ME].flipT = T - 1100; handT = T - 700;
      if (lastEnv) { lastEnv.querySelector('.cs').innerHTML = ev.cards.map((c) => pc(c)).join(''); lastEnv.querySelector('em').textContent = 'No other seat, human or AI, can see these.'; }
    },
    action(ev) {
      const i = idx[ev.seat], me = i === ME, NAME = short(ev.seat);
      if (curStreet !== ev.street) { curStreet = ev.street; if (ev.street === 'preflop') { scene('preflop', 'PREFLOP'); camTo(T, 1400, POSE.table(PI / 2 + .12)); } }
      const big = !me && (ev.feature || ev.kind === 'allin' || ev.kind === 'raise' || ev.kind === 'bet');
      const think = ev.kind === 'post' ? 150 : me ? 200 : big ? 1300 : 850, s = T, tA = s + think;
      if (big) camTo(s - 200, 1000, POSE.seat(i));
      stackK[i].push({ t: tA, v: ev.stack }); potK.push({ t: tA, v: ev.pot });
      if (ev.kind === 'fold') foldT[i] = tA; else if (ev.amount) betK[i].push({ t: tA, v: ev.to });
      if (ev.amount) addChips(i, tA, ev.amount);
      tagK[i].push({ s: tA, e: Infinity, text: tagText(ev), cls: ev.kind === 'fold' ? 'off' : /allin|raise|bet/.test(ev.kind) ? 'red' : '', rc: ev.receipt || null, keep: ev.kind === 'fold' });
      let e;
      if (ev.kind === 'post') e = tA + 450;
      else if (me) {
        const v = { fold: 'FOLD', check: 'CHECK', call: 'CALL ' + ev.to, bet: 'BET ' + ev.to, raise: 'RAISE TO ' + ev.to, allin: 'ARE ALL-IN' }[ev.kind];
        const last = ev.kind === 'call' && ev.stack === 0;
        kinetic(tA + 80, last ? 1900 : 1250, last ? [{ t: 'YOU CALL', c: 'xl' }, { t: 'ALL OF IT', c: 'sm red' }] : [{ t: 'YOU ' + v, c: 'sm' }], last ? { slam: true, blur: 2 } : { cls: 'low', blur: 0, dim: .08, slam: .05 });
        e = tA + (last ? 2000 : 1400);
      } else if (big) {
        const lines = ev.kind === 'allin' ? [{ t: NAME + ' SHOVES', c: 'sm' }, { t: 'ALL-IN', c: 'xl red' }] : [{ t: NAME + (ev.kind === 'bet' ? ' BETS' : ' RAISES'), c: 'sm' }, { t: (ev.kind === 'bet' ? '' : 'TO ') + ev.to, c: 'xl' }];
        const kd = ev.kind === 'allin' ? 2300 : 1500;
        kinetic(tA + 120, kd, lines, { slam: ev.kind === 'allin' ? .16 : true, blur: 2 });
        const tip = DIRECTOR && ev.kind === 'allin' && !!ev.receipt, ld = tip ? 6400 : ev.receipt ? 3800 : 2600;
        lower(tA + kd - 100, ld, ev, tip); e = tA + kd - 100 + ld;
        camTo(e - 300, 1100, POSE.table(PI / 2 + (i % 2 ? .1 : -.1)));
      } else e = tA + 750;
      add(s, e, (p, t, lt) => {
        const vis = sat(lt / 250) * sat((e - t) / 250);
        if (!me) { for (let k = 0; k < N; k++) F.lit[k] = lerp(F.lit[k], k === i ? 1.2 : F.lit[k] * .5, vis); F.spot = i; F.spotI = Math.max(F.spotI, vis * .8); }
        F.act = i; F.actP = sat(lt / think);
        if (ev.amount && t > tA + 380) F.shake += Math.exp(-(t - tA - 380) / 130) * (ev.kind === 'allin' ? .07 : .02);
      });
      T = e;
    },
    street(ev) {
      const nm = ev.name.toUpperCase(); scene(ev.name, 'THE ' + nm); curStreet = ev.name;
      collect(T + 150); tagK.forEach((k) => k.forEach((g) => { if (g.e === Infinity && !g.keep) g.e = T + 150; })); betK.forEach((k) => k.push({ t: T + 150, v: 0 }));
      ramp('hover', T, 1, 1); ramp('night', T, 1200, .5); ramp('vault', T, 1300, 1); camTo(T + 200, 1500, POSE.board());
      kinetic(T + 300, 1500, [{ t: 'THE KEEPER REVEALS', c: 'mono' }, { t: 'THE ' + nm, c: '' }], { cls: 'high', blur: 0, dim: .1, slam: true });
      const n = ev.cards.length, f0 = T + 1500 + n * 260 + 800;
      ev.cards.forEach((c, k) => board.push({ card: c, t0: T + 1500 + k * 260, flipT: f0 + k * 190 }));
      const fe = f0 + (n - 1) * 190 + 720;
      const cm = (ev.commitments || []).map((c) => '<b>' + sh(c, 8) + '</b>').join(' &nbsp; ');
      const el = h('cap2', (n > 1 ? n + ' revealed cards match' : 'Revealed card matches') + ' the keeper’s commitment <b class="ok">✓</b><br>sha256(card ‖ salt) = ' + cm);
      add(fe - 300, fe + 2500, (p, t, lt) => { el.style.opacity = sat(lt / 300) * sat((2800 - lt) / 300); }, el);
      T = fe + 2300; ramp('vault', T - 900, 1200, 0); ramp('night', T - 900, 1200, 0); camTo(T - 700, 1300, POSE.table(PI / 2 - .1));
    },
    made(ev) {
      kinetic(T, 2900, [{ t: 'ONLY YOU CAN SEE THIS', c: 'mono' }, { t: ev.hand, c: '' }, { t: ev.line, c: 'serif' }], { cls: 'low', blur: 3.5, dim: .5, slam: .06 });
      add(T, T + 2900, (p) => { F.mine = Math.max(F.mine, sat(p * 8) * sat((1 - p) * 8)); });
      T += 3000;
    },
    sealed(ev) { scene('sealed-reasoning', 'SEALED REASONING'); confessional(T, 5400, ev.seat, ev.street, ev.at, null); T += 5400; scene(ev.street + '-decision', 'THE ' + ev.street.toUpperCase()); },
    acted(ev) {
      if (openPick) { closePicker(openPick, 0); return; }
      closePicker(openPicker(ev.pending), { fill: 1500, unseal: 1500, act: 1700 }[ev.kind]);
    },
    showdown(ev) {
      lastShow = ev; scene('showdown', 'SHOWDOWN');
      collect(T + 150); tagK.forEach((k) => k.forEach((g) => { if (g.e === Infinity && !g.keep) g.e = T + 150; })); betK.forEach((k) => k.push({ t: T + 150, v: 0 }));
      camTo(T, 1400, POSE.table(PI / 2));
      kinetic(T + 200, 1700, [{ t: 'NO MORE BETS', c: 'mono' }, { t: 'SHOWDOWN', c: 'xl' }], { slam: true, blur: 2 }); T += 1800;
      const W = ev.winners, folded = (ev.inHand || SEATS.map((s) => s.id)).filter((id) => !ev.hands[id]).length;
      for (const id in ev.hands) {
        if (idx[id] === ME) continue; const i = idx[id];
        holes[i].cards = ev.hands[id]; holes[i].flipT = T + 900; camTo(T - 200, 1000, POSE.seat(i));
        kinetic(T + 1200, 2300, [{ t: short(id) + ' SHOWS', c: 'sm' }, { t: ev.hands[id].map(ctext).join(' &nbsp;'), c: '' }, { t: ev.rank[id] + '.', c: 'serif' }], { cls: 'low left', blur: 0, dim: .12, slam: .06 });
        add(T, T + 3600, (p) => { const v = sat(p * 8) * sat((1 - p) * 8); F.lit[i] = Math.max(F.lit[i], 1.15 * v); F.spot = i; F.spotI = Math.max(F.spotI, v * .7); });
        T += 3600;
      }
      camTo(T - 300, 1300, POSE.board());
      const order = Object.keys(ev.hands).sort((a, b) => (W.includes(a) ? 1 : 0) - (W.includes(b) ? 1 : 0)), best = (ev.best && ev.best[W[0]]) || [];
      const el = h('show', '<h2>Showdown · ' + (Object.keys(ev.hands).length === 2 ? 'both hands' : Object.keys(ev.hands).length + ' hands') + ' opened by the keeper</h2><div class="hands">' + order.map((id) => {
        const w = W.includes(id);
        return '<div class="hd ' + (w ? 'win' : 'lose') + '"><small>' + short(id) + '</small><div class="cs">' + ev.hands[id].map((c) => pc(c, w && best.includes(c) ? 'hi' : '')).join('') + '</div><b>' + ev.rank[id] + '</b></div>';
      }).join('') + '</div><div class="bd">' + board.map((b) => pc(b.card, best.includes(b.card) ? 'hi' : 'lo')).join('') + '</div>' +
        '<div class="foot">Shown hands match the keeper’s commitments <b class="ok">✓</b><br><b>' + (folded ? folded + ' folded hand' + (folded > 1 ? 's stay' : ' stays') + ' face down. Forever.' : 'Nobody folded.') + '</b></div>');
      const hds = Array.from(el.querySelectorAll('.hd')), bd = el.querySelector('.bd'), foot = el.querySelector('.foot'), D = 6800;
      add(T, T + D, (p, t, lt) => {
        const vis = sat(lt / 400) * sat((D - lt) / 400); el.style.opacity = vis;
        hds.forEach((d, k) => { const a = eo((lt - 300 - k * 1000) / 600); d.style.opacity = a; d.style.transform = 'translateY(' + (1 - a) * 30 + 'px)'; const b = d.lastElementChild, q = sat((lt - 900 - k * 1000) / 300); b.style.opacity = q; b.style.transform = 'scale(' + lerp(1.8, 1, eox(q)) + ')'; });
        const tw = 900 + (hds.length - 1) * 1000; if (lt > tw) F.shake += Math.exp(-(lt - tw) / 150) * .09;
        bd.style.opacity = sat((lt - 200) / 500); foot.style.opacity = sat((lt - tw - 900) / 400);
        F.blur = Math.max(F.blur, 10 * vis); F.dim = Math.max(F.dim, .68 * vis); F.hudHide = Math.max(F.hudHide, vis);
      }, el);
      T += D;
      scene('result', 'THE POT');
      const w = W[0], wi = idx[w], pot = ev.pots.reduce((a, x) => a + x.amount, 0), lose = order.filter((id) => !W.includes(id))[0];
      camTo(T - 200, 1600, POSE.table(PI / 2 + .08)); award(T + 900, wi);
      kinetic(T + 300, 3700, [{ t: 'THE POT', c: 'mono' }, { t: wi === ME ? 'YOU WIN' : short(w) + ' WINS', c: '' }, { t: String(pot), c: 'xl red' }, { t: ev.rank[w] + '.' + (lose ? ' ' + SEATS[idx[lose]].name + ' held ' + ev.rank[lose].toLowerCase() + '.' : ''), c: 'serif' }], { slam: true, stagger: 260, blur: 1.5, dim: .2 });
      potK.push({ t: T + 1300, v: 0 }); stackK[wi].push({ t: T + 2000, v: stepAt(stackK[wi], T) + pot });
      T += 4200;
    },
    won(ev) { // LIVE: everyone else folded
      collect(T + 150); tagK.forEach((k) => k.forEach((g) => { if (g.e === Infinity && !g.keep) g.e = T + 150; })); betK.forEach((k) => k.push({ t: T + 150, v: 0 }));
      if (ev.seat && idx[ev.seat] != null) {
        const wi = idx[ev.seat];
        kinetic(T + 300, 1800, [{ t: 'UNCONTESTED', c: 'mono' }, { t: (wi === ME ? 'YOU TAKE' : short(ev.seat) + ' TAKES') + ' ' + ev.pot, c: 'sm' }], { cls: 'low', blur: 0, dim: .08 });
        award(T + 700, wi); potK.push({ t: T + 1100, v: 0 }); stackK[wi].push({ t: T + 1700, v: stepAt(stackK[wi], T) + ev.pot });
      }
      T += 2200;
    },
    end(ev) {
      const nr = ev.near, sd = lastShow || { hands: {}, winners: [], rank: {} };
      if (nr) {
        scene('near', 'ON NEAR');
        camTo(T, 4200, Object.assign(POSE.wide(PI / 2 + .5), { el: .82, d: 19 }));
        kinetic(T + 200, 4300, [{ t: 'NEAR ' + nr.network.toUpperCase() + ' · ' + nr.contract.toUpperCase(), c: 'mono' }, { t: nr.payout.amount, c: 'xl' }, { t: 'PAID TO ' + short(nr.payout.seat), c: 'sm red' }, { t: nr.entries.length + ' humans staked. ' + nr.out.length + ' AI agents played without a wallet and are counted out of the payout.', c: 'serif' }], { slam: true, stagger: 260 });
        const el = h('cap2', 'Settled on the keeper’s signature <b class="ok">✓</b> &nbsp;·&nbsp; settle tx <b>' + sh(nr.settle_tx, 10) + '</b>');
        add(T + 1600, T + 4500, (p, t, lt) => { el.style.opacity = sat(lt / 400) * sat((2900 - lt) / 400); }, el);
        T += 4700;
      }
      scene('reveal', 'WHO WAS REAL');
      const el = h('reveal', '<h2><small>Now you may know</small>WHO WAS <span class="red">REAL?</span></h2><div class="grid">' + SEATS.map((s) => {
        const ai = ev.kinds[s.id] === 'AI', hd = sd.hands[s.id], won = sd.winners.includes(s.id);
        const fate = hd ? (won ? 'WON · ' : 'SHOWED · ') + hd.map(ctext).join(' ') : 'FOLDED · NEVER SHOWN';
        return '<div class="rv ' + (ai ? 'ai' : '') + '"><div class="f" style="background-image:url(\'' + P[s.id].url + '\')"><span>' + short(s.id) + '</span></div><div class="b"><div class="pp" style="background-image:url(\'' + P[s.id].url + '\')"></div>' + (ai ? '<u>NEAR AI · TEE <span class="ok">✓</span></u>' : '') + '<b>' + ev.kinds[s.id] + '</b><em class="' + (won ? 'w' : '') + '">' + fate + '</em><span>' + short(s.id) + '</span></div></div>';
      }).join('') + '</div><div class="foot"></div>');
      const rv = Array.from(el.querySelectorAll('.rv')), foot = el.querySelector('.foot'), nAI = SEATS.filter((s) => ev.kinds[s.id] === 'AI').length, rd = 1700 + N * 620 + 2900;
      foot.innerHTML = nAI + ' of ' + N + ' were AI · every one of their decisions was signed inside a TEE <span class="ok">✓</span>';
      add(T, T + rd, (p, t, lt) => {
        const vis = sat(lt / 500) * sat((rd - lt) / 450); el.style.opacity = vis;
        rv.forEach((d, i) => { const q = eio((lt - 1500 - i * 620) / 720), a = eo((lt - i * 70) / 600); d.style.opacity = a; d.style.transform = 'translateY(' + (1 - a) * 40 + 'px) rotateY(' + q * 180 + 'deg) scale(' + (1 + Math.sin(q * PI) * .12) + ')'; });
        foot.style.opacity = sat((lt - 1500 - N * 620) / 400);
        F.blur = Math.max(F.blur, 12 * vis); F.dim = Math.max(F.dim, .72 * vis); F.hudHide = Math.max(F.hudHide, vis);
      }, el);
      T += rd;

      const f = ev.feature, rc = f && ev.receipts.find((x) => x.seat === f.seat && x.round === f.street && x.reasoning);
      if (rc) { scene('reasoning-unsealed', 'REASONING · UNSEALED'); confessional(T, 11500, f.seat, f.street, f.at, rc.reasoning, rc); T += 11500; }

      scene('receipt', 'THE RECEIPT');
      const rel = h('rcpt' + (DIRECTOR ? '' : ' live'), '<div class="roll"><div class="paper">' + receiptHTML(ev, sd) + '</div></div>');
      const roll = rel.querySelector('.roll'), paper = rel.querySelector('.paper'), D = 16000;
      add(T, DIRECTOR ? T + D : Infinity, (p, t, lt) => {
        const u = eio(lt / 1900); rel.style.opacity = sat(lt / 300) * (DIRECTOR ? sat((D - lt) / 500) : 1);
        roll.style.clipPath = 'inset(0 0 ' + ((1 - u) * 100).toFixed(2) + '% 0)';
        if (DIRECTOR) { const max = Math.max(0, paper.offsetHeight - roll.clientHeight + 40); paper.style.transform = 'translateY(' + (-max * ss((lt - 2600) / (D - 4200))).toFixed(1) + 'px)'; }
        F.blur = Math.max(F.blur, 12); F.dim = Math.max(F.dim, .6); F.hudHide = 1;
      }, rel);
      if (DIRECTOR) T += D; else { T += 2500; FINAL = true; }
    },
  };

  function receiptHTML(ev, sd) {
    const V = '../../../verify/', nr = ev.near, ex = 'https://testnet.nearblocks.io/txns/';
    const ln = (file) => '<a href="' + V + file + '" target="_blank" rel="noopener">verify/' + file + '</a>';
    const tx = (id) => '<a href="' + ex + id + '" target="_blank" rel="noopener">' + sh(id, 14) + '</a>';
    const ok = '<span class="chk">✓</span>', cd = (c) => '<span class="cd ' + (RED[c[1]] ? 'r' : '') + '">' + ctext(c) + '</span>';
    const w = sd.winners[0], pot = (sd.pots || []).reduce((a, x) => a + x.amount, 0), nm = (id) => SEATS[idx[id]].name;
    let s = '<div class="stampR">Verified ✓</div><h1>The <i>Receipt</i></h1><div class="sub">Nothing on this page asks for your trust. Every line can be checked.</div>' +
      '<div class="kv"><span>game</span><span>' + (nr ? nr.game : 'hold’em') + '</span><span>result</span><span>' + (w ? nm(w) + ' wins ' + pot + ' chips · ' + sd.rank[w].toLowerCase() : '—') + '</span><span>rules</span><span>No-limit Texas Hold’em · ' + N + ' seats · humans and verified AI agents</span></div>';
    s += '<h2>1 · Every card matches the keeper’s commitment ' + ln('keeper.ts') + '</h2><div class="kv"><span>deck commitment</span><span>' + ev.deck_commitment + '</span>' + (ev.seed ? '<span>seed (published)</span><span>' + ev.seed + '</span>' : '') + '<span>check</span><span>sha256(card ‖ salt) = commitment, for every opened card ' + (ev.checked ? ev.checked + ' ' : '') + ok + (ev.pcr0 ? ' &nbsp; enclave attestation (AWS Nitro, PCR0) ' + ok : '') + '</span></div>' +
      '<table><tr><th>card</th><th>committed at the deal</th><th>revealed</th><th>how</th><th></th></tr>' + ev.cards.map((c) => '<tr><td>' + c.label + '</td><td>' + sh(c.commitment, 12) + '</td><td>' + (c.card ? cd(c.card) : '<span class="never">sealed</span>') + '</td><td' + (c.card ? '' : ' class="never"') + '>' + c.status + '</td><td>' + (c.card ? ok : '') + '</td></tr>').join('') + '</table>';
    s += '<h2>2 · Every AI decision, signed in a TEE ' + ln('nearai.ts') + '</h2><div class="kv"><span>model</span><span>' + ev.model + (ev.model_id ? ' · ' + ev.model_id : '') + ' · NEAR AI Cloud</span><span>signer</span><span>' + (ev.receipts[0] ? ev.receipts[0].signing_address : '—') + '</span><span>attestation</span><span>Intel TDX quote + NVIDIA confidential GPU ' + ok + '</span></div>' +
      '<table><tr><th>street</th><th>seat</th><th>decision</th><th>request sha256</th><th>response sha256</th><th>signature</th><th></th></tr>' + ev.receipts.map((r) => '<tr title="chat ' + r.chat_id + ' · signer ' + r.signing_address + '"><td>' + r.round + '</td><td>' + nm(r.seat) + '</td><td>' + moveText(r.move) + '</td><td>' + sh(r.request_sha256, 8) + '</td><td>' + sh(r.response_sha256, 8) + '</td><td>' + sh(r.signature, 10) + '</td><td>' + (r.verified ? ok : '') + '</td></tr>').join('') + '</table>';
    s += '<h2>3 · Private reasoning, unsealed ' + ln('nearai.ts') + '</h2>';
    ev.receipts.forEach((r) => { if (r.reasoning) s += '<div class="cf"><small>' + nm(r.seat) + ' · ' + r.round + ' · ' + moveText(r.move) + ' · sealed in the TEE, signature verified ' + ok + '</small><q>' + r.reasoning + '</q></div>'; });
    if (nr) {
      s += '<h2>4 · The pot on NEAR ' + nr.network + ' ' + ln('near.ts') + '</h2><div class="kv"><span>contract</span><span>' + nr.contract + '</span><span>stake</span><span>' + nr.stake + ' per human seat · pot ' + nr.pot + '</span></div>' +
        '<table><tr><th>step</th><th>who</th><th>amount</th><th>transaction</th><th></th></tr>' +
        '<tr><td>open_game</td><td>operator</td><td>—</td><td>' + tx(nr.open_tx) + '</td><td>' + ok + '</td></tr>' +
        nr.entries.map((e) => '<tr><td>enter</td><td>' + nm(e.seat) + ' · ' + sh(e.account, 8) + '</td><td>' + e.stake + '</td><td>' + tx(e.tx) + '</td><td>' + ok + '</td></tr>').join('') +
        '<tr><td class="never">no entry</td><td colspan="3" class="never">' + nr.out.map(nm).join(', ') + ' · AI agents, no wallet, counted out of the payout</td><td></td></tr>' +
        '<tr><td>settle</td><td>keeper-signed result</td><td>—</td><td>' + tx(nr.settle_tx) + '</td><td>' + ok + '</td></tr>' +
        '<tr><td>payout</td><td>' + nm(nr.payout.seat) + ' · ' + sh(nr.payout.account, 8) + '</td><td class="w">' + nr.payout.amount + '</td><td>' + tx(nr.settle_tx) + '</td><td>' + ok + '</td></tr></table>' +
        '<div class="kv" style="margin-top:.8em"><span>keeper signature</span><span>' + sh(nr.keeper_sig, 40) + ' ' + ok + '</span></div>';
    }
    if (ev.mock !== false) s += '<div class="mock">Scripted demo table: hashes, signatures, accounts and transaction ids on this page are stand-ins until the live game stream is connected.</div>';
    return s;
  }

  // ---------- compile ----------
  let consumed = 0;
  function consume(view) {
    if (!consumed && view.me && idx[view.me.seat] != null) ME = idx[view.me.seat];
    for (; consumed < view.log.length; consumed++) {
      const ev = view.log[consumed]; if (ev.omni && !OMNI) continue;
      if (G[ev.t]) G[ev.t](ev);
    }
    if (scenes.length) scenes[scenes.length - 1].end = T;
    if (view.pending && !openPick) openPicker(view.pending);
  }

  // ---------- 3D ----------
  let R, SC, CAM, tableM, lights = [], fill, hemi, spot, flames = [], glows = [], vault, vaultEdges, vaultSlots = [], smoke = [], portraits = [], TEX = {}, btnM;
  const holeM = [], waxM = [], boardM = [], chipM = [], faceCache = {}, plates = [], betLs = [];
  const canvas = (w, hh) => { const c = document.createElement('canvas'); c.width = w; c.height = hh; return c; };
  function tex(c) { const t = new THREE.CanvasTexture(c); t.anisotropy = 8; return t; }
  function cover(g, img, w, hh) { const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height, s = Math.max(w / iw, hh / ih); g.drawImage(img, (w - iw * s) / 2, (hh - ih * s) * .25, iw * s, ih * s); }
  const CANDLES = [[-4.25, -.7, .8], [-4.0, -.28, .5], [4.25, -.7, .6], [4.0, -.28, .92]];

  function makeTextures() {
    let c, g, rnd, gr;
    // table: a wooden rail around black felt
    c = canvas(1024, 1024); g = c.getContext('2d'); rnd = prng(7); g.fillStyle = '#2a1a10'; g.fillRect(0, 0, 1024, 1024);
    for (let i = 0; i < 16; i++) { g.fillStyle = 'rgba(' + (30 + rnd() * 40 | 0) + ',' + (16 + rnd() * 20 | 0) + ',8,' + (.25 + rnd() * .3) + ')'; g.fillRect(0, i * 64, 1024, 62); }
    for (let i = 0; i < 700; i++) { const y = rnd() * 1024, x = rnd() * 1024, l = 60 + rnd() * 400; g.strokeStyle = 'rgba(' + (rnd() > .5 ? '0,0,0' : '120,80,40') + ',' + (rnd() * .12) + ')'; g.lineWidth = .5 + rnd() * 1.5; g.beginPath(); g.moveTo(x, y); g.bezierCurveTo(x + l * .3, y + rnd() * 6 - 3, x + l * .6, y + rnd() * 6 - 3, x + l, y); g.stroke(); }
    gr = g.createRadialGradient(512, 512, 40, 512, 512, 470); gr.addColorStop(0, '#1d0f0d'); gr.addColorStop(.55, '#140a09'); gr.addColorStop(1, '#090504'); g.fillStyle = gr; g.beginPath(); g.arc(512, 512, 462, 0, 7); g.fill();
    g.save(); g.beginPath(); g.arc(512, 512, 462, 0, 7); g.clip();
    for (let i = 0; i < 26000; i++) { g.fillStyle = 'rgba(' + (rnd() > .5 ? '255,220,190' : '0,0,0') + ',' + (rnd() * .05) + ')'; g.fillRect(rnd() * 1024, rnd() * 1024, 1.6, 1.6); }
    g.restore();
    g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = 7; g.beginPath(); g.arc(512, 512, 464, 0, 7); g.stroke();
    g.strokeStyle = 'rgba(179,24,15,.55)'; g.lineWidth = 3; g.beginPath(); g.arc(512, 512, 372, 0, 7); g.stroke();
    g.strokeStyle = 'rgba(233,226,208,.2)'; g.lineWidth = 2; g.beginPath(); g.arc(512, 512, 384, 0, 7); g.stroke();
    // board slots (texture v is flipped onto the table; the layout is symmetric so it does not matter)
    g.strokeStyle = 'rgba(233,226,208,.13)'; g.lineWidth = 1.5; for (let k = 0; k < 5; k++) g.strokeRect(512 - 73, 512 + (k - 2) * 116 - 52, 146, 104);
    TEX.wood = tex(c); TEX.wood.colorSpace = THREE.SRGBColorSpace;
    // flame / glow / smoke
    c = canvas(64, 128); g = c.getContext('2d'); gr = g.createRadialGradient(32, 84, 2, 32, 70, 60); gr.addColorStop(0, '#fff'); gr.addColorStop(.18, '#ffe2a0'); gr.addColorStop(.45, 'rgba(255,130,40,.55)'); gr.addColorStop(1, 'rgba(255,60,0,0)'); g.fillStyle = gr; g.save(); g.translate(32, 0); g.scale(.5, 1); g.translate(-32, 0); g.fillRect(-64, 0, 192, 128); g.restore(); TEX.flame = tex(c);
    c = canvas(256, 256); g = c.getContext('2d'); gr = g.createRadialGradient(128, 128, 0, 128, 128, 128); gr.addColorStop(0, 'rgba(255,170,90,.9)'); gr.addColorStop(.3, 'rgba(255,120,50,.28)'); gr.addColorStop(1, 'rgba(255,90,30,0)'); g.fillStyle = gr; g.fillRect(0, 0, 256, 256); TEX.glow = tex(c);
    c = canvas(256, 256); g = c.getContext('2d'); rnd = prng(31);
    for (let i = 0; i < 46; i++) { const x = 50 + rnd() * 156, y = 50 + rnd() * 156, r = 20 + rnd() * 50; gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(255,240,220,' + (.05 + rnd() * .07) + ')'); gr.addColorStop(1, 'rgba(255,240,220,0)'); g.fillStyle = gr; g.fillRect(0, 0, 256, 256); }
    TEX.smoke = tex(c);
    // card back
    c = canvas(256, 356); g = c.getContext('2d'); g.fillStyle = '#0d0b0a'; g.fillRect(0, 0, 256, 356); g.strokeStyle = '#e9e2d0'; g.lineWidth = 3; g.strokeRect(12, 12, 232, 332); g.lineWidth = 1; g.strokeRect(20, 20, 216, 316);
    g.beginPath(); g.moveTo(128, 100); g.lineTo(190, 178); g.lineTo(128, 256); g.lineTo(66, 178); g.closePath(); g.stroke(); g.fillStyle = '#b3180f'; g.beginPath(); g.arc(128, 178, 16, 0, 7); g.fill();
    g.fillStyle = '#e9e2d0'; g.font = '500 13px "IBM Plex Mono",monospace'; g.textAlign = 'center'; g.fillText('S E A L E D', 128, 310); TEX.back = tex(c); TEX.back.colorSpace = THREE.SRGBColorSpace;
    // chips: bone, blood, black
    TEX.chip = [['#d9cfb6', '#14100c'], ['#a3140c', '#e9e2d0'], ['#191513', '#e9e2d0']].map((cl) => {
      const cc = canvas(128, 128), q = cc.getContext('2d'); q.fillStyle = cl[0]; q.fillRect(0, 0, 128, 128);
      q.strokeStyle = cl[1]; q.lineWidth = 13; q.setLineDash([17, 30.1]); q.beginPath(); q.arc(64, 64, 54, 0, 2 * PI); q.stroke(); q.setLineDash([]);
      q.lineWidth = 2.5; q.globalAlpha = .7; q.beginPath(); q.arc(64, 64, 36, 0, 7); q.stroke(); q.globalAlpha = 1; q.fillStyle = cl[1]; q.beginPath(); q.moveTo(64, 46); q.lineTo(78, 64); q.lineTo(64, 82); q.lineTo(50, 64); q.closePath(); q.fill();
      const t = tex(cc); t.colorSpace = THREE.SRGBColorSpace; return { map: t, side: cl[0] };
    });
    // dealer button
    c = canvas(128, 128); g = c.getContext('2d'); g.fillStyle = '#e9e2d0'; g.fillRect(0, 0, 128, 128); g.strokeStyle = '#14100c'; g.lineWidth = 4; g.beginPath(); g.arc(64, 64, 52, 0, 7); g.stroke();
    g.fillStyle = '#14100c'; g.font = '74px Anton,Impact,sans-serif'; g.textAlign = 'center'; g.fillText('D', 64, 91); TEX.btn = tex(c); TEX.btn.colorSpace = THREE.SRGBColorSpace;
    // grain tile
    c = canvas(256, 256); g = c.getContext('2d'); rnd = prng(99); const id = g.createImageData(256, 256); for (let i = 0; i < id.data.length; i += 4) { const v = rnd() * 255 | 0; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; } g.putImageData(id, 0, 0); grainEl.style.backgroundImage = 'url(' + c.toDataURL() + ')';
  }
  function faceTex(card) {
    if (faceCache[card]) return faceCache[card];
    const c = canvas(256, 356), g = c.getContext('2d'), col = RED[card[1]] ? '#b3180f' : '#14100c';
    const gr = g.createLinearGradient(0, 0, 256, 356); gr.addColorStop(0, '#efe8d6'); gr.addColorStop(1, '#d3c9af'); g.fillStyle = gr; g.fillRect(0, 0, 256, 356);
    g.strokeStyle = 'rgba(20,16,12,.55)'; g.lineWidth = 3; g.strokeRect(8, 8, 240, 340);
    g.fillStyle = col; g.textAlign = 'center'; g.font = '176px Anton,Impact,sans-serif'; g.fillText(rk(card), 128, 178);
    g.font = '160px Georgia,"Times New Roman",serif'; g.fillText(SUIT[card[1]] + VS, 128, 322);
    const t = tex(c); t.colorSpace = THREE.SRGBColorSpace; return (faceCache[card] = t);
  }
  function portraitTex(seat) {
    const c = canvas(512, 716), g = c.getContext('2d');
    const draw = (img) => {
      cover(g, img, 512, 716);
      const gr = g.createLinearGradient(0, 470, 0, 716); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(.75, 'rgba(0,0,0,.88)'); g.fillStyle = gr; g.fillRect(0, 470, 512, 246);
      g.strokeStyle = 'rgba(233,226,208,.55)'; g.lineWidth = 4; g.strokeRect(8, 8, 496, 700);
      g.fillStyle = '#e9e2d0'; g.textAlign = 'center'; g.font = '74px Anton,Impact,sans-serif'; g.fillText(seat.name.toUpperCase(), 256, 650); g.font = 'italic 30px "Instrument Serif",Georgia,serif'; g.fillStyle = 'rgba(233,226,208,.75)'; g.fillText(seat.title, 256, 688);
    };
    draw(P[seat.id].img);
    try { g.getImageData(0, 0, 1, 1); } catch (e) { g.clearRect(0, 0, 512, 716); draw(P[seat.id].fallback); } // file:// taints real images for WebGL
    return tex(c);
  }
  const PVS = 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }';
  const PFS = 'precision highp float; uniform sampler2D map; uniform float lit,join; varying vec2 vUv;' +
    'void main(){ vec4 c=texture2D(map,vUv); vec3 col=c.rgb*(0.05+lit*1.15); col*=vec3(1.0,.93,.84); float g=dot(col,vec3(.3,.59,.11)); col=mix(vec3(g),col,clamp(lit*2.2,0.,1.)); col*=join; gl_FragColor=vec4(col,join); }';

  function build3D() {
    R = new THREE.WebGLRenderer({ canvas: glc, antialias: true, preserveDrawingBuffer: true }); R.setClearColor(0x000000, 1);
    R.toneMapping = THREE.ACESFilmicToneMapping; R.toneMappingExposure = 1.15;
    SC = new THREE.Scene(); SC.fog = new THREE.FogExp2(0x000000, .026); CAM = new THREE.PerspectiveCamera(36, 1, .1, 200);
    makeTextures();
    tableM = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.0, .35, 96), [new THREE.MeshStandardMaterial({ color: 0x1a0f09, roughness: .5 }), new THREE.MeshStandardMaterial({ map: TEX.wood, roughness: .9, metalness: 0 }), new THREE.MeshStandardMaterial({ color: 0x0a0605 })]); SC.add(tableM);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshStandardMaterial({ color: 0x0f0b09, roughness: .95 })); floor.rotation.x = -PI / 2; floor.position.y = -2.4; SC.add(floor);
    hemi = new THREE.HemisphereLight(0x3a2c22, 0x000000, .5); SC.add(hemi);
    [-1, 1].forEach((sgn) => { const l = new THREE.PointLight(0xff9a4d, 60, 80, 1.25); l.position.set(sgn * 3.9, 2.2, -.5); SC.add(l); lights.push(l); });
    fill = new THREE.PointLight(0xffb070, 30, 60, 1.3); fill.position.set(0, 3.4, .6); SC.add(fill);
    spot = new THREE.SpotLight(0xfff1dd, 0, 40, .2, .7, 1.1); spot.position.set(0, 12, 0); SC.add(spot); SC.add(spot.target);
    CANDLES.forEach((d, k) => {
      const x = d[0], z = d[1], hh = d[2];
      const cm = new THREE.Mesh(new THREE.CylinderGeometry(.085, .095, hh, 16), new THREE.MeshStandardMaterial({ color: 0xd9cfb6, emissive: 0x7a3a12, emissiveIntensity: .5, roughness: .7 })); cm.position.set(x, .175 + hh / 2, z); SC.add(cm);
      const f = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX.flame, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })); f.position.set(x, .175 + hh + .2, z); f.userData = { k, base: .175 + hh + .2 }; SC.add(f); flames.push(f);
    });
    [-4.1, 4.1].forEach((x) => { const gl = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX.glow, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: .3 })); gl.position.set(x, 1.1, -.5); gl.scale.set(7, 7, 1); SC.add(gl); glows.push(gl); });
    // vault (the keeper's enclave)
    vault = new THREE.Group(); const box = new THREE.BoxGeometry(1.5, 1.5, 1.5);
    vault.add(new THREE.Mesh(box, new THREE.MeshStandardMaterial({ color: 0x0b0b0c, metalness: .85, roughness: .32 })));
    vaultEdges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: 0xe9e2d0, transparent: true })); vault.add(vaultEdges);
    for (let k = 0; k < 4; k++) { const sl = new THREE.Mesh(new THREE.PlaneGeometry(.9, .05), new THREE.MeshBasicMaterial({ color: 0xff3020, transparent: true })); const a = k * PI / 2; sl.position.set(Math.sin(a) * .76, -.15, Math.cos(a) * .76); sl.rotation.y = a; vault.add(sl); vaultSlots.push(sl); const dl = new THREE.Mesh(new THREE.RingGeometry(.2, .23, 40), new THREE.MeshBasicMaterial({ color: 0xe9e2d0, transparent: true, opacity: .5 })); dl.position.set(Math.sin(a) * .76, .28, Math.cos(a) * .76); dl.rotation.y = a; vault.add(dl); }
    SC.add(vault);
    for (let i = 0; i < 7; i++) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX.smoke, transparent: true, depthWrite: false, opacity: .5, color: 0xc9b9a6 })); SC.add(s); smoke.push(s); }
    const pg = new THREE.PlaneGeometry(2.3, 3.22);
    SEATS.forEach((s) => {
      const m = new THREE.Mesh(pg, new THREE.ShaderMaterial({ uniforms: { map: { value: portraitTex(s) }, lit: { value: .4 }, join: { value: 0 } }, vertexShader: PVS, fragmentShader: PFS, transparent: true, side: THREE.DoubleSide }));
      SC.add(m); portraits.push(m);
    });
    btnM = new THREE.Mesh(new THREE.CylinderGeometry(.3, .3, .07, 32), [new THREE.MeshStandardMaterial({ color: 0xd9cfb6, roughness: .5 }), new THREE.MeshStandardMaterial({ map: TEX.btn, roughness: .5 }), new THREE.MeshStandardMaterial({ color: 0x14100c })]); btnM.visible = false; SC.add(btnM);
    // DOM that rides on the table: seat plates and bet labels
    SEATS.forEach(() => { const p = document.createElement('div'); p.className = 'plate'; p.style.display = 'none'; tbl.appendChild(p); plates.push(p); const b = document.createElement('div'); b.className = 'betl'; b.style.display = 'none'; tbl.appendChild(b); betLs.push(b); });
  }
  const CG = () => new THREE.PlaneGeometry(1.0, 1.4);
  function cardMesh() {
    const outer = new THREE.Group(), inner = new THREE.Group(); outer.add(inner); outer.rotation.x = -PI / 2;
    const f = new THREE.Mesh(CG(), new THREE.MeshBasicMaterial({ map: TEX.back })); f.position.z = .006;
    const b = new THREE.Mesh(CG(), new THREE.MeshBasicMaterial({ map: TEX.back })); b.rotation.y = PI; b.position.z = -.006; inner.add(f, b);
    outer.userData = { inner, f, b, code: null }; SC.add(outer); return outer;
  }
  function setFace(m, card) { if (card && m.userData.code !== card) { m.userData.code = card; m.userData.f.material.map = faceTex(card); m.userData.f.material.needsUpdate = true; } }
  let chipGeo = null, chipMats = null;
  function chipMesh(tone) {
    if (!chipGeo) { chipGeo = new THREE.CylinderGeometry(.2, .2, .05, 28); chipMats = TEX.chip.map((c) => [new THREE.MeshStandardMaterial({ color: c.side, roughness: .55 }), new THREE.MeshStandardMaterial({ map: c.map, roughness: .5 }), new THREE.MeshStandardMaterial({ color: 0x0a0605 })]); }
    const m = new THREE.Mesh(chipGeo, chipMats[tone]); SC.add(m); return m;
  }
  const V3 = () => new THREE.Vector3();
  let pv = null;
  function proj(x, y, z) { pv.set(x, y, z).project(CAM); if (pv.z > 1 || pv.z < -1) return null; return [(pv.x * .5 + .5) * W, (-pv.y * .5 + .5) * H]; }
  const vaultPos = (vlt, hover) => [0, .175 + .75 + hover * 1.05 + (1 - eo(vlt)) * 9, -2.5 * hover];
  function curTag(i, t) { const k = tagK[i]; for (let n = k.length - 1; n >= 0; n--) if (k[n].s <= t) return t < k[n].e ? k[n] : null; return null; }
  function plateHTML(i, stack, tag) {
    return '<div class="st"><svg viewBox="0 0 20 20"><circle class="tr" cx="10" cy="10" r="7.5"/><circle class="rg" cx="10" cy="10" r="7.5" stroke-dasharray="47.13" stroke-dashoffset="47.13"/></svg>' + (POS[i] ? '<span class="pos">' + POS[i] + '</span>' : '') + '<b>' + stack + '</b></div>' +
      '<div class="tg">' + (tag ? '<span class="tag ' + tag.cls + '">' + tag.text + '</span>' + (tag.rc ? '<span class="tipw"><span class="wax mini">TEE</span>' + tipHTML(tag.rc) + '</span>' : '') : '') + '</div>';
  }

  // ---------- render(t) ----------
  let lastFilter = '', curT = 0, W = 0, H = 0;
  function resize() {
    W = window.innerWidth; H = window.innerHeight; document.documentElement.style.setProperty('--u', Math.min(W, H * 16 / 9) / 100 + 'px');
    R.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); R.setSize(W, H, false); CAM.aspect = W / H;
  }
  function render(t) {
    curT = t;
    const G0 = genAt(t), holes = G0.holes, board = G0.board, foldT = G0.foldT; // LIVE
    const night = tv('night', t), vlt = tv('vault', t), house = tv('house', t), hover = tv('hover', t), selfhide = tv('selfhide', t);
    F = { lit: new Array(N).fill(lerp(.58, .14, night)), spot: -1, spotI: 0, blur: 0, dim: 0, shake: 0, hudHide: 0, act: -1, actP: 0, plates: 1, mine: 0 };
    for (let i = 0; i < N; i++) if (t >= foldT[i]) F.lit[i] *= lerp(1, .3, sat((t - foldT[i]) / 700));
    for (let k = 0; k < clips.length; k++) {
      const c = clips[k], on = t >= c.s && t < c.e;
      if (on) { if (c.el && !c.on) c.el.style.display = ''; c.on = true; c.fn(c.e === Infinity ? 0 : (t - c.s) / (c.e - c.s), t, t - c.s); }
      else if (c.on) { c.on = false; if (c.el) c.el.style.display = 'none'; }
    }
    // camera
    const k0 = camAt(t), asp = W / H, k = asp > 1.2 ? Object.assign({}, k0, { lx: k0.lx + k0.ox, lz: k0.lz + k0.oz }) : k0, ph = asp < 1 ? 1 + (1 / asp - 1) * .8 : 1;
    const az = k.az + .035 * Math.sin(t / 6100), el = k.el + .012 * Math.sin(t / 4700), d = k.d * ph;
    const sx = Math.sin(t * .083) * F.shake, sy = Math.cos(t * .071) * F.shake;
    CAM.fov = k.fov * (asp < 1 ? 1.25 : 1); CAM.updateProjectionMatrix();
    CAM.position.set(k.lx + d * Math.cos(az) * Math.cos(el) + sx, k.ly + d * Math.sin(el) + sy, k.lz + d * Math.sin(az) * Math.cos(el));
    CAM.lookAt(k.lx + sx * .5, k.ly + sy * .5, k.lz); CAM.updateMatrixWorld();
    // light
    const fl = 1 + .09 * Math.sin(t * .0113) + .05 * Math.sin(t * .0231 + 1.3) + .03 * Math.sin(t * .0477 + .4), fl2 = 1 + .08 * Math.sin(t * .0127 + 2.1) + .05 * Math.sin(t * .0209 + .3) + .03 * Math.sin(t * .0513);
    lights[0].intensity = 62 * fl * lerp(1, .3, night) * house; lights[1].intensity = 62 * fl2 * lerp(1, .3, night) * house;
    fill.intensity = 20 * lerp(1, .35, night) * house; hemi.intensity = .5 * lerp(1, .45, night) * house;
    glows.forEach((g, n) => { const f = n ? fl2 : fl; g.material.opacity = .15 * f * lerp(1, .35, night) * house; g.scale.setScalar(7 + (f - 1) * 5); });
    flames.forEach((f) => { const q = 1 + .12 * Math.sin(t * .019 + f.userData.k * 2.1) + .06 * Math.sin(t * .041 + f.userData.k); f.scale.set(.26 * house, .62 * q * house, 1); f.position.y = f.userData.base + (q - 1) * .2; f.material.opacity = lerp(1, .55, night); });
    if (F.spot >= 0) { const p = sp(F.spot, 5.6); spot.target.position.set(p[0], .4, p[1]); spot.position.set(p[0] * .6, 11, p[1] * .6); }
    spot.intensity = 260 * F.spotI * house;
    const amb = lerp(.95, .42, night) * (.35 + .65 * house);
    // vault
    const vp = vaultPos(vlt, hover);
    vault.visible = vlt > .002; if (vault.visible) { const hum = 1 + .012 * Math.sin(t * .05); vault.scale.setScalar(hum); vault.position.set(vp[0], vp[1], vp[2]); vault.rotation.y = t * .00012 + (1 - vlt) * 2; vaultEdges.material.opacity = (.35 + .3 * Math.sin(t * .006)) * vlt; vaultSlots.forEach((s, i) => { s.material.opacity = (.55 + .45 * Math.sin(t * .012 + i)) * vlt; }); }
    // smoke
    smoke.forEach((s, i) => { s.position.set(3.2 * Math.sin(t * 1e-4 * (.6 + i * .13) + i * 2.1), 1.6 + i * .4 + .4 * Math.sin(t * 7e-5 + i), 3.2 * Math.cos(t * 8e-5 * (.7 + i * .1) + i * 1.3)); const sc = 7 + i * 1.2; s.scale.set(sc, sc, 1); s.material.rotation = t * 2.5e-5 * (i % 2 ? 1 : -1) + i; s.material.opacity = .16 * house * lerp(1, .5, night); });
    // portraits
    for (let i = 0; i < N; i++) {
      const m = portraits[i], u = m.material.uniforms, p = sp(i, 6.9);
      u.join.value = ss((t - joinT[i]) / 1100) * house * (i === ME ? 1 - selfhide : 1); u.lit.value = F.lit[i];
      m.visible = u.join.value > .001; m.quaternion.copy(CAM.quaternion);
      m.position.set(p[0], 1.75 + (1 - eo((t - joinT[i]) / 1100)) * .6, p[1]);
    }
    // dealer button
    btnM.visible = t >= btnT; if (btnM.visible) { const p = sp(btnSeat, 4.25), a = ang(btnSeat); btnM.position.set(p[0] - Math.sin(a) * 1.75, .21 + (1 - eo((t - btnT) / 500)) * 1.5, p[1] + Math.cos(a) * 1.75); }
    // hole cards: dealt as sealed pairs from the vault
    for (let i = 0; i < N; i++) {
      const hc = holes[i], on = t >= hc.d0; let ms = holeM[i];
      if (!ms) { if (!on) continue; ms = holeM[i] = [cardMesh(), cardMesh()]; const wx = new THREE.Mesh(new THREE.CylinderGeometry(.15, .17, .05, 20), new THREE.MeshBasicMaterial({ color: 0xb3180f })); SC.add(wx); waxM[i] = wx; }
      const base = sp(i, 4.3), fq = ss((t - foldT[i]) / 600), mine = i === ME;
      for (let j = 0; j < 2; j++) {
        const m = ms[j]; m.visible = on; if (!on) continue;
        if (hc.cards) setFace(m, hc.cards[j]);
        const p = sat((t - hc.d0 - j * 90) / 850), e = eio(p), sgn = j ? 1 : -1, q = eio((t - hc.flipT - j * 150) / 720), spread = lerp(lerp(.3, .56, q), .1, fq);
        m.position.set(lerp(0, base[0] + sgn * spread, e), lerp(1.2, .185 + j * .004, e) + Math.sin(p * PI) * 1.3, lerp(0, base[1], e));
        m.rotation.z = (1 - e) * 4 * sgn - sgn * .08 * (1 - fq * .6);
        m.userData.inner.rotation.y = PI * (1 - q); m.userData.inner.position.z = Math.sin(q * PI) * .8; m.scale.setScalar((mine ? 1.12 : 1) * (1 + Math.sin(q * PI) * .15));
        const br = amb * lerp(1, .3, fq); m.userData.f.material.color.setScalar(br); m.userData.b.material.color.setScalar(br);
      }
      const wx = waxM[i], lp = sat((t - hc.d0 - 940) / 200), gone = sat((t - hc.flipT + 250) / 250);
      wx.visible = on && lp > 0 && gone < 1; if (wx.visible) { wx.position.set(base[0], .22 + (1 - eo(lp)) * .5 + gone * .6, base[1]); wx.scale.setScalar((1 + (1 - eox(lp)) * 1.2) * (1 - gone)); wx.material.color.setRGB(.7 * amb * lerp(1, .5, fq), .094 * amb * lerp(1, .5, fq), .06 * amb * lerp(1, .5, fq)); }
    }
    // board: each street flies out of the vault face down, then turns
    board.forEach((bc, n) => {
      let m = boardM[n]; const on = t >= bc.t0; if (!m) { if (!on) return; m = boardM[n] = cardMesh(); } if (m.userData.card !== bc.card) { setFace(m, bc.card); m.userData.card = bc.card; }
      m.visible = on; if (!on) return;
      const p = sat((t - bc.t0) / 800), e = eio(p), q = eio((t - bc.flipT) / 720), fx = 0, fy = .175 + .75 + 1.05, fz = -2.5;
      m.position.set(lerp(fx, (n - 2) * 1.16, e), lerp(fy - .7, .186 + n * .001, e) + Math.sin(p * PI) * .5, lerp(fz, 0, e));
      m.rotation.z = (1 - e) * 2.5 + ((n * 37) % 7 - 3) * .012;
      m.userData.inner.rotation.y = PI * (1 - q); m.userData.inner.position.z = Math.sin(q * PI) * .9; m.scale.setScalar(1.08 * (1 + Math.sin(q * PI) * .16));
      const br = lerp(amb, 1, Math.sin(q * PI) * .5) * (q > 0 ? 1.05 : 1); m.userData.f.material.color.setScalar(br); m.userData.b.material.color.setScalar(amb);
      const lt = t - bc.flipT; if (lt > 360 && lt < 900) F.shake += Math.exp(-(lt - 360) / 110) * .03;
    });
    for (let n = board.length; n < boardM.length; n++) if (boardM[n]) boardM[n].visible = false; // LIVE: a new hand clears the board
    // chips
    chips.forEach((c, n) => {
      let m = chipM[n]; const on = t >= c.t0 && !(t >= (c.gone ?? Infinity)); if (!m) { if (!on) return; m = chipM[n] = chipMesh(c.tone); }
      m.visible = on; if (!on) return;
      const a = ang(c.i), tx = -Math.sin(a), tz = Math.cos(a), b0 = sp(c.i, 3.35), a0 = sp(c.i, 5.0), y0 = .205 + c.lvl * .055;
      const p = eox((t - c.t0) / 620);
      let x = lerp(a0[0], b0[0], p) + tx * c.col, y = y0, z = lerp(a0[1], b0[1], p) + tz * c.col;
      if (t >= c.tc) { const q = eio((t - c.tc) / 760); x = lerp(x, c.p[0], q); y = lerp(y, c.p[1], q) + Math.sin(q * PI) * .08; z = lerp(z, c.p[2], q); }
      if (t >= c.tw) { const q = eio((t - c.tw) / 900), w0 = sp(c.wi, 3.5); x = lerp(x, w0[0] + c.w[0], q); y = lerp(y, c.w[1], q) + Math.sin(q * PI) * .12; z = lerp(z, w0[1] + c.w[2] - .2, q); }
      m.position.set(x, y, z); m.rotation.y = n * 1.7;
    });
    // post
    const filt = F.blur > .05 ? 'blur(' + (F.blur * W / 1600).toFixed(2) + 'px)' : 'none'; if (filt !== lastFilter) { lastFilter = filt; glc.style.filter = filt; }
    dimEl.style.opacity = F.dim.toFixed(3);
    const fr = Math.floor(t / 41.667); grainEl.style.backgroundPosition = ((fr * 73) % 256) + 'px ' + ((fr * 151) % 256) + 'px';
    // seat plates + bet labels (projected from the table)
    const pf = house * (1 - F.hudHide) * (1 - sat(F.blur / 4.5)) * F.plates;
    for (let i = 0; i < N; i++) {
      const pl = plates[i], bl = betLs[i], jn = sat((t - joinT[i] - 900) / 500);
      let pr = i !== ME && pf * jn > .01 && t >= btnT ? proj(sp(i, 6.9)[0], .1, sp(i, 6.9)[1]) : null;
      if (pr && (pr[0] < -60 || pr[0] > W + 60 || pr[1] > H + 20)) pr = null;
      if (!pr) { if (pl._on) { pl._on = false; pl.style.display = 'none'; } }
      else {
        if (!pl._on) { pl._on = true; pl.style.display = ''; }
        const stack = stepAt(stackK[i], t), tag = curTag(i, t), key = stack + '|' + (POS[i] || '') + '|' + (tag ? tag.s : '');
        if (pl._key !== key) { pl._key = key; pl.innerHTML = plateHTML(i, stack, tag); pl._rg = pl.querySelector('.rg'); pl._wax = pl.querySelector('.wax'); pl._tag = pl.querySelector('.tag'); pl.className = 'plate ' + (pr[0] < W * .3 ? 'lft' : pr[0] > W * .7 ? 'rgt' : ''); }
        pl.style.left = pr[0].toFixed(1) + 'px'; pl.style.top = (pr[1] + 4).toFixed(1) + 'px'; pl.style.opacity = (pf * jn * (t >= foldT[i] ? .6 : 1)).toFixed(3);
        pl._rg.setAttribute('stroke-dashoffset', (F.act === i ? 47.13 * F.actP : 47.13).toFixed(2));
        if (tag) { const q = sat((t - tag.s) / 260); pl._tag.style.transform = 'scale(' + lerp(1.5, 1, eox(q)) + ')'; pl._tag.style.opacity = q; if (pl._wax) { const w = sat((t - tag.s - 300) / 260); pl._wax.style.opacity = w > 0 ? 1 : 0; pl._wax.style.transform = 'scale(' + lerp(2.6, 1, eox(w)) + ') rotate(' + lerp(-30, -8, eox(w)) + 'deg)'; } }
      }
      const bet = stepAt(betK[i], t); let br = bet > 0 && pf > .01 ? proj(sp(i, 3.35)[0], .2, sp(i, 3.35)[1]) : null;
      if (!br) { if (bl._on) { bl._on = false; bl.style.display = 'none'; } }
      else {
        if (!bl._on) { bl._on = true; bl.style.display = ''; }
        if (bl._v !== bet) { bl._v = bet; bl.textContent = bet; }
        bl.style.left = br[0].toFixed(1) + 'px'; bl.style.top = (br[1] + Math.max(16, W * .017)).toFixed(1) + 'px'; bl.style.opacity = pf.toFixed(3);
      }
    }
    // hud
    let sc = null; for (let i = scenes.length - 1; i >= 0; i--) if (t >= scenes[i].start) { sc = scenes[i]; break; }
    hud.style.opacity = house * (1 - F.hudHide) * (sc && sc.id === 'title' ? 0 : 1);
    const ph2 = sc ? sc.label : ''; if (hudPhase.textContent !== ph2) hudPhase.textContent = ph2;
    const me = t >= btnT ? 'YOU' + (POS[ME] ? ' · ' + { D: 'BUTTON', SB: 'SMALL BLIND', BB: 'BIG BLIND' }[POS[ME]] : '') + '<br><b>STACK ' + stepAt(stackK[ME], t) + '</b>' : ''; if (hudMe._h !== me) { hudMe._h = me; hudMe.innerHTML = me; }
    const shownB = board.filter((b) => t >= b.flipT + 380).length, pot = stepAt(potK, t), bk = shownB + '|' + pot;
    if (hudBoard._h !== bk) { hudBoard._h = bk; hudBoard.innerHTML = (shownB ? '<span class="cs">' + board.slice(0, shownB).map((b) => pc(b.card)).join('') + '</span>' : '') + (pot ? '<em>POT<b>' + pot + '</b></em>' : ''); }
    const hk = t >= handT && myHole ? 1 : 0; if (hudHand._h !== hk) { hudHand._h = hk; hudHand.innerHTML = hk ? '<span class="cs">' + myHole.map((c) => pc(c)).join('') + '</span><small>Your hand<br><b>sealed to you alone</b></small>' : ''; }
    if (hk) { const a = eo((t - handT) / 500); hudHand.style.opacity = a; hudHand.style.transform = 'translateY(' + (1 - a) * 20 + 'px) scale(' + (1 + F.mine * .12) + ')'; hudHand.style.transformOrigin = '100% 100%'; }
    R.render(SC, CAM);
  }
  const hudPhase = $('#hud-phase'), hudMe = $('#hud-me'), hudBoard = $('#hud-board'), hudHand = $('#hud-hand');

  // ---------- boot ----------
  async function boot(opts) {
    opts = opts || {};
    try { await Promise.race([Promise.all(['96px Anton', 'italic 30px "Instrument Serif"', '500 14px "IBM Plex Mono"', '600 14px Inter'].map((f) => document.fonts.load(f))), new Promise((r) => setTimeout(r, 3000))]); } catch (e) { /* offline: fallbacks */ }
    P = await HD.loadPortraits(SEATS);
    pv = V3(); build3D(); resize(); window.addEventListener('resize', () => { resize(); render(curT); });
    adapter = opts.adapter || HD.createMockAdapter({ auto: DIRECTOR, omni: OMNI });
    adapter.start(consume);

    let manual = Q.has('t'), playT = manual ? +Q.get('t') : 0, last = null, speed = +(Q.get('speed') || 1), paused = false;
    const limit = () => (holdAt != null ? holdAt : T);
    function tick(now) {
      if (!manual && !paused && last != null) { const behind = limit() - playT, boost = DIRECTOR ? 1 : 1 + Math.max(0, (behind - 2500) / 1500); playT = Math.min(playT + Math.min(now - last, 100) * speed * Math.min(boost, 6), limit()); } // LIVE: catch up with the table
      last = now; render(playT); requestAnimationFrame(tick);
    }
    if (DIRECTOR) {
      window.director = {
        duration: T, scenes: scenes.map((s) => ({ id: s.id, start: s.start, end: s.end })),
        seek(ms) { manual = true; playT = Math.max(0, Math.min(ms, T)); render(playT); },
        play() { manual = false; }, get time() { return playT; },
      };
    } else {
      const ctl = $('#ctl');
      if (!opts.adapter) { const v = document.createElement('button'); v.textContent = OMNI ? 'Player’s view' : 'Viewer’s cut'; v.title = OMNI ? 'Hide who is AI until the hand ends' : 'Show the TEE seal on every AI decision while the hand is running'; v.onclick = () => { const q = new URLSearchParams(location.search); if (OMNI) q.delete('omni'); else q.set('omni', '1'); location.search = q.toString(); }; ctl.appendChild(v); }
      const b = document.createElement('button'); b.textContent = 'Skip ▸▸'; b.title = 'Jump to the next beat';
      b.onclick = () => { const nx = scenes.find((s) => s.start > playT + 50); playT = Math.min(nx ? nx.start : limit(), limit()); };
      ctl.appendChild(b);
      window.addEventListener('keydown', (e) => { if (e.target.tagName === 'INPUT') return; if (e.code === 'Space') { paused = !paused; e.preventDefault(); } if (e.code === 'ArrowRight') b.onclick(); });
    }
    window.holdem = { get time() { return playT; }, get end() { return T; }, get gate() { return holdAt; }, scenes, seek(ms) { manual = true; playT = ms; render(ms); }, resume() { manual = false; } };
    render(playT); requestAnimationFrame(tick);
    return window.holdem;
  }
  HD.boot = boot;
  HD.ready = boot(window.HOLDEM_BOOT || {});
  if (DIRECTOR) HD.ready.then(() => { window.director.ready = true; });
};
