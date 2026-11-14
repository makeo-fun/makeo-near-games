// @ts-nocheck
// Copied from games/holdem/ui/story.js (the noir show engine, Fable session snapshot 20:04Z); adapted for the live game where marked LIVE.
/* NEAR HOLD'EM — state interface + mock adapter (one scripted hand).
 *
 * The UI is driven only by a HoldemView. To plug in real Makeo state (games/holdem/client, games/holdem/shared),
 * write an adapter with the same two methods as createMockAdapter() and boot with it:
 *   <script>window.HOLDEM_BOOT = { adapter: myMakeoAdapter };</script>   (before app.js)
 *
 * Cards are two characters: rank (2-9, T, J, Q, K, A) + suit (s h d c), e.g. 'As', 'Td'.
 *
 * @typedef {Object} HoldemView
 * @property {{seat:string, hole:string[]|null}} me          your own sealed private view
 * @property {{id:string,name:string,title:string}[]} seats  public seats, identical for humans and AI (index = seat position)
 * @property {HEvent[]} log        the public table log, plus your own private events (flagged private:true)
 * @property {HPending|null} pending   what the keeper is waiting on from YOU, if anything
 *
 * @typedef {Object} HPending
 * @property {'fill'|'unseal'|'act'} kind
 * @property {number} [joined] @property {number} [max]              fill: lobby counts
 * @property {string} [street] @property {number} [toCall] @property {number} [pot] @property {number} [stack]
 * @property {number} [bet]     chips you already have in front of you this street
 * @property {number} [minTo] @property {number} [maxTo]             legal raise-to range (maxTo = all-in)
 * @property {Object} [suggest] preselected choice, e.g. {kind:'raise', to:8}
 *
 * Events (HEvent.t):
 *  lobby    {joined, max, stake}                    humans who staked
 *  fill     {agents}                                empty seats filled with verified agents; the keeper shuffles the seats
 *  hand     {button, sb, bb, blinds:[sb,bb], stacks:{seat:chips}}
 *  deal     {deck_commitment, pcr0, keeper}         hole cards dealt and sealed by the enclave
 *  hole     {cards:[c,c], private:true}             your own cards
 *  action   {street, seat, kind:'post'|'fold'|'check'|'call'|'bet'|'raise'|'allin', amount, to, pot, stack, label?, feature?, receipt?}
 *             amount = chips added by this action, to = seat's total this street, pot/stack = after the action.
 *             receipt (the NEAR AI TEE receipt) is present only when the table chooses to show it during play
 *             (viewer's cut); otherwise receipts arrive with `end`, so seats stay indistinguishable.
 *  street   {name:'flop'|'turn'|'river', cards:[c…], commitments:[hex…]}   revealed by the keeper
 *  made     {hand, line, private:true}              your own hand strength, from your private view
 *  sealed   {seat, street, at, omni:true}           a sealed AI reasoning exists (viewer's cut only)
 *  acted    {kind, pending, choice, private:true}   your own submitted action
 *  showdown {hands:{seat:[c,c]}, rank:{seat:string}, best:{seat:[c×5]}, winners:[seat], pots:[{amount, eligible:[seat], winners:[seat]}]}
 *  end      {kinds, model, receipts, cards, deck_commitment, seed, near, feature}
 *
 * Adapter: { start(onView: (v:HoldemView)=>void): void, act(choice:Object): void }
 */
