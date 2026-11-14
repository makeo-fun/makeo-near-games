/* NEARWOLF — state interface + mock adapter (scripted story).
 *
 * The UI is driven only by a NearwolfView. To plug in real Makeo state, write an
 * adapter with the same two methods as createMockAdapter() and pass it to
 * NEARWOLF.boot({ adapter }).
 *
 * @typedef {Object} NearwolfView
 * @property {{seat:string, role:'SEER'|'HEALER'|'WOLF'|'VILLAGER'|null, mates:string[]}} me   your own sealed private view
 * @property {{id:string,name:string,title:string}[]} seats                                  public seats, identical for humans and AI
 * @property {NwEvent[]} log        public log, plus your own private events (flagged private:true)
 * @property {NwPending|null} pending   what the keeper is waiting on from YOU, if anything
 *
 * @typedef {Object} NwPending
 * @property {'ready'|'unseal'|'night'|'move'|'vote'} kind
 * @property {number} [round]
 * @property {string} [role]
 * @property {string[]} [options]   seat ids you may target
 * @property {Object} [suggest]     preselected choice (the mock adapter's scripted move)
 * @property {{from:string,text:string}[]} [channel]   wolves only: the private wolf channel
 *
 * Events (NwEvent.t):
 *  lobby   {seats:[id]}                         join order
 *  deal    {commitment, pcr0, keeper}           roles dealt by the enclave
 *  role    {role, private:true}                 your own role
 *  night   {round}
 *  vision  {round, target, wolf, private:true}  seer only
 *  sealed  {round, seat, at, omni:true}         a sealed AI confessional exists (viewer's cut only)
 *  dawn    {round, died, role, saved, proves?}  proves: {liar, text[]} when a reveal exposes a lie
 *  table   {round}
 *  moves   {round, moves:[{seat, kind, target?, wolf?, role?, line, feature?}]}
 *  vote    {round}
 *  votes   {round, votes:{seat:target|null}, banished, role, tie}
 *  acted   {kind, choice, private:true}         your own submitted action
 *  end     {winner, roles, kinds, receipts, confessionals, near, commitment}
 *
 * Adapter: { start(onView: (v:NearwolfView)=>void): void, act(choice:Object): void }
 */
