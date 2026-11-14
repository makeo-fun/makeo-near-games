// @ts-nocheck
// Copied from games/holdem/ui/portraits.js (the noir show engine, Fable session snapshot 20:04Z); adapted for the live game where marked LIVE.
/* NEAR HOLD'EM portraits.
 * Real painted portraits: drop  assets/portraits/<id>.webp  (3:4, ~768x1024) and list them in window.HOLDEM_PORTRAITS
 * (ids: you vega rook juno mara silas), e.g.  <script>window.HOLDEM_PORTRAITS = { vega: 'vega.webp' }</script>  before this file.
 * Serve over http (not file://) so WebGL may read them. Until then: generated candle-lit silhouettes (placeholders).
 */
(function () {
  'use strict';
  const HEAD = '<ellipse cx="300" cy="335" rx="92" ry="112"/>';
  const NECK = '<path d="M258 420 L342 420 L352 500 L248 500 Z"/>';
  const BUST = '<path d="M40 800 Q60 560 215 505 Q300 480 385 505 Q540 560 560 800 Z"/>';
  const WIDE = '<path d="M0 800 Q30 540 205 500 Q300 475 395 500 Q570 540 600 800 Z"/>';
  // each: {body: silhouette shapes, extra: lit details drawn on top}
  const CH = {
    you: { // bare head, turned-up collar
      body: HEAD + NECK + BUST + '<path d="M214 520 L236 430 L282 500 Z"/><path d="M386 520 L364 430 L318 500 Z"/><path d="M206 300 Q214 206 300 204 Q388 206 394 300 Q300 262 206 300 Z"/>',
      extra: '',
    },
    vega: { // slicked hair, sharp shoulders, a cigarette ember
      body: HEAD + NECK + '<path d="M0 800 L34 560 L214 498 Q300 478 386 498 L566 560 L600 800 Z"/><path d="M204 318 Q196 206 300 198 Q410 204 398 318 Q372 250 300 244 Q232 250 204 318 Z"/>',
      extra: '<path d="M352 404 L432 420" stroke="#e9e2d0" stroke-width="5" opacity=".6"/><circle cx="436" cy="421" r="6" fill="#ff5a2a"/><path d="M438 410 Q452 370 440 330 Q430 300 446 262" stroke="#cfc4ad" stroke-width="3" fill="none" opacity=".28"/>',
    },
    rook: { // heavy, bearded, flat cap
      body: '<ellipse cx="300" cy="330" rx="98" ry="116"/>' + NECK + WIDE + '<path d="M204 370 Q206 560 300 610 Q394 560 396 370 Q300 450 204 370 Z"/><path d="M196 276 Q206 196 300 192 Q398 196 404 268 L452 286 Q330 262 196 290 Z"/>',
      extra: '',
    },
    juno: { // hair piled high, long earrings
      body: HEAD + NECK + BUST + '<circle cx="300" cy="200" r="58"/><path d="M204 330 Q196 240 300 226 Q404 240 396 330 Q390 420 372 440 L228 440 Q210 420 204 330 Z"/>',
      extra: '<g fill="#e9e2d0" opacity=".6"><rect x="208" y="392" width="4" height="46"/><circle cx="210" cy="444" r="7"/><rect x="388" y="392" width="4" height="46"/><circle cx="390" cy="444" r="7"/></g>',
    },
    mara: { // veil
      body: BUST + '<path d="M300 172 Q160 190 158 400 Q150 530 205 575 L395 575 Q450 530 442 400 Q440 190 300 172 Z"/>',
      extra: '<path d="M214 300 Q300 250 386 300" stroke="#e9e2d0" stroke-width="6" fill="none" opacity=".4"/><path d="M200 330 Q300 420 400 330" stroke="#a3271f" stroke-width="3" fill="none" opacity=".7"/>',
    },
    silas: { // wide-brimmed hat
      body: HEAD + NECK + WIDE + '<ellipse cx="300" cy="266" rx="196" ry="34"/><path d="M212 266 Q218 166 300 164 Q382 166 388 266 Z"/>',
      extra: '<path d="M214 250 L386 250" stroke="#a3271f" stroke-width="10" opacity=".75"/>',
    },
  };

  function svg(id, name) {
    const c = CH[id] || CH[String(name || "").toLowerCase()] || CH.you; // LIVE: seats are wallets; known characters by name
    const seed = id.charCodeAt(0) + id.length * 7;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800" width="600" height="800">' +
      '<defs>' +
      '<radialGradient id="bg" cx="18%" cy="88%" r="105%"><stop offset="0" stop-color="#6b3418"/><stop offset=".38" stop-color="#2a140b"/><stop offset=".8" stop-color="#0b0605"/><stop offset="1" stop-color="#050303"/></radialGradient>' +
      '<radialGradient id="fig" gradientUnits="userSpaceOnUse" cx="60" cy="620" r="520"><stop offset="0" stop-color="#7a4420"/><stop offset=".3" stop-color="#3a1f10"/><stop offset=".62" stop-color="#120a07"/><stop offset="1" stop-color="#040303"/></radialGradient>' +
      '<filter id="paint" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".018 .034" numOctaves="4" seed="' + seed + '"/><feColorMatrix values="0 0 0 0 .9  0 0 0 0 .7  0 0 0 0 .5  .9 .9 .9 0 -.95"/></filter>' +
      '<filter id="weave" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="' + (seed + 3) + '"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 .95  0 0 0 0 .85  .5 .5 .5 0 -.62"/></filter>' +
      '<filter id="soft"><feGaussianBlur stdDeviation="5"/></filter><filter id="soft2"><feGaussianBlur stdDeviation="1.2"/></filter>' +
      '</defs>' +
      '<rect width="600" height="800" fill="url(#bg)"/>' +
      '<rect width="600" height="800" filter="url(#paint)" opacity=".28"/>' +
      '<text x="300" y="640" text-anchor="middle" font-family="Georgia,serif" font-style="italic" font-size="760" fill="#e9e2d0" opacity=".05">' + name[0] + '</text>' +
      '<g transform="translate(-16 5)" fill="#ff9a48" opacity=".55" filter="url(#soft)">' + c.body + '</g>' +
      '<g transform="translate(-6 2)" fill="#ffc98a" opacity=".85" filter="url(#soft2)">' + c.body + '</g>' +
      '<g transform="translate(5 -1)" fill="#7a1711" opacity=".7" filter="url(#soft2)">' + c.body + '</g>' +
      '<g fill="url(#fig)">' + c.body + '</g>' + c.extra +
      '<rect width="600" height="800" filter="url(#weave)" opacity=".5"/>' +
      '</svg>';
  }

  function load(src) {
    return new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
  }

  /** resolves {id: {img, url, fallback, placeholder}} */
  async function loadPortraits(seats) {
    const out = {};
    await Promise.all(seats.map(async (s) => {
      const ph = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg(s.id, s.name));
      const phImg = await load(ph);
      let real = null;
      const m = (window.HOLDEM_PORTRAITS || {})[s.id];
      if (m) real = await load('assets/portraits/' + m);
      out[s.id] = { img: real || phImg, url: real ? real.src : ph, fallback: phImg, placeholder: !real };
    }));
    return out;
  }
  window.HOLDEM = Object.assign(window.HOLDEM || {}, { loadPortraits });
})();
