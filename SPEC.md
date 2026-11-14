# makeo-near-games: shared spec (read before you touch anything)

NEAR HACKATHON, Nov 1-14 2026. Submissions close **2026-11-14 23:59 UTC**. Freeze code at **22:30 UTC**.

Pitch: **Makeo makes many games on NEAR.** Two games made on Makeo, NEARWOLF (werewolf) and Hold'em,
with **verified AI actors** (NEAR AI Cloud, TEE-signed) playing next to humans. Every player, human or AI,
gets a **private view sealed by an attested enclave** (the Makeo keeper, AWS Nitro). **Pots, results and
badges live on NEAR.** Tracks: Games With Real Economies, Privacy & Private AI, Agent Economy, Open Innovation.

This repo is public: the game source, the AI actors, the verification code and the NEAR contract.
The Makeo platform (runtime, keeper, Create) stays private; the README says so and links the hosted games.

## Layout and owners (one stream per folder; do not edit another stream's folder)

| Path | Stream | What |
|---|---|---|
| `contracts/makeo-pot/` | 1. platform-near | NEAR contract: pots, keeper-checked settlement, records, NEP-245 badges |
| `verify/near.ts`, `verify/keeper.ts` | 1. platform-near | Check a pot/record on NEAR; check the keeper's signature and attestation |
| `actors/`, `verify/nearai.ts` | 2. agent-actors | The AI actor runner and NEAR AI Cloud verification |
| `games/nearwolf/` | 3. nearwolf | The Makeo game (makeo.toml, rules/, client/, shared/) |
| `games/holdem/` | 4. holdem | The Makeo game |
| `SPEC.md`, `README.md` | coordinator | Change by asking the coordinator session |

Private repos: platform-near also changes `makeo-fun/platform` (and `makeo-fun/app` if needed) on its own branches.

## Ground rules
- **No keeper image change tonight** (it would change PCR0 on the production enclave). Use what the keeper already
  does: hidden games, sealed moves, sealed per-player views, signed outputs, seed published at the end.
- Testnet only. Small amounts. No mainnet transactions without the human's explicit OK.
- Never commit secrets. Keys come from env vars (names below).
- A game must still work with AI actors off (scripted bots) and with the pot off (free play): degrade, never break.

## Identity (unchanged Makeo session model)
- Player logs in with Privy. Their **embedded EVM wallet** signs the EIP-712 `GameSession` grant for a P-256
  session key; the session key signs moves and view requests. This is the seat identity (`0x…`).
- Privy also creates a **NEAR implicit account** for the player (`chain_type: near`), stored as
  `UserWallet { family: "near" }`. Payouts and badges go there.
- An AI actor is just a player: its own EVM key (seat), its own session key, its own NEAR account for payouts.

## EIP-712 messages checked on NEAR (contract uses `env::keccak256` + `env::ecrecover`)
Domain: `{ name: "Makeo Games", version: "1", chainId: 398 }` (398 = NEAR testnet; confirm the value and keep it in one constant).

```
MakeoNearEntry(string game, address seat, string payout, uint128 stake, uint64 expiresAtMs)
```
Signed by the seat's EVM wallet. Binds the seat that plays to the NEAR account that is paid.
Without it anyone could stake for someone else's seat and take their winnings.

## Settlement
The keeper is the only settlement authority: the contract pays only on a result the keeper signed.
platform-near decides the exact bytes **from what the keeper already signs** (its executor signature over the final
step) and documents them here under "Result format". The contract stores the keeper key(s) registered by the owner,
with the PCR0 they came from (public, auditable). No valid result by the deadline → everyone can refund.

### Result format (fixed by platform-near; no keeper change)
The keeper already signs, after every batch of a hidden game, its **step** (`runtime/keeper/src/hidden.ts`, `run`):
```
state_hash = sha256( '{"domain":"makeo:runtime:state:v1","value":' + STATE + '}' )
step       = sha256( '{"domain":"makeo:hidden:step:v1","value":{"count":' + COUNT + ',"head":"' + HEAD + '","instance":' + json(INSTANCE) + ',"state":"' + state_hash + '"}}' )
keeper_sig = secp256k1 sign(step, keeper key), prehash off, low-S, 64 bytes r||s (no recovery byte), hex 0x…
```
- `STATE` is the game's **full** final state (not the room's redacted copy) as canonical JSON: serde_json compact,
  object keys sorted by bytes, integers only (`canonicalJson` in `runtime/feeds/src/fact.ts`). Hashes are `0x` + 64 lowercase hex.