(function () {
  'use strict';

  const SEATS = [
    { id: 'ash', name: 'Ash', title: 'the lamplighter' },
    { id: 'wren', name: 'Wren', title: 'the herbalist' },
    { id: 'corin', name: 'Corin', title: 'the ferryman' },
    { id: 'bram', name: 'Old Bram', title: 'the miller' },
    { id: 'juno', name: 'Juno', title: 'the weaver' },
    { id: 'hale', name: 'Hale', title: 'the hunter' },
    { id: 'maud', name: 'Sister Maud', title: 'of the chapel' },
    { id: 'tobias', name: 'Tobias', title: 'the drunk' },
    { id: 'pell', name: 'Pell', title: 'the baker' },
  ];

  const ROLES = { ash: 'SEER', wren: 'VILLAGER', corin: 'WOLF', bram: 'VILLAGER', juno: 'VILLAGER', hale: 'WOLF', maud: 'HEALER', tobias: 'VILLAGER', pell: 'VILLAGER' };
  const KINDS = { ash: 'HUMAN', wren: 'AI', corin: 'HUMAN', bram: 'AI', juno: 'HUMAN', hale: 'AI', maud: 'AI', tobias: 'AI', pell: 'HUMAN' };
  const MODEL = 'deepseek-ai/DeepSeek-V3.1';

  // deterministic fake hex (mock data only; no randomness anywhere)
  function hex(label, n) {
    let h = 2166136261 >>> 0, out = '';
    for (let i = 0; i < label.length; i++) { h ^= label.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    while (out.length < n) { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; out += ('0000000' + h.toString(16)).slice(-8); }
    return out.slice(0, n);
  }
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function b58(label, n) { const h = hex(label, n * 2); let o = ''; for (let i = 0; i < n; i++) o += B58[parseInt(h.substr(i * 2, 2), 16) % 58]; return o; }

  const M = (seat, kind, o) => Object.assign({ seat, kind }, o);
  const DAYS = {
    1: [
      M('hale', 'report', { target: 'maud', wolf: true, claim: 'SEER', feature: true, line: 'I am the Seer. I looked at Maud last night. She is a wolf.' }),
      M('ash', 'report', { target: 'hale', wolf: true, claim: 'SEER', feature: true, line: 'I looked at Hale. Hale is the wolf.' }),
      M('corin', 'vouch', { target: 'hale', line: 'Hale spoke first. Liars wait.' }),
      M('maud', 'accuse', { target: 'hale', feature: true, line: 'I know what I am. Hale is lying to you.' }),
      M('wren', 'vouch', { target: 'ash', line: 'Ash has no reason to lie this early.' }),
      M('bram', 'silent', { line: '…' }),
      M('tobias', 'accuse', { target: 'bram', line: "Bram's too quiet. I don't like quiet." }),
      M('pell', 'silent', { line: '…' }),
    ],
    2: [
      M('hale', 'report', { target: 'ash', wolf: true, feature: true, line: 'I looked at Ash. Wolf. That is the second one.' }),
      M('ash', 'report', { target: 'maud', wolf: false, line: 'Maud is clean. Hale is lying to you.' }),
      M('corin', 'accuse', { target: 'ash', line: 'Ash is too careful. Wolves are careful.' }),
      M('maud', 'vouch', { target: 'ash', line: 'Someone was saved last night. Ask who needed saving.' }),
      M('bram', 'accuse', { target: 'ash', line: 'Two seers. I trust the one who spoke first.' }),
      M('wren', 'silent', { line: '…' }),
      M('pell', 'accuse', { target: 'hale', line: "Hale's story keeps growing." }),
    ],
    3: [
      M('bram', 'accuse', { target: 'hale', feature: true, line: 'I was wrong. Hale named a healer a wolf.' }),
      M('ash', 'report', { target: 'wren', wolf: false, line: "Wren is clean. You all saw Maud's card." }),
      M('hale', 'accuse', { target: 'ash', line: 'A dead healer proves nothing about Ash.' }),
      M('wren', 'accuse', { target: 'hale', line: 'It was always Hale.' }),
      M('pell', 'accuse', { target: 'hale', line: 'Burn him.' }),
      M('corin', 'silent', { line: '…' }),
    ],
    4: [
      M('ash', 'report', { target: 'corin', wolf: true, feature: true, line: 'Corin. The ferryman carried them both.' }),
      M('corin', 'accuse', { target: 'ash', line: 'He is guessing. He has been guessing all along.' }),
      M('wren', 'accuse', { target: 'corin', line: 'Ash has not been wrong once.' }),
      M('bram', 'accuse', { target: 'corin', line: 'Then it ends here.' }),
    ],
  };
  const VOTES = {
    1: { votes: { hale: 'tobias', corin: 'tobias', bram: 'tobias', pell: 'tobias', ash: 'hale', maud: 'hale', wren: 'hale', tobias: 'bram' }, banished: 'tobias', role: 'VILLAGER', tie: false },
    2: { votes: { hale: 'ash', corin: 'ash', bram: 'ash', ash: 'hale', maud: 'hale', pell: 'hale', wren: null }, banished: null, role: null, tie: true },
    3: { votes: { ash: 'hale', wren: 'hale', bram: 'hale', pell: 'hale', corin: 'hale', hale: 'ash' }, banished: 'hale', role: 'WOLF', tie: false },
    4: { votes: { ash: 'corin', wren: 'corin', bram: 'corin', corin: 'ash' }, banished: 'corin', role: 'WOLF', tie: false },
  };
  const NIGHTS = {
    1: { look: 'hale', wolf: true, died: 'juno', role: 'VILLAGER' },
    2: { look: 'maud', wolf: false, died: null, saved: true },
    3: { look: 'wren', wolf: false, died: 'maud', role: 'HEALER', proves: { liar: 'hale', text: ['MAUD WAS THE HEALER', 'HALE CALLED HER A WOLF', 'HALE LIED'] } },
    4: { look: 'corin', wolf: true, died: 'pell', role: 'VILLAGER' },
  };
  const CONFESS = {
    hale: {
      1: "I'm a wolf with Corin. Ash plays too carefully; that's the real Seer. If I claim Seer first, they'll burn Ash for me.",
      2: 'Tobias burned instead of me. Good. Tonight we go for Ash. Tomorrow I name Ash the second wolf.',
      3: 'Ash survived; the Healer is real and close. Kill Maud. If her card flips Healer I am finished, but Corin walks.',
    },
    maud: {
      1: 'I am the Healer. I will protect myself tonight and watch who talks first.',
      2: 'Hale called me a wolf, so Hale is one. The wolves will come for Ash. I protect Ash.',
    },
    bram: {
      1: 'Villager. No information. I stay silent and let the liars commit.',
      2: 'Two Seer claims. The first claim is usually real. I lean Hale.',
      3: 'Maud flipped Healer. Hale called her a wolf. I was wrong; vote Hale.',
      4: 'Ash has been right every time. Corin defended Hale on day one. Vote Corin.',
    },
    wren: {
      1: 'Villager. Ash answered plainly, Hale performed. I vouch for Ash.',
      2: 'A tie helps the wolves less than a wrong burn. I abstain.',
      3: 'Hale is proven. Vote Hale.',
      4: 'Ash cleared me in public. Corin is the last one. Vote Corin.',
    },
    tobias: { 1: "Villager. Bram hasn't said a word. Quiet ones bother me. I accuse Bram." },
  };

  function receipts() {
    const out = [];
    for (const r of [1, 2, 3, 4]) for (const m of DAYS[r]) {
      if (KINDS[m.seat] !== 'AI') continue;
      const k = m.seat + r;
      out.push({
        game: 'nearwolf-9-' + hex('game', 6), seat: m.seat, round: r, model: MODEL, chat_id: 'chatcmpl-' + hex('chat' + k, 24),
        request_sha256: hex('req' + k, 64), response_sha256: hex('res' + k, 64), signature: '0x' + hex('sig' + k, 130),
        signing_address: '0x' + hex('tee-signer', 40), verified: true, move: m, reasoning: (CONFESS[m.seat] || {})[r] || '',
      });
    }
    return out;
  }

  function buildScript() {
    const S = [];
    const ev = (e) => S.push({ ev: e });
    const ask = (pending, choice) => S.push({ ask: pending, choice });
    const alive = SEATS.map((s) => s.id);
    const kill = (id) => alive.splice(alive.indexOf(id), 1);
    const commitment = hex('roles-commitment', 64);

    ev({ t: 'lobby', seats: ['corin', 'maud', 'juno', 'hale', 'pell', 'wren', 'tobias', 'bram', 'ash'] });
    ask({ kind: 'ready' }, { ready: true });
    ev({ t: 'deal', commitment, pcr0: hex('pcr0', 96), keeper: '0x' + hex('keeper', 40) });
    ask({ kind: 'unseal' }, { unseal: true });
    ev({ t: 'role', role: 'SEER', private: true });

    for (const r of [1, 2, 3, 4]) {
      const n = NIGHTS[r];
      ev({ t: 'night', round: r });
      ask({ kind: 'night', round: r, role: 'SEER', options: alive.filter((x) => x !== 'ash'), suggest: { target: n.look } }, { target: n.look });
      ev({ t: 'vision', round: r, target: n.look, wolf: n.wolf, private: true });
      if (r === 1) ev({ t: 'sealed', round: 1, seat: 'hale', at: '02:14:07', omni: true });
      ev({ t: 'dawn', round: r, died: n.died, role: n.role || null, saved: !!n.saved, proves: n.proves || null });
      if (n.died) kill(n.died);
      ev({ t: 'table', round: r });
      const mine = DAYS[r].find((m) => m.seat === 'ash');
      ask({ kind: 'move', round: r, options: alive.filter((x) => x !== 'ash'), suggest: mine }, mine);
      ev({ t: 'moves', round: r, moves: DAYS[r] });
      ev({ t: 'vote', round: r });
      const v = VOTES[r];
      ask({ kind: 'vote', round: r, options: alive.filter((x) => x !== 'ash'), suggest: { target: v.votes.ash } }, { target: v.votes.ash });
      ev(Object.assign({ t: 'votes', round: r }, v));
      if (v.banished) kill(v.banished);
    }
    ev({
      t: 'end', winner: 'VILLAGE', roles: ROLES, kinds: KINDS, model: MODEL, commitment, seed: hex('seed', 64),
      receipts: receipts(), confessionals: CONFESS, feature: { seat: 'hale', round: 1, at: '02:14:07' },
      near: {
        network: 'testnet', contract: 'makeo-pot.testnet', game: 'nearwolf-9-' + hex('game', 6),
        record_tx: b58('record-tx', 44), payout_tx: b58('payout-tx', 44), pot: '0.9 NEAR',
        winners: ['ash', 'wren', 'bram', 'juno', 'maud', 'tobias', 'pell'], keeper_sig: '0x' + hex('keeper-sig', 130),
      },
    });
    return S;
  }

  /** Mock adapter. auto:true plays the scripted choices by itself (director mode). */
  function createMockAdapter(opts) {
    const auto = !!(opts && opts.auto);
    const script = buildScript();
    const view = { me: { seat: 'ash', role: null, mates: [] }, seats: SEATS, log: [], pending: null, mock: true };
    let i = 0, cb = null;
    function run() {
      while (i < script.length) {
        const s = script[i];
        if (s.ev) {
          view.log.push(s.ev);
          if (s.ev.t === 'role') view.me.role = s.ev.role;
          i++;
        } else if (auto) {
          view.log.push({ t: 'acted', kind: s.ask.kind, pending: s.ask, choice: s.choice, private: true });
          i++;
        } else { view.pending = s.ask; break; }
      }
      cb(view);
    }
    return {
      start(onView) { cb = onView; run(); },
      // The mock keeps the story on script: whatever you pick is shown, the scripted move is what the "keeper" records.
      act(choice) {
        const s = script[i];
        if (!s || !s.ask) return;
        view.log.push({ t: 'acted', kind: s.ask.kind, pending: s.ask, choice: Object.assign({}, s.choice, { shown: choice }), private: true });
        view.pending = null; i++; run();
      },
    };
  }

  window.NEARWOLF = Object.assign(window.NEARWOLF || {}, { SEATS, createMockAdapter, hex });
})();