(function () {
  'use strict';

  const SEATS = [
    { id: 'you', name: 'You', title: 'the newcomer' },
    { id: 'vega', name: 'Vega', title: 'the shark' },
    { id: 'rook', name: 'Rook', title: 'the stone' },
    { id: 'juno', name: 'Juno', title: 'the gambler' },
    { id: 'mara', name: 'Mara', title: 'the widow' },
    { id: 'silas', name: 'Silas', title: 'the old hand' },
  ];
  const KINDS = { you: 'HUMAN', vega: 'AI', rook: 'AI', juno: 'AI', mara: 'HUMAN', silas: 'AI' };
  const MODEL = 'DeepSeek V4.1 Flash', MODEL_ID = 'deepseek-ai/DeepSeek-V4.1-Flash';
  const STACK = 200, SB = 1, BB = 2;

  // deterministic fake hex (mock data only; no randomness anywhere)
  function hex(label, n) {
    let h = 2166136261 >>> 0, out = '';
    for (let i = 0; i < label.length; i++) { h ^= label.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    while (out.length < n) { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; out += ('0000000' + h.toString(16)).slice(-8); }
    return out.slice(0, n);
  }
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function b58(label, n) { const h = hex(label, n * 2); let o = ''; for (let i = 0; i < n; i++) o += B58[parseInt(h.substr(i * 2, 2), 16) % 58]; return o; }

  // The hand. You are on the button; Vega is the small blind, Rook the big blind.
  // [seat, kind, to?, {feature, why}]   why = the AI's private reasoning (sealed until the hand ends)
  const HAND = {
    preflop: [
      ['vega', 'post', 1, { label: 'SMALL BLIND 1' }],
      ['rook', 'post', 2, { label: 'BIG BLIND 2' }],
      ['juno', 'call', 2, { why: 'Cheap price, six seats, any two cards can flop something. I limp.' }],
      ['mara', 'call', 2],
      ['silas', 'fold', 0, { why: 'Eight-three offsuit. There is no version of this hand I want to play. Fold.' }],
      ['you', 'raise', 8, { ask: true }],
      ['vega', 'raise', 26, { feature: true, why: 'The button opened into two limpers; that range is wide. I have K♣ Q♣. Re-raise from the small blind and take the lead.' }],
      ['rook', 'fold', 0, { why: 'A raise and a re-raise in front of me. Jack-eight is not in my range. Fold.' }],
      ['juno', 'call', 26, { why: 'Already in, the pot is big, and I want to see a flop. Call.' }],
      ['mara', 'call', 26],
      ['you', 'call', 26, { ask: true }],
    ],
    flop: [
      ['vega', 'bet', 70, { feature: true, why: 'Top pair with a queen kicker, but two spades are out there. Bet big now and make the draws pay.' }],
      ['juno', 'fold', 0, { why: 'No pair, no draw. Even I let this one go.' }],
      ['mara', 'call', 70],
      ['you', 'call', 70, { ask: true }],
    ],
    turn: [
      ['vega', 'allin', 104, { feature: true, why: "Two spades on board and they just called. I'll represent the set; a big shove folds most flushes-in-waiting." }],
      ['mara', 'fold', 0],
      ['you', 'call', 104, { ask: true }],
    ],
    river: [],
  };
  const BOARD = { flop: ['Kd', '7s', '2s'], turn: ['9s'], river: ['4h'] };
  const HOLE = { you: ['As', 'Ks'], vega: ['Kc', 'Qc'] };
  const FEATURE = { seat: 'vega', street: 'turn', at: '21:14:07' };

  function buildScript(omni) {
    const S = [], receipts = [];
    const ev = (e) => S.push({ ev: e });
    const ask = (pending, choice) => S.push({ ask: pending, choice });
    const game = 'holdem-6-' + hex('game', 6);
    const stack = {}, bet = {}; SEATS.forEach((s) => { stack[s.id] = STACK; bet[s.id] = 0; });
    let pot = 0;

    ev({ t: 'lobby', joined: 2, max: 6, stake: '0.5 NEAR' });
    ask({ kind: 'fill', joined: 2, max: 6, stake: '0.5 NEAR' }, { fill: true });
    ev({ t: 'fill', agents: 4, model: MODEL });
    ev({ t: 'hand', button: 'you', sb: 'vega', bb: 'rook', blinds: [SB, BB], stacks: Object.assign({}, stack) });
    const deck = hex('deck-commitment', 64);
    ev({ t: 'deal', deck_commitment: deck, pcr0: hex('pcr0', 96), keeper: '0x' + hex('keeper', 40) });
    ask({ kind: 'unseal' }, { unseal: true });
    ev({ t: 'hole', cards: HOLE.you, private: true });

    for (const street of ['preflop', 'flop', 'turn', 'river']) {
      if (street !== 'preflop') {
        SEATS.forEach((s) => { bet[s.id] = 0; });
        const cards = BOARD[street];
        ev({ t: 'street', name: street, cards, commitments: cards.map((c, k) => hex('commit-' + street + k, 64)) });
        if (street === 'turn') ev({ t: 'made', hand: 'THE NUT FLUSH', line: 'A♠ K♠ and three spades on the board. Nothing beats you.', private: true });
      }
      let high = Math.max.apply(null, SEATS.map((s) => bet[s.id]));
      for (const [seat, kind, to, o0] of HAND[street]) {
        const o = o0 || {};
        const amount = kind === 'fold' || kind === 'check' ? 0 : to - bet[seat];
        if (o.ask) {
          const toCall = high - bet[seat], maxTo = bet[seat] + stack[seat];
          ask({ kind: 'act', street, toCall, pot, stack: stack[seat], bet: bet[seat], minTo: Math.min(maxTo, Math.max(high * 2, BB * 2)), maxTo, suggest: { kind, to } }, { kind, to });
        }
        stack[seat] -= amount; pot += amount; if (amount) bet[seat] = to; high = Math.max(high, bet[seat]);
        const e = { t: 'action', street, seat, kind, amount, to: bet[seat], pot, stack: stack[seat] };
        if (o.label) e.label = o.label; if (o.feature) e.feature = true;
        if (KINDS[seat] === 'AI' && kind !== 'post') {
          const k = seat + '-' + street + '-' + receipts.filter((r) => r.seat === seat).length;
          const rc = {
            game, seat, round: street, model: MODEL, model_id: MODEL_ID, chat_id: 'chatcmpl-' + hex('chat' + k, 24),
            request_sha256: hex('req' + k, 64), response_sha256: hex('res' + k, 64), signature: '0x' + hex('sig' + k, 130),
            signing_address: '0x' + hex('tee-signer', 40), verified: true, move: { kind, amount, to: bet[seat] }, reasoning: o.why || '',
          };
          receipts.push(rc);
          if (omni) { e.receipt = Object.assign({}, rc); delete e.receipt.reasoning; }   // reasoning stays sealed until the end
        }
        ev(e);
        if (seat === FEATURE.seat && street === FEATURE.street && kind === 'allin') ev({ t: 'sealed', seat, street, at: FEATURE.at, omni: true });
      }
    }
    ev({
      t: 'showdown', hands: { vega: HOLE.vega, you: HOLE.you }, rank: { vega: 'Top pair, kings', you: 'Nut flush, ace high' },
      best: { you: ['As', 'Ks', '9s', '7s', '2s'], vega: ['Kc', 'Kd', 'Qc', '9s', '7s'] }, winners: ['you'],
      pots: [{ amount: pot, eligible: ['you', 'vega'], winners: ['you'] }],
    });
    // card commitments: every card slot was committed at the deal; only revealed slots are ever opened
    const cards = [];
    const slot = (label, card, status) => cards.push({ label, commitment: hex('commit-' + label, 64), salt: card ? hex('salt-' + label, 32) : null, card: card || null, status });
    SEATS.forEach((s) => [0, 1].forEach((j) => {
      const c = HOLE[s.id] && HOLE[s.id][j];
      slot(s.name + ' · hole ' + (j + 1), c, c ? (s.id === 'you' ? 'sealed to you, shown at showdown' : 'shown at showdown') : 'folded · never revealed');
    }));
    ['flop', 'turn', 'river'].forEach((st) => BOARD[st].forEach((c, k) => slot(st + (BOARD[st].length > 1 ? ' ' + (k + 1) : ''), c, 'revealed by the keeper')));
    const acct = (id) => hex('near-account-' + id, 64);
    ev({
      t: 'end', kinds: KINDS, model: MODEL, model_id: MODEL_ID, receipts, cards, deck_commitment: deck, seed: hex('seed', 64), feature: FEATURE,
      near: {
        network: 'testnet', contract: 'makeo-pot.testnet', game, stake: '0.5 NEAR', pot: '1.0 NEAR',
        open_tx: b58('open-tx', 44),
        entries: [{ seat: 'you', account: acct('you'), stake: '0.5 NEAR', tx: b58('enter-you', 44) }, { seat: 'mara', account: acct('mara'), stake: '0.5 NEAR', tx: b58('enter-mara', 44) }],
        out: ['vega', 'rook', 'juno', 'silas'],
        settle_tx: b58('settle-tx', 44), payout: { seat: 'you', account: acct('you'), amount: '1.0 NEAR' }, keeper_sig: '0x' + hex('keeper-sig', 130),
      },
    });
    return S;
  }

  /** Mock adapter. auto:true plays the scripted choices by itself (director mode). omni:true attaches TEE receipts to AI actions during play (viewer's cut). */
  function createMockAdapter(opts) {
    const auto = !!(opts && opts.auto), omni = !!(opts && opts.omni);
    const script = buildScript(omni);
    const view = { me: { seat: 'you', hole: null }, seats: SEATS, log: [], pending: null, mock: true };
    let i = 0, cb = null;
    function run() {
      while (i < script.length) {
        const s = script[i];
        if (s.ev) {
          view.log.push(s.ev);
          if (s.ev.t === 'hole') view.me.hole = s.ev.cards;
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
      // The mock keeps the hand on script: whatever you pick is shown, the scripted move is what the "keeper" records.
      act(choice) {
        const s = script[i];
        if (!s || !s.ask) return;
        view.log.push({ t: 'acted', kind: s.ask.kind, pending: s.ask, choice: Object.assign({}, s.choice, { shown: choice }), private: true });
        view.pending = null; i++; run();
      },
    };
  }

  window.HOLDEM = Object.assign(window.HOLDEM || {}, { SEATS, createMockAdapter, hex });
})();
