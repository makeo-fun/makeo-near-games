// @ts-nocheck
// Ported as is from games/nearwolf/ui (the noir show engine); type checking is off for this file.
/* NEARWOLF — the show engine.
 * Everything on screen is a pure function of one timeline time t (ms): render(t).
 * Events from a NearwolfView (see story.js) are compiled into clips on that timeline.
 *   play mode:      a clock advances t and stops at "gates" until you act.
 *   director mode:  ?director=1  → window.director = { duration, seek(ms), scenes, ready }
 * No Math.random, no wall-clock inside render.
 */
// Mounted by client/main.ts once the table's seats are known (NEARWOLF.SEATS).
(window.NEARWOLF = window.NEARWOLF || {}).mount = function () {
  'use strict';
  const NW = window.NEARWOLF, SEATS = NW.SEATS, N = SEATS.length, PI = Math.PI;
  const Q = new URLSearchParams(location.search);
  const DIRECTOR = Q.has('director');
  const idx = {}; SEATS.forEach((s, i) => (idx[s.id] = i));
  const short = (id) => SEATS[idx[id]].name.split(' ').pop().toUpperCase();
  const $ = (s) => document.querySelector(s);
  const ui = $('#ui'), glc = $('#gl'), dimEl = $('#dim'), grainEl = $('#grain'), hud = $('#hud');

  // ---------- math ----------
  const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const lerp = (a, b, x) => a + (b - a) * x;
  const ss = (x) => { x = sat(x); return x * x * x * (x * (x * 6 - 15) + 10); };
  const eo = (x) => 1 - Math.pow(1 - sat(x), 3);
  const eox = (x) => { x = sat(x); return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x); };
  const eio = (x) => { x = sat(x); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  function prng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
  const ang = (i) => PI / 2 + (i * 2 * PI) / N;
  const sp = (i, r) => [Math.cos(ang(i)) * r, Math.sin(ang(i)) * r];
  const ORD = ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE'];
  const sh = (s, n) => { s = String(s == null ? '' : s); return s.length > n + 5 ? s.slice(0, n) + '…' + s.slice(-4) : s; };

  // ---------- timeline ----------
  const clips = [], scenes = [], tracks = {}, camKeys = [];
  let T = 0, holdAt = null, FINAL = false;
  const joinT = new Array(N).fill(Infinity), deaths = [], flights = [], cardSets = [], lines = [];
  let roleT = Infinity, myRole = null, OMNI = null, P = null, adapter = null, openPick = null, lastEnv = null;
  let F = null; // per-frame state

  function add(s, e, fn, el) { const c = { s, e, fn, el, on: false }; clips.push(c); return c; }
  function h(cls, html) { const e = document.createElement('div'); e.className = cls; e.innerHTML = html || ''; e.style.display = 'none'; ui.appendChild(e); return e; }
  function scene(id, label) { if (scenes.length) scenes[scenes.length - 1].end = T; scenes.push({ id, start: T, end: T, label: label || '' }); }
  function ramp(name, t0, dur, v) {
    const k = tracks[name] || (tracks[name] = [{ t: -1, v: name === 'house' ? 0 : 0 }]);
    const last = k[k.length - 1]; k.push({ t: Math.max(t0, last.t), v: last.v }, { t: Math.max(t0, last.t) + dur, v });
  }
  function tv(name, t) {
    const k = tracks[name]; if (!k) return 0; let i = k.length - 1; while (i > 0 && k[i].t > t) i--;
    const a = k[i], b = k[i + 1]; if (!b || b.t <= a.t) return a.v; return lerp(a.v, b.v, ss((t - a.t) / (b.t - a.t)));
  }
  const POSE = {
    wide: (az) => ({ az: az == null ? PI / 2 : az, el: .6, d: 17.5, lx: 0, ly: .2, lz: 0, fov: 36 }),
    high: () => ({ az: PI / 2 - .5, el: 1.0, d: 25, lx: 0, ly: 0, lz: 0, fov: 36 }),
    top: () => ({ az: PI / 2, el: 1.17, d: 13.4, lx: 0, ly: 0, lz: .35, fov: 36 }),
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
      if (o.slam) F.shake += Math.exp(-Math.max(0, lt - 60) / 170) * .1 * (lt > 60 ? 1 : 0);
    }, el);
  }
  function moveText(m) {
    if (m.kind === 'report') return 'REPORTS A VISION · ' + short(m.target) + ' IS ' + (m.wolf ? 'A WOLF' : 'NOT A WOLF');
    if (m.kind === 'accuse') return 'ACCUSES ' + short(m.target);
    if (m.kind === 'vouch') return 'VOUCHES FOR ' + short(m.target);
    if (m.kind === 'claim') return 'CLAIMS ' + m.role;
    return 'STAYS SILENT';
  }
  /** lower third: a seat speaks, spotlight on them */
  function speak(start, dur, m) {
    const s = SEATS[idx[m.seat]], ai = OMNI && OMNI[m.seat] === 'AI';
    const sealHtml = OMNI
      ? (ai ? '<div class="seal"><span class="wax">TEE</span><span>Signed in NEAR AI Cloud · TEE <b class="ok">✓</b></span></div>' : '<div class="seal"><span>Sealed move · keeper <b class="ok">✓</b></span></div>')
      : '<div class="seal"><span>Sealed move · revealed by the keeper <b class="ok">✓</b></span></div>';
    const el = h('l3', '<div class="bar"></div><div class="who">' + s.name + '<small>' + s.title + '</small></div><div class="mv">' + moveText(m) + '</div><div class="say"></div>' + sealHtml);
    const say = el.querySelector('.say'), seal = el.querySelector('.seal'), wax = el.querySelector('.wax'), bar = el.querySelector('.bar');
    const txt = '“' + m.line + '”', typeEnd = 300 + txt.length * 26; let shown = -1;
    add(start, start + dur, (p, t, lt) => {
      const a = eo(lt / 350), out = sat((dur - lt) / 300), vis = a * out;
      el.style.opacity = vis; el.style.transform = 'translateY(' + (1 - a) * 30 + 'px)'; bar.style.transform = 'scaleX(' + eo(lt / 600) + ')';
      const n = Math.floor(sat((lt - 300) / (typeEnd - 300)) * txt.length); if (n !== shown) { shown = n; say.textContent = txt.slice(0, n); }
      const q = sat((lt - typeEnd - 150) / 260); seal.style.opacity = q > 0 ? 1 : 0;
      if (wax) wax.style.transform = 'scale(' + lerp(2.6, 1, eox(q)) + ') rotate(' + lerp(-30, -8, eox(q)) + 'deg)';
      for (let i = 0; i < N; i++) F.lit[i] = lerp(F.lit[i], i === idx[m.seat] ? 1.25 : F.lit[i] * .3, vis);
      F.spot = idx[m.seat]; F.spotI = Math.max(F.spotI, vis);
      if (wax && q > 0) F.shake += Math.exp(-(lt - typeEnd - 150) / 120) * .03;
    }, el);
  }
  function confessional(start, dur, seat, round, at, text, rc) {
    const s = SEATS[idx[seat]], sealed = text == null;
    const body = sealed ? 'I am not going to tell you what I am. Not yet. What I think, what I plan and who I mean to burn stays in here until the last card is turned.' : text;
    const el = h('conf', '<div class="pt"><i style="background-image:url(\'' + P[seat].url + '\')"></i></div><div class="tx">' +
      '<div class="rec"><b>●</b> REC &nbsp; CONFESSIONAL · NIGHT ' + round + ' · ' + at + ' UTC</div><h3>' + s.name + '</h3>' +
      '<div class="body"></div><div class="st"></div><div class="stamp ' + (sealed ? '' : 'okk') + '">' + (sealed ? 'Sealed until game end' : 'Unsealed ✓ signature verified') + '</div></div>');
    const pt = el.querySelector('.pt i'), bd = el.querySelector('.body'), st = el.querySelector('.st'), stamp = el.querySelector('.stamp'), rec = el.querySelector('.rec b');
    const st1 = 'Private reasoning · NEAR AI Cloud · Intel TDX + NVIDIA confidential GPU';
    const st2 = sealed ? 'Nobody can read this. Not the table. Not us.' : 'response_sha256 ' + sh(rc.response_sha256, 12) + ' · signer ' + sh(rc.signing_address, 10) + ' <b class="ok">✓</b>';
    const t0 = 900, t1 = sealed ? dur * .55 : dur * .7; let shown = -1;
    add(start, start + dur, (p, t, lt) => {
      const vis = sat(lt / 450) * sat((dur - lt) / 450);
      el.style.opacity = vis; pt.style.transform = 'scale(' + (1 + p * .09) + ') translateX(' + (-p * 1.5) + '%)';
      rec.style.opacity = Math.floor(lt / 600) % 2 ? .25 : 1;
      const n = Math.floor(sat((lt - t0) / (t1 - t0)) * body.length);
      if (n !== shown) { shown = n; const tx = body.slice(0, n); bd.innerHTML = (sealed ? tx.split(' ').map((w) => '<span class="rd">' + w + '</span>').join(' ') : tx) + (n < body.length ? '<span class="cur"></span>' : ''); }
      st.innerHTML = (lt > 500 ? st1 : '') + (lt > t1 + 200 ? '<br>' + st2 : '');
      const q = sat((lt - t1 - 500) / 240); stamp.style.opacity = q > 0 ? 1 : 0; stamp.style.transform = 'rotate(-7deg) scale(' + lerp(3, 1, eox(q)) + ')';
      F.blur = Math.max(F.blur, 10 * vis); F.hudHide = Math.max(F.hudHide, vis);
    }, el);
  }

  // ---------- pickers (your own actions) ----------
  function mkPicker(pd) {
    const sel = Object.assign({}, pd.suggest || {});
    if (pd.kind === 'unseal') {
      const el = h('env', '<div class="card"><small>Your role · sealed to you alone</small><b>—</b><em></em></div><div class="flap"><div class="paper"></div><div class="wx"><i class="a"></i><i class="b"></i></div></div><div class="cap">Dealt inside the enclave · only you can open this<br><b class="hint">Tap the seal to break it</b></div>');
      el.style.pointerEvents = 'auto'; el.style.cursor = 'pointer'; el.onclick = () => submit({ unseal: true });
      return { el, sel };
    }
    const el = h('pick', '');
    const seatItems = (ids) => ids.map((id) => ({ v: id, label: short(id), img: P[id].url }));
    const rows = {};
    function row(key, label, items, cls) {
      const r = document.createElement('div'); r.className = 'row'; r.innerHTML = '<span class="lab">' + label + '</span>';
      items.forEach((it) => { const b = document.createElement('button'); b.className = 'chip ' + (cls || ''); b.innerHTML = (it.img ? '<i style="background-image:url(\'' + it.img + '\')"></i>' : '') + it.label; b._k = key; b._v = it.v; b.onclick = () => { sel[key] = it.v; sync(); }; r.appendChild(b); });
      el.appendChild(r); rows[key] = r; return r;
    }
    const head = (a, b, c) => { el.innerHTML = '<h4>' + a + '<small>' + b + '</small></h4><p>' + c + '</p>'; };
    let goLabel = 'GO', valid = () => true;
    if (pd.kind === 'ready') { head('Take your seat', '9 seats · 4 humans · 5 AI', 'You are Ash, the lamplighter. Nobody at this table knows who is human.'); goLabel = 'SIT DOWN'; }
    if (pd.kind === 'night') {
      const txt = { SEER: ['You are the Seer', 'Choose one player. Only you will learn what they are.', 'LOOK'], HEALER: ['You are the Healer', 'Choose one player to protect tonight.', 'PROTECT'], WOLF: ['The wolves hunt', 'Agree on a victim. Only your pack sees this channel.', 'KILL'], VILLAGER: ['You sleep', 'No power tonight. Seal a quiet night: every seat seals something, so nobody can tell who has a power.', 'SEAL'] }[pd.role] || ['Night', 'Wait.', 'SEAL'];
      head('Night ' + ORD[pd.round].toLowerCase() + ' · ' + txt[0], 'sealed to the enclave', txt[1]);
      if (pd.channel) { const c = document.createElement('div'); c.className = 'wolfch'; c.innerHTML = '<b>WOLF CHANNEL · PRIVATE</b><br>' + pd.channel.map((m) => short(m.from) + ': ' + m.text).join('<br>'); el.appendChild(c); }
      if (pd.options && pd.options.length) { row('target', 'who', seatItems(pd.options)); valid = () => sel.target !== undefined; }
      goLabel = txt[2];
    }
    if (pd.kind === 'vote') {
      head('The vote · banish one', 'tie = nobody burns', 'Cast it. Every vote is revealed at once.');
      row('target', 'banish', seatItems(pd.options).concat([{ v: null, label: 'ABSTAIN' }]), 'red'); goLabel = 'CAST'; valid = () => sel.target !== undefined;
    }
    let input = null;
    if (pd.kind === 'move') {
      head('Your move', 'everyone plays at once · sealed until all are in', 'One move. One line. You may lie.');
      row('kind', 'move', [{ v: 'claim', label: 'Claim' }, { v: 'report', label: 'Report a vision' }, { v: 'accuse', label: 'Accuse' }, { v: 'vouch', label: 'Vouch' }, { v: 'silent', label: 'Stay silent' }]);
      row('target', 'who', seatItems(pd.options));
      row('wolf', 'vision', [{ v: true, label: 'is a wolf' }, { v: false, label: 'not a wolf' }], 'red');
      row('role', 'role', ['SEER', 'HEALER', 'VILLAGER'].map((r) => ({ v: r, label: r })));
      const r = document.createElement('div'); r.className = 'row'; r.innerHTML = '<span class="lab">your line</span>'; input = document.createElement('input'); input.maxLength = 90; input.value = sel.line || ''; input.placeholder = 'Say one short thing…'; r.appendChild(input); el.appendChild(r);
      goLabel = 'SLAM IT DOWN';
      valid = () => sel.kind && (sel.kind === 'silent' || (sel.kind === 'claim' ? !!sel.role : !!sel.target && (sel.kind !== 'report' || sel.wolf !== undefined)));
    }
    const fr = document.createElement('div'); fr.className = 'row'; const go = document.createElement('button'); go.className = 'go'; go.textContent = goLabel; fr.appendChild(go); el.appendChild(fr);
    function sync() {
      el.querySelectorAll('.chip').forEach((b) => b.classList.toggle('on', sel[b._k] === b._v));
      if (pd.kind === 'move') { rows.target.style.display = sel.kind && sel.kind !== 'silent' && sel.kind !== 'claim' ? '' : 'none'; rows.wolf.style.display = sel.kind === 'report' ? '' : 'none'; rows.role.style.display = sel.kind === 'claim' ? '' : 'none'; }
      go.disabled = !valid();
    }
    sync();
    go.onclick = () => { if (!valid()) return; const c = Object.assign({}, sel); if (input) c.line = input.value; submit(c); };
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
      }, pk.el);
    }
    openPick = c; T = c.gate; if (!DIRECTOR) holdAt = c.gate; return c;
  }
  function closePicker(c, dwell) {
    c.closed = true; c.closeT = c.gate + dwell; holdAt = null; openPick = null;
    if (c.pd.kind === 'unseal') { c.clip.e = c.closeT + 4700; T = c.closeT + 4300; ramp('vault', c.closeT + 600, 1500, 0); ramp('night', c.closeT + 1200, 1800, 0); flights.forEach((f) => { if (f.hold === Infinity) f.hold = c.closeT + 900; }); camTo(c.closeT + 1500, 3000, POSE.wide(PI / 2 + .15)); }
    else { c.clip.e = c.closeT + 380; T = c.closeT + 200; }
  }

  // ---------- event → clips ----------
  const G = {
    lobby(ev) {
      if (DIRECTOR) {
        scene('title', '');
        ramp('house', 4300, 2400, 1); camTo(0, 0, POSE.high());
        kinetic(500, 4600, [{ t: 'A MAKEO GAME · ON NEAR', c: 'mono' }, { t: 'NEAR<span class="red">WOLF</span>', c: 'xl' }, { t: 'The first social deduction game where the liars are AI,<br>and their confessions are cryptographically sealed.', c: 'serif' }], { slow: true, stagger: 500, blur: 0, dim: 0 });
        T = 5200;
      } else { ramp('house', 0, 1800, 1); camTo(0, 0, POSE.high()); }
      scene('lobby', 'THE LOBBY');
      camTo(T - 600, 6800, POSE.wide(PI / 2 - .12));
      ev.seats.forEach((id, k) => { joinT[idx[id]] = T + 700 + k * 480; });
      kinetic(T + 1500, 4200, [{ t: (ORD[N] || String(N)) + ' SEATS', c: '' }, { t: (NW.LIVE ? 'People, AI and the house. Every seat looks the same.' : 'Four humans. Five AI. Every seat looks the same.'), c: 'serif' }], { cls: 'low', blur: 0, dim: .1 });
      T += 6000;
    },
    deal(ev) {
      scene('deal', 'THE DEAL');
      ramp('night', T, 1500, .7); ramp('vault', T + 200, 1600, 1); camTo(T, 2600, POSE.center());
      kinetic(T + 500, 2700, [{ t: 'THE KEEPER', c: 'mono' }, { t: 'ROLES ARE DEALT', c: 'sm' }, { t: 'IN THE DARK', c: 'sm red' }], { cls: 'high', blur: 0, dim: .1, slam: true });
      for (let i = 0; i < N; i++) { const b = sp(i, 4.5); flights.push({ i, t0: T + 2300 + i * 300, t1: T + 3200 + i * 300, a: [0, 1.1, 0], b: [b[0], .2, b[1]], hold: Infinity, land: true }); }
      const el = h('cap2', ev.pcr0 && ev.commitment ? 'Makeo keeper · AWS Nitro enclave · attested <b class="ok">✓</b><br>PCR0 <b>' + sh(ev.pcr0, 14) + '</b> &nbsp;·&nbsp; role commitment <b>' + sh(ev.commitment, 14) + '</b>'
        : 'Makeo keeper · hidden game executor<br>roles dealt from a secret committed when the room opened · published at the end');
      add(T + 2400, T + 7400, (p, t, lt) => { el.style.opacity = sat(lt / 400) * sat((5000 - lt) / 400); }, el);
      camTo(T + 3000, 3300, Object.assign(POSE.wide(PI / 2 + .1), { el: .78, d: 15 }));
      T += 6100;
    },
    role(ev) {
      myRole = ev.role; roleT = T - 3300;
      const txt = { SEER: ['THE SEER', 'Each night you learn one thing: wolf, or not wolf.'], HEALER: ['THE HEALER', 'Each night you protect one player.'], WOLF: ['A WOLF', 'You know your pack. Nobody else does.'], VILLAGER: ['A VILLAGER', 'You know nothing. Find the liars.'] }[ev.role];
      if (lastEnv) { lastEnv.querySelector('.card b').innerHTML = txt[0]; lastEnv.querySelector('.card em').textContent = txt[1]; lastEnv.querySelector('.card small').textContent = 'You are · sealed to you alone'; }
    },
    night(ev) {
      const r = ev.round; scene('night-' + r, 'NIGHT ' + ORD[r]);
      ramp('night', T, 1500, 1); ramp('vault', T + 300, 1200, 1); camTo(T, 4000, Object.assign(POSE.wide(PI / 2 + .5), { el: .8, d: 16 }));
      const long = r === 1;
      kinetic(T + 300, long ? 3000 : 1700, [{ t: 'NIGHT ' + ORD[r], c: 'xl' }].concat(long ? [{ t: 'Every seat sends a sealed envelope. Only the enclave knows which are empty.', c: 'serif' }] : []), { blur: 3, dim: .15, slam: true });
      aliveAt(T).forEach((i, k) => { const a = sp(i, 5.3); flights.push({ i, t0: T + 900 + k * 110, t1: T + 2000 + k * 110, a: [a[0], .5, a[1]], b: [0, 1.0, 0], hold: 0, land: false }); });
      T += long ? 3200 : 1900;
    },
    vision(ev) {
      const dur = ev.round === 1 ? 3800 : 2300, s = SEATS[idx[ev.target]];
      const el = h('vision', '<div class="pt" style="background-image:url(\'' + P[ev.target].url + '\')"></div><div class="tx"><small>Your vision · sealed to you alone</small><b>' + short(ev.target) + ' IS<br><span class="' + (ev.wolf ? 'red' : '') + '">' + (ev.wolf ? 'A WOLF' : 'NOT A WOLF') + '</span></b><em>' + s.name + ' ' + s.title + '. Nobody else at the table saw this.</em></div>');
      const pt = el.querySelector('.pt'), b = el.querySelector('b');
      add(T, T + dur, (p, t, lt) => {
        const vis = sat(lt / 400) * sat((dur - lt) / 400); el.style.opacity = vis; pt.style.transform = 'scale(' + (1 + p * .05) + ')';
        const q = sat((lt - 500) / 300); b.style.opacity = q; b.style.transform = 'scale(' + lerp(1.5, 1, eox(q)) + ')'; b.style.transformOrigin = '0 50%';
        F.blur = Math.max(F.blur, 9 * vis); F.dim = Math.max(F.dim, .55 * vis); if (lt > 500) F.shake += Math.exp(-(lt - 500) / 150) * .06;
      }, el);
      T += dur;
    },
    sealed(ev) { scene('sealed-confessional', 'CONFESSIONAL'); confessional(T, 5600, ev.seat, ev.round, ev.at, null); T += 5600; },
    dawn(ev) {
      const r = ev.round; scene('dawn-' + r, 'DAWN · DAY ' + ORD[r]);
      ramp('night', T, 1800, 0); ramp('vault', T, 1200, 0); camTo(T, 1600, POSE.wide(PI / 2 - .2));
      if (!ev.died) {
        kinetic(T + 500, 2900, [{ t: 'DAWN · DAY ' + ORD[r], c: 'mono' }, { t: 'NOBODY DIED' }, { t: 'Someone was saved in the night.', c: 'serif' }], { slam: true }); T += 3500; return;
      }
      const i = idx[ev.died], nm = short(ev.died);
      camTo(T + 1300, 1500, POSE.seat(i));
      kinetic(T + 400, 2700, [{ t: 'DAWN · DAY ' + ORD[r], c: 'mono' }, { t: nm + ' IS DEAD' }], { slam: true, blur: 2 });
      deaths.push({ i, t0: T + 2600, t1: T + 4700, role: ev.role });
      add(T + 1500, T + 5600, (p) => { F.lit[i] = Math.max(F.lit[i], 1.1 * sat(p * 6)); });
      kinetic(T + 3700, 2000, [{ t: nm + ' WAS', c: 'sm' }, { t: (ev.role === 'VILLAGER' ? 'A ' : 'THE ') + ev.role, c: ev.role === 'WOLF' ? 'red' : '' }], { cls: 'low', blur: 0, dim: .1, slam: true });
      T += 5900;
      if (ev.proves) {
        const li = idx[ev.proves.liar];
        camTo(T - 300, 1400, POSE.top()); lines.push({ a: li, b: i, s: T + 300, e: T + 6200, c: 'red' });
        kinetic(T, 1500, [{ t: ev.proves.text[0], c: 'sm' }], { slam: true });
        kinetic(T + 1500, 1500, [{ t: ev.proves.text[1], c: 'sm' }], { slam: true });
        camTo(T + 2600, 1200, POSE.seat(li));
        kinetic(T + 3000, 2400, [{ t: ev.proves.text[2], c: 'xl red' }], { slam: true, blur: 2 });
        add(T + 2600, T + 5600, (p) => { F.lit[li] = Math.max(F.lit[li], 1.2 * sat(p * 5)); F.spot = li; F.spotI = Math.max(F.spotI, sat(p * 5) * sat((1 - p) * 5)); });
        T += 5600;
      }
    },
    table(ev) {
      const r = ev.round; scene('table-' + r, 'DAY ' + ORD[r] + ' · THE TABLE');
      camTo(T, 1500, POSE.wide(PI / 2 + .1));
      kinetic(T + 200, 1500, [{ t: 'DAY ' + ORD[r] + ' · THE TABLE', c: 'mono' }, { t: 'ONE MOVE EACH', c: 'sm' }, { t: 'ALL AT ONCE', c: 'sm red' }], { cls: 'high', blur: 0, dim: .1 });
      T += 1500;
    },
    moves(ev) {
      const r = ev.round, ms = ev.moves, set = { round: r, s: T, e: Infinity, cards: [] };
      camTo(T, 1100, POSE.top());
      ms.forEach((m, k) => set.cards.push({ m, i: idx[m.seat], slam: T + 350 + k * 140 }));
      set.flip = T + 350 + ms.length * 140 + 800; cardSets.push(set);
      const cap = h('cap2', 'Sealed moves · revealed together by the keeper <b class="ok">✓</b>');
      add(set.flip - 500, set.flip + 1900, (p, t, lt) => { cap.style.opacity = sat(lt / 300) * sat((2400 - lt) / 300); }, cap);
      T = set.flip + 2000;
      const feats = ms.filter((m) => m.feature);
      for (const m of feats) {
        camTo(T - 200, 1000, POSE.seat(idx[m.seat]));
        const S = short(m.seat);
        if (m.claim && r === 1) { kinetic(T, 1500, [{ t: S + ' CLAIMS' }, { t: m.claim, c: 'xl' }], { slam: true, blur: 2 }); T += 1500; }
        if (m.kind === 'report') kinetic(T, 1500, [{ t: S + ' REPORTS', c: 'sm' }, { t: short(m.target) + ' IS ' + (m.wolf ? 'A WOLF' : 'NOT A WOLF'), c: m.wolf ? 'red' : '' }], { slam: true, blur: 2 });
        else kinetic(T, 1500, [{ t: S + (m.kind === 'accuse' ? ' ACCUSES' : ' VOUCHES FOR'), c: 'sm' }, { t: short(m.target), c: m.kind === 'accuse' ? 'red' : '' }], { slam: true, blur: 2 });
        const d = 1500 + m.line.length * 26 + 1500; speak(T + 1200, d, m); T += 1200 + d;
      }
      // contradictions: two seats claiming the same role, or a wolf report
      const seers = ms.filter((m) => m.claim === 'SEER'), pairs = [];
      if (seers.length > 1) pairs.push([idx[seers[0].seat], idx[seers[1].seat]]);
      ms.forEach((m) => { if (m.kind === 'report' && m.wolf && !pairs.some((p) => p.includes(idx[m.seat]) && p.includes(idx[m.target]))) pairs.push([idx[m.seat], idx[m.target]]); });
      set.pairs = pairs;
      if (pairs.length) {
        camTo(T - 200, 1100, POSE.top());
        pairs.forEach((p, k) => lines.push({ a: p[0], b: p[1], s: T + 500 + k * 350, e: Infinity, c: 'red', round: r }));
        if (seers.length > 1) { kinetic(T + 900, 2300, [{ t: 'TWO SEERS', c: '' }, { t: 'ONE IS LYING', c: 'red' }], { slam: true, blur: 0, dim: .2, cls: 'low' }); T += 3300; } else T += 1900;
      }
    },
    vote(ev) {
      const r = ev.round; scene('vote-' + r, 'DAY ' + ORD[r] + ' · THE VOTE');
      camTo(T, 1300, POSE.wide(PI / 2 - .15));
      kinetic(T + 100, 1300, [{ t: 'THE VOTE', c: 'mono' }, { t: 'BANISH ONE', c: '' }], { blur: 2, slam: true });
      T += 1300;
    },
    votes(ev) {
      const r = ev.round, tally = {}; let k = 0;
      camTo(T, 1000, POSE.top());
      for (const v in ev.votes) { const tg = ev.votes[v]; if (!tg) continue; tally[tg] = (tally[tg] || 0) + 1; lines.push({ a: idx[v], b: idx[tg], s: T + 400 + k * 170, e: Infinity, c: 'bone', round: r, vote: true }); k++; }
      const top = Object.keys(tally).sort((a, b) => tally[b] - tally[a]).slice(0, 3);
      const el = h('tally', top.map((id, n) => '<div class="' + (n === 0 || tally[id] === tally[top[0]] ? 'top' : '') + '"><b>' + tally[id] + '</b>' + short(id) + '</div>').join(''));
      const dT = Array.from(el.children);
      add(T + 1300, T + 3600, (p, t, lt) => { dT.forEach((d, n) => { const a = sat((lt - n * 200) / 300); d.style.opacity = a * sat((2300 - lt) / 300); d.style.transform = 'scale(' + lerp(1.6, 1, eox(a)) + ')'; }); F.dim = Math.max(F.dim, .42 * sat(lt / 300) * sat((2300 - lt) / 300)); F.blur = Math.max(F.blur, 2.5 * sat(lt / 300) * sat((2300 - lt) / 300)); }, el);
      T += 3500;
      if (ev.tie) {
        camTo(T - 300, 1500, POSE.wide(PI / 2 + .2));
        kinetic(T, 2700, [{ t: 'TIE', c: 'xl' }, { t: top.slice(0, 2).map((id) => tally[id]).join(' — '), c: 'sm red' }, { t: 'Nobody burns tonight.', c: 'serif' }], { slam: true }); T += 3000;
      } else {
        const i = idx[ev.banished], nm = short(ev.banished);
        camTo(T - 300, 1200, POSE.seat(i));
        kinetic(T, 1900, [{ t: nm, c: 'xl' }, { t: 'IS BANISHED', c: 'sm' }], { slam: true, blur: 2 });
        deaths.push({ i, t0: T + 1500, t1: T + 3600, role: ev.role });
        add(T, T + 5200, (p) => { F.lit[i] = Math.max(F.lit[i], 1.15 * sat(p * 8)); });
        kinetic(T + 2900, 2200, [{ t: nm + ' WAS', c: 'sm' }, { t: (ev.role === 'VILLAGER' ? 'A ' : ev.role === 'WOLF' ? 'A ' : 'THE ') + ev.role, c: ev.role === 'WOLF' ? 'xl red' : '' }], { slam: true, blur: 1, dim: .2 });
        T += 5300;
      }
      closeRound(r);
    },
    acted(ev) {
      if (openPick) { closePicker(openPick, 0); return; }
      const r = ev.pending.round || 1, dw = { ready: 1300, unseal: 1500, night: r > 1 ? 900 : 1700, move: r > 1 ? 1000 : 1900, vote: r > 1 ? 800 : 1300 }[ev.kind];
      closePicker(openPicker(ev.pending), dw);
    },
    end(ev) {
      scene('end', 'THE END');
      camTo(T, 4500, Object.assign(POSE.wide(PI / 2 + .6), { el: .85, d: 20 }));
      kinetic(T + 300, 4000, [{ t: 'IT IS OVER', c: 'mono' }, { t: 'THE ' + ev.winner, c: '' }, { t: 'WINS', c: 'xl red' }, { t: ev.winner === 'VILLAGE' ? 'Two wolves. Both burned.' : 'The village sleeps forever.', c: 'serif' }], { slam: true, stagger: 260 });
      T += 4400;

      scene('reveal', 'WHO WAS REAL');
      const el = h('reveal', '<h2><small>Now you may know</small>WHO WAS <span class="red">REAL?</span></h2><div class="grid">' + SEATS.map((s) => {
        const ai = ev.kinds[s.id] === 'AI', role = ev.roles[s.id];
        return '<div class="rv ' + (ai ? 'ai' : '') + '"><div class="f" style="background-image:url(\'' + P[s.id].url + '\')"><span>' + short(s.id) + '</span></div><div class="b"><div class="pp" style="background-image:url(\'' + P[s.id].url + '\')"></div>' + (ai ? '<u>NEAR AI · TEE <span class="ok">✓</span></u>' : ev.kinds[s.id] === 'HOUSE' ? '<u>played by the rules</u>' : ev.kinds[s.id] === 'CPU' ? '<u>practice bot</u>' : '') + '<b>' + ev.kinds[s.id] + '</b><em class="' + (role === 'WOLF' ? 'w' : '') + '">' + role + '</em><span>' + short(s.id) + '</span></div></div>';
      }).join('') + '</div><div class="foot"></div>');
      const rv = Array.from(el.querySelectorAll('.rv')), foot = el.querySelector('.foot'), nAI = SEATS.filter((s) => ev.kinds[s.id] === 'AI').length, rd = 1700 + N * 620 + 2600;
      add(T, T + rd, (p, t, lt) => {
        const vis = sat(lt / 500) * sat((rd - lt) / 450); el.style.opacity = vis;
        rv.forEach((d, i) => { const q = eio((lt - 1500 - i * 620) / 720), a = eo((lt - i * 70) / 600); d.style.opacity = a; d.style.transform = 'translateY(' + (1 - a) * 40 + 'px) rotateY(' + q * 180 + 'deg) scale(' + (1 + Math.sin(q * PI) * .12) + ')'; });
        const fq = sat((lt - 1500 - N * 620) / 400); foot.style.opacity = fq; const nH = SEATS.filter((s) => ev.kinds[s.id] === 'HOUSE').length; foot.innerHTML = nAI + ' of ' + N + ' were AI' + (nAI ? ' · every one of their moves was signed inside a TEE <span class="ok">✓</span>' : '') + (nH ? ' · ' + nH + ' played by the house' : '') + (NW.PRACTICE ? ' · practice: the rest were CPU bots' : '');
        F.blur = Math.max(F.blur, 12 * vis); F.dim = Math.max(F.dim, .72 * vis);
      }, el);
      T += rd;

      let f = ev.feature;
      if (!f) { const seat = Object.keys(ev.confessionals || {})[0]; if (seat) { const r = Object.keys(ev.confessionals[seat])[0]; f = { seat, round: +r, at: '' }; } }
      if (f && ev.confessionals[f.seat] && ev.confessionals[f.seat][f.round]) {
        const rc = (ev.receipts || []).find((x) => x.seat === f.seat && x.round === f.round);
        scene('confessional', 'CONFESSIONAL · UNSEALED');
        confessional(T, 12500, f.seat, f.round, f.at, ev.confessionals[f.seat][f.round], rc); T += 12500;
      }

      scene('receipt', 'THE RECEIPT');
      const rel = h('rcpt' + (DIRECTOR ? '' : ' live'), '<div class="roll"><div class="paper">' + receiptHTML(ev) + '</div></div>');
      const roll = rel.querySelector('.roll'), paper = rel.querySelector('.paper'), D = 15000;
      add(T, DIRECTOR ? T + D : Infinity, (p, t, lt) => {
        const u = eio(lt / 1900); rel.style.opacity = sat(lt / 300) * (DIRECTOR ? sat((D - lt) / 500) : 1);
        roll.style.clipPath = 'inset(0 0 ' + ((1 - u) * 100).toFixed(2) + '% 0)';
        if (DIRECTOR) { const max = Math.max(0, paper.offsetHeight - roll.clientHeight + 40); paper.style.transform = 'translateY(' + (-max * ss((lt - 2600) / (D - 4200))).toFixed(1) + 'px)'; }
        F.blur = Math.max(F.blur, 12); F.dim = Math.max(F.dim, .6); F.hudHide = 1;
      }, rel);
      if (DIRECTOR) T += D; else { T += 2500; FINAL = true; }
    },
  };
  function closeRound(r) { lines.forEach((l) => { if (l.round === r && l.e === Infinity) l.e = T; }); cardSets.forEach((s) => { if (s.round === r && s.e === Infinity) s.e = T; }); }
  // ?director=1&cut=trailer : a ~2.5 minute cut (day 1 in full, then Maud's reveal, Hale's banishment, the ending)
  const CUT = DIRECTOR && Q.get('cut') === 'trailer';
  function cutSkip(ev) {
    if (!CUT) return false; const r = ev.round || (ev.pending && ev.pending.round); if (!r) return false;
    const isVote = ev.t === 'vote' || ev.t === 'votes' || (ev.t === 'acted' && ev.kind === 'vote');
    if (r === 1) { if (ev.t === 'votes') closeRound(1); return isVote; }
    if (r === 3) return !(ev.t === 'dawn' || isVote);
    return true;
  }
  function aliveAt(t) { const out = []; for (let i = 0; i < N; i++) if (!deaths.some((d) => d.i === i && d.t0 < t)) out.push(i); return out; }

  function receiptHTML(ev) {
    if (NW.LIVE) return liveReceiptHTML(ev);
    const V = '../../../verify/', nr = ev.near, ex = 'https://testnet.nearblocks.io/txns/';
    const ln = (file, l, label) => '<a href="' + V + file + '#L' + l + '" target="_blank" rel="noopener">' + (label || 'verify/' + file + ':' + l) + '</a>';
    const ok = '<span class="chk">✓</span>';
    let s = '<div class="stampR">Verified ✓</div><h1>The <i>Receipt</i></h1><div class="sub">Nothing on this page asks for your trust. Every line can be checked.</div>' +
      '<div class="kv"><span>game</span><span>' + nr.game + '</span><span>result</span><span>' + ev.winner + ' wins · ' + nr.winners.length + ' winners</span><span>rules</span><span>NEARWOLF · ' + N + ' seats · keeper-dealt</span></div>';
    s += '<h2>1 · Roles match the keeper’s commitment ' + ln('keeper.ts', 59) + '</h2><div class="kv"><span>commitment</span><span>' + ev.commitment + '</span><span>seed (published)</span><span>' + ev.seed + '</span><span>check</span><span>sha256(seed ‖ roles) = commitment ' + ok + ' &nbsp; enclave attestation (AWS Nitro, PCR0) ' + ok + ' ' + ln('nitro.ts', 1, 'verify/nitro.ts') + '</span></div>' +
      '<table><tr><th>seat</th><th>role dealt</th><th>was</th><th></th></tr>' + SEATS.map((x) => '<tr><td>' + x.name + '</td><td class="' + (ev.roles[x.id] === 'WOLF' ? 'w' : '') + '">' + ev.roles[x.id] + '</td><td>' + ev.kinds[x.id] + (ev.kinds[x.id] === 'AI' ? ' · ' + ev.model : '') + '</td><td>' + ok + '</td></tr>').join('') + '</table>';
    s += '<h2>2 · Every AI move, signed in a TEE ' + ln('nearai.ts', 186) + '</h2><div class="kv"><span>signer</span><span>' + ev.receipts[0].signing_address + '</span><span>attestation</span><span>Intel TDX quote + NVIDIA confidential GPU ' + ok + ' ' + ln('nearai.ts', 87) + '</span></div>' +
      '<table><tr><th>day</th><th>seat</th><th>move</th><th>response sha256</th><th>signature</th><th></th></tr>' + ev.receipts.map((r) => '<tr><td>' + r.round + '</td><td>' + short(r.seat) + '</td><td>' + moveText(r.move).toLowerCase() + '</td><td>' + sh(r.response_sha256, 10) + '</td><td>' + sh(r.signature, 12) + '</td><td>' + ok + '</td></tr>').join('') + '</table>';
    s += '<h2>3 · Confessionals, unsealed ' + ln('record.ts', 1, 'verify/record.ts') + '</h2>';
    for (const seat in ev.confessionals) for (const r in ev.confessionals[seat]) s += '<div class="cf"><small>' + SEATS[idx[seat]].name + ' · ' + ev.roles[seat] + ' · night ' + r + ' · sealed in TEE, signature verified ' + ok + '</small><q>' + ev.confessionals[seat][r] + '</q></div>';
    s += '<h2>4 · On NEAR ' + nr.network + ' ' + ln('near.ts', 100) + '</h2><div class="kv"><span>contract</span><span>' + nr.contract + '</span><span>record tx</span><span><a href="' + ex + nr.record_tx + '" target="_blank" rel="noopener">' + nr.record_tx + '</a> ' + ok + '</span><span>payout tx</span><span><a href="' + ex + nr.payout_tx + '" target="_blank" rel="noopener">' + nr.payout_tx + '</a> ' + ok + '</span><span>pot</span><span>' + nr.pot + ' → ' + nr.winners.map(short).join(', ').toLowerCase() + '</span><span>keeper signature</span><span>' + sh(nr.keeper_sig, 40) + ' ' + ok + '</span></div>';
    if (ev.mock !== false) s += '<div class="mock">Scripted demo table: hashes, signatures and transaction ids on this page are stand-ins until the live game stream is connected.</div>';
    return s;
  }

  // The live table's receipt: only what this game actually has. Nothing is marked checked here
  // unless a check ran (an AI receipt's own `verified`).
  function liveReceiptHTML(ev) {
    const nr = ev.near || { winners: [] }, rcp = ev.receipts || [];
    const yes = '<span class="chk">✓</span>', esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    let s = '<h1>The <i>Receipt</i></h1><div class="sub">What this table can show, and what each line rests on.</div>' +
      '<div class="kv"><span>result</span><span>' + ev.winner + ' wins' + (NW.PRACTICE ? ' · practice, nothing at stake' : ' · ' + (nr.winners || []).length + ' winning entrants') + '</span><span>rules</span><span>NEARWOLF · ' + N + ' seats · keeper-dealt · games/nearwolf/rules</span></div>';
    s += '<h2>1 · Who sat where, and what they were</h2><div class="kv"><span>executor</span><span>' + (NW.PRACTICE ? 'This browser (practice): the same rules, dealt with a local secret. Matches are dealt by the Makeo keeper.' : 'Makeo keeper (hidden game): it dealt the roles from its secret and opened every sealed move; it publishes the secret and the moves now the game is over, so the deal replays.') + '</span></div>' +
      '<table><tr><th>seat</th><th>role dealt</th><th>was</th></tr>' + SEATS.map((x) => '<tr><td>' + esc(x.name) + '</td><td class="' + (ev.roles[x.id] === 'WOLF' ? 'w' : '') + '">' + ev.roles[x.id] + '</td><td>' + (ev.kinds[x.id] === 'CPU' ? 'CPU · practice bot' : ev.kinds[x.id] === 'HOUSE' ? 'HOUSE · played by the rules' : ev.kinds[x.id] + (ev.kinds[x.id] === 'AI' ? ' · ' + esc(ev.model) : '')) + '</td></tr>').join('') + '</table>';
    if (rcp.length) {
      s += '<h2>2 · AI moves, signed in a TEE</h2><table><tr><th>day</th><th>seat</th><th>move</th><th>signer</th><th></th></tr>' + rcp.map((r) => '<tr><td>' + r.round + '</td><td>' + short(r.seat) + '</td><td>' + esc(JSON.stringify(r.move)) + '</td><td>' + sh(String(r.signing_address || ''), 10) + '</td><td>' + (r.verified ? yes : 'not verified') + '</td></tr>').join('') + '</table>';
      s += '<h2>3 · Confessionals, unsealed</h2>';
      for (const seat in ev.confessionals) for (const r in ev.confessionals[seat]) s += '<div class="cf"><small>' + esc(SEATS[idx[seat]].name) + ' · ' + ev.roles[seat] + ' · round ' + r + '</small><q>' + esc(ev.confessionals[seat][r]) + '</q></div>';
    } else s += '<h2>2 · AI moves</h2><div class="sub">' + (NW.PRACTICE ? 'Practice: the other seats were the page\'s CPU bots, each playing from its own view.' : 'No NEAR AI actors sat at this table. Empty seats were played by the house: the game rules themselves, inside the keeper, from each seat\'s own role and the public record.') + '</div>';
    s += '<h2>' + (rcp.length ? '4' : '3') + ' · On NEAR ' + esc(nr.network || 'testnet') + '</h2><div class="kv"><span>pot contract</span><span>' + (nr.contract ? esc(nr.contract) : 'not live for this build: free play') + '</span><span>winners</span><span>' + (nr.winners || []).map(short).join(', ').toLowerCase() + '</span></div>';
    return s;
  }

  // ---------- compile ----------
  let consumed = 0;
  function consume(view) {
    if (!OMNI && DIRECTOR) { const e = view.log.find((x) => x.t === 'end'); OMNI = e ? e.kinds : null; }
    for (; consumed < view.log.length; consumed++) {
      const ev = view.log[consumed]; if ((ev.omni && !DIRECTOR) || cutSkip(ev)) continue;
      if (G[ev.t]) G[ev.t](ev);
    }
    if (scenes.length) scenes[scenes.length - 1].end = T;
    if (view.pending && !openPick) openPicker(view.pending);
  }

  // ---------- 3D ----------
  let R, SC, CAM, tableM, light, hemi, spot, flames = [], glow, vault, vaultEdges, vaultSlots = [], smoke = [], portraits = [], envPool = [], roleCards = {}, cardMeshes = new Map(), lineMeshes = new Map(), TEX = {};
  const canvas = (w, hh) => { const c = document.createElement('canvas'); c.width = w; c.height = hh; return c; };
  function tex(c) { const t = new THREE.CanvasTexture(c); t.anisotropy = 8; return t; }
  function cover(g, img, w, hh) { const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height, s = Math.max(w / iw, hh / ih); g.drawImage(img, (w - iw * s) / 2, (hh - ih * s) * .25, iw * s, ih * s); }

  function makeTextures() {
    let c, g, rnd;
    // wood
    c = canvas(1024, 1024); g = c.getContext('2d'); rnd = prng(7); g.fillStyle = '#2a1a10'; g.fillRect(0, 0, 1024, 1024);
    for (let i = 0; i < 16; i++) { g.fillStyle = 'rgba(' + (30 + rnd() * 40 | 0) + ',' + (16 + rnd() * 20 | 0) + ',8,' + (.25 + rnd() * .3) + ')'; g.fillRect(0, i * 64, 1024, 62); }
    for (let i = 0; i < 900; i++) { const y = rnd() * 1024, x = rnd() * 1024, l = 60 + rnd() * 400; g.strokeStyle = 'rgba(' + (rnd() > .5 ? '0,0,0' : '120,80,40') + ',' + (rnd() * .12) + ')'; g.lineWidth = .5 + rnd() * 1.5; g.beginPath(); g.moveTo(x, y); g.bezierCurveTo(x + l * .3, y + rnd() * 6 - 3, x + l * .6, y + rnd() * 6 - 3, x + l, y); g.stroke(); }
    let gr = g.createRadialGradient(512, 512, 120, 512, 512, 560); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,.75)'); g.fillStyle = gr; g.fillRect(0, 0, 1024, 1024);
    g.strokeStyle = 'rgba(233,226,208,.22)'; g.lineWidth = 2; g.beginPath(); g.arc(512, 512, 300, 0, 7); g.stroke(); g.strokeStyle = 'rgba(179,24,15,.5)'; g.lineWidth = 3; g.beginPath(); g.arc(512, 512, 482, 0, 7); g.stroke();
    for (let i = 0; i < N; i++) { const a = ang(i); g.strokeStyle = 'rgba(233,226,208,.12)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(512 + Math.cos(a) * 300, 512 + Math.sin(a) * 300); g.lineTo(512 + Math.cos(a) * 482, 512 + Math.sin(a) * 482); g.stroke(); }
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
    g.fillStyle = '#e9e2d0'; g.font = '500 13px "IBM Plex Mono",monospace'; g.textAlign = 'center'; g.fillText('S E A L E D', 128, 310); TEX.back = tex(c);
    // envelope
    c = canvas(256, 160); g = c.getContext('2d'); g.fillStyle = '#d9d0b8'; g.fillRect(0, 0, 256, 160); g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, 0); g.lineTo(128, 86); g.lineTo(256, 0); g.moveTo(0, 160); g.lineTo(100, 70); g.moveTo(256, 160); g.lineTo(156, 70); g.stroke(); g.fillStyle = '#a3140c'; g.beginPath(); g.arc(128, 84, 22, 0, 7); g.fill(); TEX.env = tex(c);
    // grain tile
    c = canvas(256, 256); g = c.getContext('2d'); rnd = prng(99); const id = g.createImageData(256, 256); for (let i = 0; i < id.data.length; i += 4) { const v = rnd() * 255 | 0; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; } g.putImageData(id, 0, 0); grainEl.style.backgroundImage = 'url(' + c.toDataURL() + ')';
  }
  function faceTex(m) {
    const c = canvas(256, 356), g = c.getContext('2d'); g.fillStyle = '#e4dcc8'; g.fillRect(0, 0, 256, 356); g.strokeStyle = '#14100c'; g.lineWidth = 3; g.strokeRect(12, 12, 232, 332);
    g.fillStyle = '#14100c'; g.textAlign = 'center'; g.font = '600 17px "IBM Plex Mono",monospace'; g.fillText({ report: 'R E P O R T', accuse: 'A C C U S E', vouch: 'V O U C H', claim: 'C L A I M', silent: 'S I L E N T' }[m.kind], 128, 50);
    g.fillRect(40, 64, 176, 2);
    const big = (t, y, col, size) => { g.fillStyle = col; let s = size; g.font = s + 'px Anton,Impact,sans-serif'; while (g.measureText(t).width > 208 && s > 20) { s -= 4; g.font = s + 'px Anton,Impact,sans-serif'; } g.fillText(t, 128, y); };
    if (m.kind === 'report') { big(short(m.target), 160, '#14100c', 76); big(m.wolf ? 'WOLF' : 'NOT WOLF', 248, m.wolf ? '#b3180f' : '#14100c', 76); }
    else if (m.kind === 'silent') { big('—', 210, '#14100c', 90); }
    else { big(m.kind === 'claim' ? m.role : short(m.target), 210, m.kind === 'accuse' ? '#b3180f' : '#14100c', 84); }
    g.fillStyle = '#14100c'; g.fillRect(40, 286, 176, 2); g.font = '26px Anton,Impact,sans-serif'; g.fillText(short(m.seat), 128, 326);
    return tex(c);
  }
  function roleTex(role) {
    const c = canvas(256, 356), g = c.getContext('2d'), w = role === 'WOLF'; g.fillStyle = w ? '#b3180f' : '#0d0b0a'; g.fillRect(0, 0, 256, 356); g.strokeStyle = '#e9e2d0'; g.lineWidth = 3; g.strokeRect(12, 12, 232, 332);
    g.fillStyle = '#e9e2d0'; g.textAlign = 'center'; g.font = '500 15px "IBM Plex Mono",monospace'; g.fillText('W A S', 128, 120); let s = 76; g.font = s + 'px Anton,Impact,sans-serif'; while (g.measureText(role).width > 204) { s -= 4; g.font = s + 'px Anton,Impact,sans-serif'; } g.fillText(role, 128, 215);
    return tex(c);
  }
  function portraitTex(seat) {
    const c = canvas(512, 716), g = c.getContext('2d');
    const draw = (img) => {
      cover(g, img, 512, 716);
      const gr = g.createLinearGradient(0, 470, 0, 716); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(.75, 'rgba(0,0,0,.88)'); g.fillStyle = gr; g.fillRect(0, 470, 512, 246);
      g.strokeStyle = 'rgba(233,226,208,.55)'; g.lineWidth = 4; g.strokeRect(8, 8, 496, 700);
      g.fillStyle = '#e9e2d0'; g.textAlign = 'center'; g.font = '74px Anton,Impact,sans-serif'; g.fillText(short(seat.id), 256, 650); g.font = 'italic 30px "Instrument Serif",Georgia,serif'; g.fillStyle = 'rgba(233,226,208,.75)'; g.fillText(seat.title, 256, 688);
    };
    draw(P[seat.id].img);
    try { g.getImageData(0, 0, 1, 1); } catch (e) { g.clearRect(0, 0, 512, 716); draw(P[seat.id].fallback); } // file:// taints real images for WebGL
    return tex(c);
  }
  const PVS = 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }';
  const PFS = 'precision highp float; uniform sampler2D map; uniform float lit,burn,join,seed; varying vec2 vUv;' +
    'float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}' +
    'float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}' +
    'float fbm(vec2 p){return .5*noise(p)+.25*noise(p*2.1)+.125*noise(p*4.3)+.0625*noise(p*8.7);}' +
    'void main(){ vec4 c=texture2D(map,vUv); vec2 d=min(vUv,1.-vUv); float edge=min(d.x*1.4,d.y)*2.; float n=fbm(vUv*vec2(5.,7.)+seed);' +
    ' float v=edge*.8+n*.55; float thr=burn*1.42-.02; if(burn>0.001 && v<thr) discard;' +
    ' float on=step(0.001,burn); float ember=smoothstep(thr+.10,thr,v)*on; float chr=smoothstep(thr+.34,thr+.08,v)*on;' +
    ' vec3 col=c.rgb*(0.05+lit*1.15); col*=vec3(1.0,.93,.84); col=mix(col,vec3(0.015,0.01,0.008),chr);' +
    ' col+=vec3(1.0,.32,.06)*ember*2.2+vec3(1.,.8,.4)*pow(ember,4.)*1.5; col*=join; gl_FragColor=vec4(col,join); }';

  function build3D() {
    R = new THREE.WebGLRenderer({ canvas: glc, antialias: true, preserveDrawingBuffer: true }); R.setClearColor(0x000000, 1);
    R.toneMapping = THREE.ACESFilmicToneMapping; R.toneMappingExposure = 1.15;
    SC = new THREE.Scene(); SC.fog = new THREE.FogExp2(0x000000, .026); CAM = new THREE.PerspectiveCamera(36, 1, .1, 200);
    makeTextures();
    tableM = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.0, .35, 96), [new THREE.MeshStandardMaterial({ color: 0x1a0f09, roughness: .5 }), new THREE.MeshStandardMaterial({ map: TEX.wood, roughness: .48, metalness: .08 }), new THREE.MeshStandardMaterial({ color: 0x0a0605 })]); SC.add(tableM);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshStandardMaterial({ color: 0x0f0b09, roughness: .95 })); floor.rotation.x = -PI / 2; floor.position.y = -2.4; SC.add(floor);
    hemi = new THREE.HemisphereLight(0x3a2c22, 0x000000, .5); SC.add(hemi);
    light = new THREE.PointLight(0xff9a4d, 60, 80, 1.25); light.position.set(0, 2.1, 0); SC.add(light);
    spot = new THREE.SpotLight(0xfff1dd, 0, 40, .2, .7, 1.1); spot.position.set(0, 12, 0); SC.add(spot); SC.add(spot.target);
    [[90, .75], [210, .5], [330, .95]].forEach((d, k) => {
      const a = d[0] * PI / 180, x = Math.cos(a) * .95, z = Math.sin(a) * .95, hh = d[1];
      const cm = new THREE.Mesh(new THREE.CylinderGeometry(.085, .095, hh, 16), new THREE.MeshStandardMaterial({ color: 0xd9cfb6, emissive: 0x7a3a12, emissiveIntensity: .5, roughness: .7 })); cm.position.set(x, .175 + hh / 2, z); SC.add(cm);
      const f = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX.flame, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })); f.position.set(x, .175 + hh + .2, z); f.userData = { k, base: .175 + hh + .2 }; SC.add(f); flames.push(f);
    });
    glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX.glow, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: .3 })); glow.position.set(0, 1.2, 0); glow.scale.set(11, 11, 1); SC.add(glow);
    // vault (the enclave)
    vault = new THREE.Group(); const box = new THREE.BoxGeometry(1.5, 1.5, 1.5);
    vault.add(new THREE.Mesh(box, new THREE.MeshStandardMaterial({ color: 0x0b0b0c, metalness: .85, roughness: .32 })));
    vaultEdges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: 0xe9e2d0, transparent: true })); vault.add(vaultEdges);
    for (let k = 0; k < 4; k++) { const sl = new THREE.Mesh(new THREE.PlaneGeometry(.9, .05), new THREE.MeshBasicMaterial({ color: 0xff3020, transparent: true })); const a = k * PI / 2; sl.position.set(Math.sin(a) * .76, -.15, Math.cos(a) * .76); sl.rotation.y = a; vault.add(sl); vaultSlots.push(sl); const dl = new THREE.Mesh(new THREE.RingGeometry(.2, .23, 40), new THREE.MeshBasicMaterial({ color: 0xe9e2d0, transparent: true, opacity: .5 })); dl.position.set(Math.sin(a) * .76, .28, Math.cos(a) * .76); dl.rotation.y = a; vault.add(dl); }
    SC.add(vault);
    for (let i = 0; i < 7; i++) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX.smoke, transparent: true, depthWrite: false, opacity: .5, color: 0xc9b9a6 })); SC.add(s); smoke.push(s); }
    const pg = new THREE.PlaneGeometry(2.3, 3.22);
    SEATS.forEach((s, i) => {
      const m = new THREE.Mesh(pg, new THREE.ShaderMaterial({ uniforms: { map: { value: portraitTex(s) }, lit: { value: .4 }, burn: { value: 0 }, join: { value: 0 }, seed: { value: i * 3.7 } }, vertexShader: PVS, fragmentShader: PFS, transparent: true, side: THREE.DoubleSide }));
      const p = sp(i, 6.9); m.position.set(p[0], 1.75, p[1]); SC.add(m); portraits.push(m);
    });
  }
  const cardGeo = () => new THREE.PlaneGeometry(1.2, 1.67);
  function cardMesh(faceT) {
    const outer = new THREE.Group(), inner = new THREE.Group(); outer.add(inner); outer.rotation.x = -PI / 2;
    const f = new THREE.Mesh(cardGeo(), new THREE.MeshBasicMaterial({ map: faceT })); f.position.z = .006;
    const b = new THREE.Mesh(cardGeo(), new THREE.MeshBasicMaterial({ map: TEX.back })); b.rotation.y = PI; b.position.z = -.006; inner.add(f, b);
    outer.userData = { inner, f, b }; SC.add(outer); return outer;
  }
  function lineMesh(l) {
    const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-PI / 2); const red = l.c === 'red';
    const grp = new THREE.Group(), core = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: red ? 0xff2a18 : 0xe9e2d0, transparent: true, opacity: red ? 1 : .6, blending: THREE.AdditiveBlending, depthWrite: false })), halo = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: red ? 0xff2a18 : 0xe9e2d0, transparent: true, opacity: red ? .22 : .06, blending: THREE.AdditiveBlending, depthWrite: false }));
    grp.add(core, halo); grp.userData = { core, halo }; SC.add(grp); return grp;
  }

  // ---------- render(t) ----------
  let lastFilter = '', curT = 0, W = 0, H = 0;
  function resize() {
    W = window.innerWidth; H = window.innerHeight; document.documentElement.style.setProperty('--u', Math.min(W, H * 16 / 9) / 100 + 'px');
    R.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); R.setSize(W, H, false); CAM.aspect = W / H;
  }
  function render(t) {
    curT = t;
    const night = tv('night', t), vlt = tv('vault', t), house = tv('house', t);
    F = { lit: new Array(N).fill(lerp(.55, .13, night)), spot: -1, spotI: 0, blur: 0, dim: 0, shake: 0, hudHide: 0 };
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
    CAM.lookAt(k.lx + sx * .5, k.ly + sy * .5, k.lz);
    // light
    const fl = 1 + .09 * Math.sin(t * .0113) + .05 * Math.sin(t * .0231 + 1.3) + .03 * Math.sin(t * .0477 + .4);
    light.intensity = 300 * fl * lerp(1, .3, night) * house; hemi.intensity = .5 * lerp(1, .45, night) * house;
    glow.material.opacity = .17 * fl * lerp(1, .35, night) * house; glow.scale.setScalar(11 + (fl - 1) * 6);
    flames.forEach((f) => { const q = 1 + .12 * Math.sin(t * .019 + f.userData.k * 2.1) + .06 * Math.sin(t * .041 + f.userData.k); f.scale.set(.26 * house, .62 * q * house, 1); f.position.y = f.userData.base + (q - 1) * .2; f.material.opacity = lerp(1, .55, night); });
    if (F.spot >= 0) { const p = sp(F.spot, 5.6); spot.target.position.set(p[0], .4, p[1]); spot.position.set(p[0] * .6, 11, p[1] * .6); }
    spot.intensity = 260 * F.spotI * house;
    // vault
    vault.visible = vlt > .002; if (vault.visible) { const hum = 1 + .012 * Math.sin(t * .05); vault.scale.setScalar(hum); vault.position.y = .175 + .75 + (1 - eo(vlt)) * 9; vault.rotation.y = t * .00012 + (1 - vlt) * 2; vaultEdges.material.opacity = (.35 + .3 * Math.sin(t * .006)) * vlt; vaultSlots.forEach((s, i) => { s.material.opacity = (.55 + .45 * Math.sin(t * .012 + i)) * vlt; }); }
    // smoke
    smoke.forEach((s, i) => { s.position.set(3.2 * Math.sin(t * 1e-4 * (.6 + i * .13) + i * 2.1), 1.6 + i * .4 + .4 * Math.sin(t * 7e-5 + i), 3.2 * Math.cos(t * 8e-5 * (.7 + i * .1) + i * 1.3)); const sc = 7 + i * 1.2; s.scale.set(sc, sc, 1); s.material.rotation = t * 2.5e-5 * (i % 2 ? 1 : -1) + i; s.material.opacity = .16 * house * lerp(1, .5, night); });
    // portraits
    for (let i = 0; i < N; i++) {
      const m = portraits[i], u = m.material.uniforms, dd = deaths.find((x) => x.i === i), b = dd ? sat((t - dd.t0) / (dd.t1 - dd.t0)) : 0;
      u.join.value = ss((t - joinT[i]) / 1100) * house; u.burn.value = b; u.lit.value = F.lit[i] + (b > 0 && b < 1 ? .5 : 0);
      m.visible = u.join.value > .001 && b < .999; m.quaternion.copy(CAM.quaternion);
      m.position.y = 1.75 + (1 - eo((t - joinT[i]) / 1100)) * .6;
      if (dd && dd.role) {
        let rc = roleCards[i]; if (!rc) { rc = roleCards[i] = new THREE.Mesh(new THREE.PlaneGeometry(.84, 1.17), new THREE.MeshBasicMaterial({ map: roleTex(dd.role), transparent: true })); rc.rotation.x = -PI / 2; const p = sp(i, 4.55); rc.position.set(p[0], .185, p[1]); rc.rotation.z = ang(i) - PI / 2 + PI; SC.add(rc); }
        const q = sat((t - dd.t1 + 300) / 500); rc.visible = q > 0; rc.material.opacity = q; rc.material.color.setScalar(lerp(.75, .3, night)); rc.position.y = .185 + (1 - eo(q)) * 1.2;
      } else if (roleCards[i]) roleCards[i].visible = false;
    }
    Object.keys(roleCards).forEach((i) => { if (!deaths.some((x) => x.i === +i && t > x.t1 - 300)) roleCards[i].visible = false; });
    // envelopes
    flights.forEach((f, n) => {
      let m = envPool[n]; if (!m) { m = envPool[n] = new THREE.Mesh(new THREE.PlaneGeometry(.78, .49), new THREE.MeshBasicMaterial({ map: TEX.env, side: THREE.DoubleSide, transparent: true })); SC.add(m); }
      const p = sat((t - f.t0) / (f.t1 - f.t0)), e = eio(p), vis = t >= f.t0 && (f.land ? t < f.hold + 600 : t < f.t1);
      m.visible = vis; if (!vis) return;
      m.position.set(lerp(f.a[0], f.b[0], e), lerp(f.a[1], f.b[1], e) + Math.sin(p * PI) * 1.5, lerp(f.a[2], f.b[2], e));
      m.rotation.set(-PI / 2 + (1 - e) * .9, 0, (1 - e) * 3 + f.i * .4 + ang(f.i));
      const fade = f.land ? 1 - sat((t - f.hold) / 600) : 1 - sat((p - .8) / .2); m.material.opacity = fade; m.scale.setScalar(f.land ? 1 : lerp(1, .3, p)); m.material.color.setScalar(lerp(.9, .5, night));
    });
    // move cards
    cardSets.forEach((set, si) => set.cards.forEach((cd, ci) => {
      const key = si + ':' + ci; let m = cardMeshes.get(key); const vis = t >= cd.slam && t < set.e;
      if (!m) { if (!vis) return; m = cardMesh(faceTex(cd.m)); cardMeshes.set(key, m); }
      m.visible = vis; if (!vis) return;
      const lt = t - cd.slam, p = sat(lt / 240), q = eio((t - set.flip) / 720), pos = sp(cd.i, 3.55), out = sat((set.e - t) / 400);
      m.position.set(pos[0], .19 + ci * .001 + (1 - p) * (1 - p) * 4.5, pos[1]); m.rotation.z = ((cd.i * 37) % 11 - 5) * .035;
      m.userData.inner.rotation.y = PI * (1 - q); m.userData.inner.position.z = Math.sin(q * PI) * .9; m.scale.setScalar(out * (1 + Math.sin(q * PI) * .15));
      const br = lerp(.95, .4, night); m.userData.f.material.color.setScalar(br); m.userData.b.material.color.setScalar(br);
      if (lt > 240 && lt < 700) F.shake += Math.exp(-(lt - 240) / 110) * .035;
    }));
    // lines
    lines.forEach((l, n) => {
      let m = lineMeshes.get(n); const vis = t >= l.s && t < l.e; if (!m) { if (!vis) return; m = lineMesh(l); lineMeshes.set(n, m); }
      m.visible = vis; if (!vis) return;
      const r = l.vote ? 4.0 : 4.3, a = sp(l.a, r), b = sp(l.b, r), dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz), p = eo((t - l.s) / (l.vote ? 500 : 750)), out = sat((l.e - t) / 300), red = l.c === 'red';
      m.position.set(a[0] + dx * p / 2, .2 + n * .0015, a[1] + dz * p / 2); m.rotation.y = -Math.atan2(dz, dx);
      const pulse = red ? 1 + .25 * Math.sin(t * .008) : 1;
      m.userData.core.scale.set(L * p, 1, (red ? .07 : .035) * out); m.userData.halo.scale.set(L * p, 1, (red ? .5 : .2) * out * pulse);
    });
    // post
    const filt = F.blur > .05 ? 'blur(' + (F.blur * W / 1600).toFixed(2) + 'px)' : 'none'; if (filt !== lastFilter) { lastFilter = filt; glc.style.filter = filt; }
    dimEl.style.opacity = F.dim.toFixed(3);
    const fr = Math.floor(t / 41.667); grainEl.style.backgroundPosition = ((fr * 73) % 256) + 'px ' + ((fr * 151) % 256) + 'px';
    // hud
    let sc = null; for (let i = scenes.length - 1; i >= 0; i--) if (t >= scenes[i].start) { sc = scenes[i]; break; }
    hud.style.opacity = house * (1 - F.hudHide) * (sc && sc.id === 'title' ? 0 : 1);
    const ph2 = sc ? sc.label : ''; if (hudPhase.textContent !== ph2) hudPhase.textContent = ph2;
    const me = 'YOU · ASH<br><b>' + (t >= roleT && myRole ? myRole : 'ROLE SEALED') + '</b>'; if (hudMe._h !== me) { hudMe._h = me; hudMe.innerHTML = me; }
    R.render(SC, CAM);
  }
  const hudPhase = $('#hud-phase'), hudMe = $('#hud-me');

  // ---------- boot ----------
  async function boot(opts) {
    opts = opts || {};
    try { await Promise.race([Promise.all(['96px Anton', 'italic 30px "Instrument Serif"', '500 14px "IBM Plex Mono"', '600 14px Inter'].map((f) => document.fonts.load(f))), new Promise((r) => setTimeout(r, 3000))]); } catch (e) { /* offline: fallbacks */ }
    P = await NW.loadPortraits(SEATS);
    build3D(); resize(); window.addEventListener('resize', () => { resize(); render(curT); });
    adapter = opts.adapter || NW.createMockAdapter({ auto: DIRECTOR });
    adapter.start(consume);

    let manual = Q.has('t'), playT = manual ? +Q.get('t') : 0, last = null, speed = +(Q.get('speed') || 1), paused = false;
    const limit = () => (holdAt != null ? holdAt : FINAL ? T : T);
    function tick(now) {
      let sp = speed;
      // Live: the keeper's clock doesn't wait for the show. When a choice is due, play the beats
      // before it faster so the picker opens with time to spare.
      if (NW.LIVE && NW.deadline) { const behind = limit() - playT, left = NW.deadline - Date.now() - 6000; if (behind > 0) sp = Math.max(speed, Math.min(8, behind / Math.max(left, 400))); }
      if (!manual && !paused && last != null) playT = Math.min(playT + Math.min(now - last, 100) * sp, limit());
      last = now; render(playT); requestAnimationFrame(tick);
    }
    if (DIRECTOR) {
      window.director = {
        duration: T, scenes: scenes.map((s) => ({ id: s.id, start: s.start, end: s.end })),
        seek(ms) { manual = true; playT = Math.max(0, Math.min(ms, T)); render(playT); },
        play() { manual = false; }, get time() { return playT; },
      };
    } else {
      const ctl = $('#ctl'), b = document.createElement('button'); b.textContent = 'Skip ▸▸'; b.title = 'Jump to the next beat';
      b.onclick = () => { const nx = scenes.find((s) => s.start > playT + 50); playT = Math.min(nx ? nx.start : limit(), limit()); };
      ctl.appendChild(b);
      window.addEventListener('keydown', (e) => { if (e.target.tagName === 'INPUT') return; if (e.code === 'Space') { paused = !paused; e.preventDefault(); } if (e.code === 'ArrowRight') b.onclick(); });
    }
    window.nearwolf = { get time() { return playT; }, get end() { return T; }, scenes, seek(ms) { manual = true; playT = ms; render(ms); }, resume() { manual = false; } };
    render(playT); requestAnimationFrame(tick);
    return window.nearwolf;
  }
  NW.boot = boot;
  NW.ready = boot(window.NEARWOLF_BOOT || {});
  if (DIRECTOR) NW.ready.then(() => { window.director.ready = true; });
};

export {};
