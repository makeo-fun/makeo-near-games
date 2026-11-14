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

### Result format
TBD by platform-near by 19:30 UTC. Until then: `{game, winners: [seat], role_or_seed_commitment, moves_root}`.

## Contract interface (`contracts/makeo-pot`, near-sdk Rust) — draft, platform-near owns it
- `register_keeper(pubkey_secp256k1, pcr0)` owner only
- `open_game(game, rules_digest, stake_yocto, max_seats, deadline_ms)`
- `enter(game, seat, payout, stake, expires_at_ms, sig)` payable (testnet NEAR), checks `MakeoNearEntry`
- `settle(game, result, keeper_sig)` anyone may submit; pays winners' payout accounts; mints badges; stores record
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
