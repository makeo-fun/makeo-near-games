# Live run, 2026-11-14 (published build 9 on app-dev)

A free match of NEAR Hold'em at https://near-holdem.games-dev.makeo.fun/ with 4 NEAR AI seats
(agent-actors `actors/src/join.ts`, Qwen/Qwen3.6-35B-A3B-FP8), watched from a signed-in browser.
21 hands to a winner (Juno, 400 chips). 86 AI decisions: every response was TEE-signed (model key
0xfdbd…8ddf) and verified; 84 became the AI's move, 2 fell back to a scripted move because the model's
answer wasn't JSON. The Receipt screen rechecked all 86 signatures and 71/71 card openings in the browser.

| File | What |
|---|---|
| live-ai-showdown.jpg | Hand 1 showdown: Juno A♦10♦ beats Rook A♣3♣ on the kicker (pair of sevens on board) |
| live-ai-midhand.jpg | Mid-hand at blinds 2/4, bets out, table log |
| live-ai-result.jpg | The end: ranking by chips and bust order |
| receipt-deal-commitments.jpg | Receipt 1: every opened card matches its deal-time commitment |
| receipt-ai-signatures.jpg | Receipt 2: AI decisions, private reasoning, signatures rechecked in the browser |
| receipt-settlement.jpg | Receipt 3: winners, chip shares and the final-state hash for NEAR settlement |
| live-receipts.json | The runner's published receipts with request/response evidence (seat names added) |

## A human at the table with NEAR AI agents (later the same day)

A signed-in human joined a live free match from Chrome, alongside two NEAR AI seats (Vega, Rook, via
join.ts) and one platform test seat ("probe"). Joining was blocked until the platform fixed free-entry
signature checking (high-S WebCrypto signatures).

| File | What |
|---|---|
| human-with-ai-seated.jpg | You (human) seated with Vega and Rook (AI · TEE), your own A♥ 4♠ face up, your move |
| human-with-ai-showdown.jpg | Three-way all-in: Rook (AI) wins with queens and eights over two pairs of eights |

## The noir client, live (published build 13)

A signed-in human in Chrome joined a live free match with two NEAR AI seats (Vega, Rook; join.ts, Qwen)
in the noir show engine (client/noir) on the live adapter.

| File | What |
|---|---|
| noir-live-sealed.jpg | Your keeper-dealt cards arrive sealed: break the wax seal to open them |
| noir-live-your-hand.jpg | Your hand face up (A♠ 4♦), the action picker, AI seats' cards sealed |
| noir-live-river.jpg | The river out of the keeper's vault: "revealed card matches the keeper's commitment ✓" with the real hash |
| noir-live-showdown.jpg | "VEGA WINS 8 · Pair of Queens. You held ace high." |
