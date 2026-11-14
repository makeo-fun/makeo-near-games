// @ts-nocheck
// Ported as is from games/nearwolf/ui (the noir show engine); type checking is off for this file.
/* NEARWOLF portraits.
 * Real painted portraits: drop  assets/portraits/<id>.webp  (3:4, ~768x1024) and list it in assets/portraits/manifest.js
 * (ids: ash wren corin bram juno hale maud tobias pell). Serve over http (not file://) so WebGL may read them. Until then: generated candle-lit silhouettes (placeholders).
 */
(function () {
  'use strict';
  const HEAD = '<ellipse cx="300" cy="335" rx="92" ry="112"/>';
  const NECK = '<path d="M258 420 L342 420 L352 500 L248 500 Z"/>';
  const BUST = '<path d="M40 800 Q60 560 215 505 Q300 480 385 505 Q540 560 560 800 Z"/>';
  const WIDE = '<path d="M0 800 Q30 540 205 500 Q300 475 395 500 Q570 540 600 800 Z"/>';
  // each: {body: silhouette shapes, extra: lit details drawn on top}
  const CH = {
    ash: {
      body: HEAD + NECK + BUST + '<path d="M192 300 Q200 196 306 200 Q404 206 408 288 L446 304 Q360 282 192 304 Z"/><rect x="494" y="150" width="9" height="650"/><path d="M474 150 L523 150 L514 92 L483 92 Z"/>',
      extra: '<circle cx="498" cy="122" r="60" fill="url(#glow)"/><ellipse cx="498" cy="124" rx="7" ry="15" fill="#ffd9a0"/>',
    },
    wren: {
      body: BUST + '<path d="M300 172 Q160 190 158 400 Q150 530 205 575 L395 575 Q450 530 442 400 Q440 190 300 172 Z"/>',
      extra: '<g stroke="#b9a37c" stroke-width="3" fill="none" opacity=".75"><path d="M120 760 Q150 660 132 590"/><path d="M134 700 q-34 -12 -40 -42"/><path d="M138 660 q30 -14 34 -46"/><path d="M133 625 q-28 -10 -32 -38"/></g>',
    },
    corin: {
      body: HEAD + NECK + WIDE + '<ellipse cx="300" cy="266" rx="196" ry="34"/><path d="M212 266 Q218 166 300 164 Q382 166 388 266 Z"/><path d="M70 800 L128 150 L146 152 L98 800 Z"/><path d="M112 160 Q104 60 142 30 Q170 70 160 164 Z"/>',
      extra: '',
    },
    bram: {
      body: '<ellipse cx="300" cy="330" rx="98" ry="116"/>' + NECK + WIDE + '<path d="M204 370 Q206 560 300 610 Q394 560 396 370 Q300 450 204 370 Z"/>',
      extra: '<g fill="#cfc4ad" opacity=".16"><circle cx="90" cy="250" r="2.5"/><circle cx="140" cy="140" r="2"/><circle cx="480" cy="210" r="2.5"/><circle cx="520" cy="330" r="2"/><circle cx="430" cy="110" r="2"/><circle cx="60" cy="420" r="2"/></g>',
    },
    juno: {
      body: HEAD + NECK + BUST + '<circle cx="300" cy="200" r="58"/><path d="M204 330 Q196 240 300 226 Q404 240 396 330 Q390 420 372 440 L228 440 Q210 420 204 330 Z"/>',
      extra: '<g stroke="#a3271f" stroke-width="2" opacity=".8"><path d="M0 640 L600 700"/><path d="M0 668 L600 742"/><path d="M0 700 L600 660"/></g>',
    },
    hale: {
      body: HEAD + NECK + WIDE + '<ellipse cx="300" cy="258" rx="158" ry="27" transform="rotate(-8 300 258)"/><path d="M222 256 Q236 156 312 162 Q390 172 384 240 Z"/><path d="M236 500 L214 400 L282 470 Z"/><path d="M364 500 L386 400 L318 470 Z"/>',
      extra: '<path d="M372 196 Q430 170 476 78 Q446 150 388 214 Z" fill="#a3271f" opacity=".9"/>',
    },
    maud: {
      body: BUST + '<path d="M300 186 Q182 196 178 340 L128 700 L472 700 L422 340 Q418 196 300 186 Z"/>',
      extra: '<path d="M214 300 Q300 250 386 300" stroke="#e9e2d0" stroke-width="9" fill="none" opacity=".55"/><g fill="#e9e2d0" opacity=".6"><rect x="295" y="600" width="10" height="64"/><rect x="278" y="618" width="44" height="10"/></g>',
    },
    tobias: {
      body: '<g transform="rotate(9 300 500)">' + HEAD + NECK + '<path d="M200 300 L186 214 L226 248 L236 176 L276 232 L306 164 L330 232 L376 184 L378 250 L420 228 L400 310 Z"/></g>' + BUST + '<path d="M452 800 L452 610 Q452 588 466 578 L466 520 L494 520 L494 578 Q508 588 508 610 L508 800 Z"/>',
      extra: '<rect x="466" y="520" width="28" height="10" fill="#b9a37c" opacity=".6"/>',
    },
    pell: {
      body: HEAD + NECK + WIDE + '<path d="M222 262 L222 196 Q184 152 212 104 Q250 56 300 84 Q350 56 388 104 Q416 152 378 196 L378 262 Z"/>',
      extra: '<path d="M222 236 L378 236" stroke="#e9e2d0" stroke-width="3" opacity=".35"/>',
    },
  };

  function svg(id, name) {
    const c = CH[id] || CH.ash;
    const seed = id.charCodeAt(0) + id.length * 7;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800" width="600" height="800">' +
      '<defs>' +
      '<radialGradient id="bg" cx="18%" cy="88%" r="105%"><stop offset="0" stop-color="#6b3418"/><stop offset=".38" stop-color="#2a140b"/><stop offset=".8" stop-color="#0b0605"/><stop offset="1" stop-color="#050303"/></radialGradient>' +
      '<radialGradient id="glow"><stop offset="0" stop-color="#ffb86b" stop-opacity=".9"/><stop offset="1" stop-color="#ffb86b" stop-opacity="0"/></radialGradient>' +
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

  /** resolves {id: {img, url, placeholder}} */
  async function loadPortraits(seats) {
    const out = {};
    await Promise.all(seats.map(async (s) => {
      const ph = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg(s.id, s.name));
      const phImg = await load(ph);
      let real = null;
      const m = (window.NEARWOLF_PORTRAITS || {})[s.id];   // listed in assets/portraits/manifest.js (no 404 probing)
      if (m) real = await load((window.NEARWOLF_PORTRAIT_BASE || '') + 'assets/portraits/' + m);
      out[s.id] = { img: real || phImg, url: real ? real.src : ph, fallback: phImg, placeholder: !real };
    }));
    return out;
  }
  window.NEARWOLF = Object.assign(window.NEARWOLF || {}, { loadPortraits });
})();

export {};