- `INSTANCE` is the keeper instance id = the contract's `game` id. `HEAD`/`COUNT` are the final checkpoint's
  `input_head`/`event_count` (the room's last output, `journal.checkpoint`).
- So `settle(game, count, head, state, keeper_sig)`: the contract rebuilds `state_hash` and `step` from those bytes,
  `ecrecover`s the sig (tries v=0 and v=1) and accepts only a registered keeper key. Then it parses `state` and requires:
  - `state.finished == true` (top level, set by the runtime when the game's `finished()` is true);
  - `state.game.winners`: **an array of seat addresses, lowercase `0x` + 40 hex** (the EVM wallets the keeper/runtime
    use as actors). **Games must put this field in their game state** (it is part of the state hash, so it is signed).
    Empty array = draw (everyone is refunded).
  - Optional `state.game.shares`: integers, same length as `winners`, the pot split by weight (default equal).
- Payout: pot = sum of stakes entered; winners that did not enter get nothing (their weight is dropped); if no winner
  entered, everyone is refunded. Rounding dust goes to the first paid winner. Each paid winner gets a NEP-245 badge.
- **Games: once finished, `redact` returns the game state unredacted** (`fn redact(c, s) { if finished { return to_value(s) } … }`).
  The seed is public at the end anyway. Then the room's last output *is* the full state the keeper hashed, and
  `state_hash(room.state) == journal.checkpoint.state_hash`; the operator checks that before it settles.
- Where the bytes come from: the room's last keeper reply `{output, step, signature}` (the Makeo app keeps step and
  signature for the operator), STATE = canonical JSON of that output's `state`. Fallback for a game that keeps redacting:
  replay the keeper's published history (`GET /hidden/<instance>/history`, after the end) through `rules.wasm`.
  The record stores `{step, state_hash, head, count, winners, keeper}`; the state is in the `settle` call's arguments.
- Size: measured on a NEAR sandbox, `settle` with a 27 KB state burns ~17 Tgas (limit 300), so states up to a few hundred KB fit.

## Contract interface (`contracts/makeo-pot`, near-sdk Rust) — draft, platform-near owns it
- `register_keeper(pubkey_secp256k1, pcr0)` owner only
- `open_game(game, rules_digest, stake_yocto, max_seats, deadline_ms)`
- `enter(game, seat, payout, stake, expires_at_ms, sig)` payable (testnet NEAR), checks `MakeoNearEntry`
- `settle(game, count, head, state, keeper_sig)` anyone may submit (see Result format); pays winners' payout accounts; mints badges; stores record
- `refund(game, seat)` after the deadline if unsettled
- views: `get_game`, `get_record`; NEP-245 `mt_*` for badges

## AI actor protocol (agent-actors owns it; games implement the per-game part)
Per game, `games/<game>/actor.ts` exports:
```ts
export const persona: Persona[]                         // names, voices, play styles
export function legalMoves(view: SeatView): Move[]      // from the seat's own sealed view
export function prompt(view: SeatView, publicLog: Event[], persona: Persona): { system: string; user: string }
export function parseMove(json: unknown, legal: Move[]): Move | null   // null → fall back to a scripted legal move
```
The runner (`actors/`) does: session key → fetch own sealed view → `prompt` → NEAR AI Cloud (JSON output) →
fetch the response signature → verify (`verify/nearai.ts`) → `parseMove` → seal and submit the move → store a receipt:
```
{ game, seat, round, model, chat_id, request_sha256, response_sha256, signature, signing_address, verified, move, reasoning }
```
`reasoning` stays private until the game ends, then is published with the receipts (the Receipt screen reads them).

## Env vars
- `NEAR_AI_API_KEY` (NEAR AI Cloud), `NEAR_AI_MODEL` (a TEE-attested model)
- `NEAR_NETWORK=testnet`, `NEAR_POT_CONTRACT`, `NEAR_OPERATOR_ACCOUNT`, `NEAR_OPERATOR_KEY`
- `MAKEO_PLATFORM_URL` (devnet), makeo CLI login for building and previewing games

## Hackathon rules that bind us
- Repo must be **public** by 23:59 UTC (it starts private; the human flips it).
- README must work for AI screeners: "do X, see Y" steps, links to hosted games, what is pre-hackathon (Makeo
  platform and keeper) vs built in the window (everything in this repo + the NEAR integration).
