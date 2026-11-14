# Makeo on NEAR: games where AI plays fair

**Two live multiplayer games where verified NEAR AI agents fill the empty seats, every player (human or agent) gets a private view from a hardware enclave, and the pot settles on NEAR only on that enclave's signature.**

Play: **[NEARWOLF](https://nearwolf.games-dev.makeo.fun/)** (werewolf) · **[NEAR Hold'em](https://near-holdem.games-dev.makeo.fun/)** (poker, "the Glassino") · Contract: [`pot.makeo-near.testnet`](https://testnet.nearblocks.io/address/pot.makeo-near.testnet) · Tracks: Games With Real Economies (primary), Privacy & Private AI, Agent Economy, AI Security & Defense

## The problem

Social games need a full table. Werewolf needs seven to nine players; poker needs four to six. At 1 a.m. you have two. Filling seats with bots is easy; filling them with bots **you can trust with a pot** is not: a bot run by the house can peek at hidden cards, be steered to throw a hand, or be the house itself.

[Makeo](https://makeo.fun) is a platform where a prompt becomes a hosted multiplayer game. For this hackathon we taught it to fill empty seats with **AI agents that can bluff, but can't cheat**, and to settle on NEAR, so every game made on Makeo can do both. NEARWOLF and NEAR Hold'em are the proof.

## Judges: start here

| Step | Do this | You should see |
|---|---|---|
| 1 | Open a settled game on NearBlocks: [NEARWOLF settle `H7BcxA4m…`](https://testnet.nearblocks.io/txns/H7BcxA4mP3u7xfTVhpGp7ZbvKYYxXzM6FMrwPFsiBDG5) | The contract checked the enclave's signature, paid the two humans 0.1 NEAR each, minted their NEP-245 badges, and paid nothing to the four AI agents on the winning team |
| 2 | Open [`contracts/makeo-pot/ATTACKS.md`](contracts/makeo-pot/ATTACKS.md) | Five real attack transactions the contract refused on chain (forged entry, swapped payout, tampered result, wrong signer, double settle), next to the one honest settle it accepted |
| 3 | Run `./verify.sh` (no keys, no funds) | Every AI move re-verified offline; both settled games re-verified against the chain and the live enclave attestation |
| 4 | Play [NEAR Hold'em](https://near-holdem.games-dev.makeo.fun/) or [NEARWOLF](https://nearwolf.games-dev.makeo.fun/) and open a free match | A live table; after a hand, the in-browser Receipt rechecks every card reveal against the enclave's commitment and every AI signature |

```bash
git clone https://github.com/makeo-fun/makeo-near-games && cd makeo-near-games

./verify.sh      # everything below in one go: a PASS/FAIL table, "Everything checks out.", about 10 s (needs bun; cargo for the contract tests)

bun verify/receipts.ts actors/receipts/*.receipts.json
#   → every NEAR AI move: request/response hashes, signed text, signer recovery, signer in the attestation report
#   → 215/215 verified across the 4 recorded live games, 0 fallbacks; prints each game's receipts Merkle root

cd verify && bun install && cd ..
NEAR_POT_CONTRACT=pot.makeo-near.testnet bun verify/near.ts \
  89411bc3-10c6-42ae-b17d-06442dec8b8d:live:faa2f7de6968ba0132a95e19909d9b99befe26f194bfde88d8ba44798b78efff:free \
  --keeper-url https://keeper.makeo.fun
#   → finds the settle tx on chain, rebuilds the enclave's signed step, checks the registered keeper key,
#     and checks the live AWS Nitro attestation names that key (PCR0 0e70ae79…); prints "ok"

cd contracts/makeo-pot && cargo test     # → 26 passed (forged entries, wrong signer, tampered state, refunds, AI counted out)
```

## Built on Makeo: one prompt, a verifiable game

Both games were made the way any Makeo game is made: an AI coding agent works through Makeo's tools (MCP or CLI), and the platform builds, tests, hosts and settles. The shape of it:

```text
"make werewolf for 9 players where AI agents can take empty seats, settled on NEAR"
  → makeo_create      scaffold: rules (Rust → WebAssembly), client, AI actor, manifest
  → makeo_build       Makeo's hosted builder compiles the rules and checks the game contract
  → makeo_playtest    rule tests and simulated matches in the cloud
  → makeo_publish     a hosted, multiplayer game at <name>.games-dev.makeo.fun
```

What the platform gives every game, so the game itself stays small:

| Makeo provides | What it means for a game |
|---|---|
| Hosted rooms and a real-time runtime | Multiplayer, matchmaking and turn clocks without a server of your own |
| **Hidden games** (`hidden = true`) | The keeper enclave deals secrets, opens sealed moves and gives each seat only its own view |
| **Agent seats** (new for NEAR) | Any empty seat can be filled by a verified NEAR AI agent, from one command or one tap |
| **Pots and settlement** (NEAR is new) | Stakes, payouts and receipts; Makeo already settles on EVM chains and Solana, and now on NEAR |
| Receipts | Every game can show who was human, what each agent saw and said, and how to check it |

NEARWOLF's rules are about 1,300 lines of Rust and Hold'em's about 2,000, tests included. Everything else above is platform.

## What is real, today

| Claim | Evidence | Status |
|---|---|---|
| Humans play live with NEAR AI agents | Free matches on both games; agents join with no wallet and no account (`actors/src/join.ts`) | **Live** on Makeo devnet |
| Every agent move is NEAR AI, signed in a TEE | 215/215 receipts verified (`verify/receipts.ts`); model `deepseek-ai/DeepSeek-V4.1-Flash-1017`, model-enclave signer `0xfe00…337e` | **Live** |
| Each seat sees only its own role/cards | The Makeo keeper (AWS Nitro enclave) seals each seat's view to that seat's key; folded cards are never revealed | **Live** |
| Stakes and payouts on NEAR, settled only on the enclave's signature | Two paid matches settled (table below); five attacks refused (ATTACKS.md) | **Testnet** |
| AI agents are counted out of the pot | NEARWOLF: 4 AI winners got nothing; an all-AI win refunds every human (`cargo test`) | **Testnet** |
| Stakers in the two paid matches | Scripted test seats with sponsored testnet NEAR (no staking button in the browser yet); the live free matches were played by real people | Disclosed |

## NEAR at a glance

| NEAR piece | How we use it | Where |
|---|---|---|
| **NEAR smart contract** (near-sdk, Rust) | Pots, entries, keeper-checked settlement, refunds, game records | `contracts/makeo-pot/src/lib.rs` |
| **NEAR AI Cloud** (private inference in Intel TDX + NVIDIA confidential GPU) | Every agent decision; we check the attestation report and each response signature | `actors/src/nearai.ts`, `verify/nearai.ts` |
| **Signatures checked on NEAR** (`env::keccak256` + `env::ecrecover`) | Players' EIP-712 `MakeoNearEntry` (seat ↔ NEAR payout account) and the enclave's secp256k1 signature on the final state | `contracts/makeo-pot/src/proof.rs` |
| **NEP-245 multi-token** | A winner badge per settled game (`makeo:<game>:winner`) | `contracts/makeo-pot` |
| **NEAR implicit accounts** | Every player gets a NEAR account through Privy at login; payouts land there | platform integration (private) |
| **Relayed transactions** | An operator relays entries and settles, so players never pay gas | `contracts/makeo-pot/operator/` |

## Paid matches on testnet

| Game | Open | Entries | Settle | Outcome |
|---|---|---|---|---|
| NEARWOLF: 2 staking test seats + 5 NEAR AI agents | [`9oHnQLGP…`](https://testnet.nearblocks.io/txns/9oHnQLGP8ZUEzBhJ6ovq63LfjDS8EgMTtAKKgnNxTyev) | [`7dkaYjvN…`](https://testnet.nearblocks.io/txns/7dkaYjvNG66GeCX8Lhf4Z1Y3r4mKNs4n2ok6kj5HNCBg), [`DJinPaB3…`](https://testnet.nearblocks.io/txns/DJinPaB3k4GPKK7oK3kaPmFsN1DunJ9udHjzD7E5cfLs) | [`H7BcxA4m…`](https://testnet.nearblocks.io/txns/H7BcxA4mP3u7xfTVhpGp7ZbvKYYxXzM6FMrwPFsiBDG5) | Village won; both humans paid 0.1 NEAR; 4 AI winners counted out; 25/25 AI moves verified |
| Hold'em: 2 staking test seats + 2 NEAR AI agents | [`C9LhkewH…`](https://testnet.nearblocks.io/txns/C9LhkewHhFyBfsmX7Ry9vmY5zuJDY5vNwQWFvyiJMMAP) | [`EtKHrf6G…`](https://testnet.nearblocks.io/txns/EtKHrf6GRxjNuUaN53UfMqDPirkrCkhsqgx3ELz2v3hE), [`7MA3AmWS…`](https://testnet.nearblocks.io/txns/7MA3AmWSF8FGVvPMHRL6L7m6ELQvk2rzbKYB1bAjT7Pw) | [`DasVfojA…`](https://testnet.nearblocks.io/txns/DasVfojAm89e4Sz5Xw9nqzWekvbTZ8jqyjLAPe2huoDs) | The human chip leader won the 0.2 NEAR pot; 93/93 AI moves verified |

Keeper registration (enclave key + PCR0): [`4jbUSYHL…`](https://testnet.nearblocks.io/txns/4jbUSYHLAQDG8VrtAvBwYRDc5a3HSnMqMD2gLP5skxCK). Deployed code hash `F85dRpxH…` = sha256 `d1d3ea65…` of this repo's contract build. Every value: [`docs/real-values.md`](docs/real-values.md).

## How it works

```
 player (human: browser · agent: actors/)           Makeo keeper (AWS Nitro enclave)         NEAR testnet
 EIP-712 session grant → P-256 session key ──▶      deals roles / cards, sealed per seat
 reads its OWN sealed view  ◀──────────────────     runs the game rules
 agent: own view + public log → NEAR AI Cloud (TEE) → signature checked → move
 sealed move ──────────────────────────────────▶    opens moves, advances the game
 human stake: EIP-712 MakeoNearEntry ──── relayed ─────────────────────────────────────▶ enter (ecrecover)
                                                    signs the final state ───── settle ─▶ keeper sig ✓ → pay humans,
                                                                                            badges, record
```

1. **Private views.** The keeper, an attested AWS Nitro enclave, deals each seat's secret (a role, two cards) sealed to that seat's own key. Agents get exactly what a human in that seat would; nothing else. The keeper commits to every card before the deal and reveals only what the rules allow.
2. **Verified agents.** An agent seat is a normal player with a throwaway key. It sends its own view plus the public log to NEAR AI Cloud, checks the response signature against the attested signer, plays a legal move, and keeps a receipt (including its private reasoning, published after the game).
3. **Settlement on NEAR.** When the game ends the enclave signs the full final state. Anyone can submit it; `pot.makeo-near.testnet` rebuilds what was signed, checks the registered keeper key, and pays only seats that staked.

## The two games

**NEARWOLF:** werewolf for any number of humans and agents. Roles are dealt by the enclave; discussion is structured moves (claim, report a vision, accuse, vouch), so humans and agents act on equal terms; agents bluff and frame; after the game everyone sees who was human and reads each agent's sealed reasoning. `games/nearwolf/`

**NEAR Hold'em ("the Glassino"):** no-limit Hold'em sit-and-go in a glass 3D room. "The house is glass, your hand isn't": hole cards sealed to you, every street checked against the enclave's commitments, every agent decision signed. `games/holdem/`

## Next: agents with their own NEAR accounts

Today agents play without money. Next, each agent holds its own NEAR account: it pays for its own inference and can stake in pots under limits its owner signs. That is the "swarm for hire" idea from [Illia's 4 November post](https://x.com/ilblackdragon/status/2118027843980366222), applied to games. Also next: mainnet, and a staking button in the browser.

## Repository

| Path | What |
|---|---|
| `contracts/makeo-pot/` | The NEAR contract, its operator, tests and ATTACKS.md |
| `actors/` | Verified AI players: NEAR AI client, live room transport, `join.ts`, published receipts |
| `verify/` | Independent checkers: `receipts.ts`, `nearai.ts`, `near.ts`, `keeper.ts`, `nitro.ts` |
| `games/nearwolf/`, `games/holdem/` | The two games: rules, clients, each game's AI actor |
| `SPEC.md` | The interfaces between the pieces |

## Built in the window, and before it

Built during the hackathon (Nov 1–14): everything in this repository (the contract and operator, the verifiers, the AI actor system, both games) and Makeo's NEAR integration (NEAR wallets at login, agent seats, the signed-result route). Before the hackathon: the Makeo platform itself and the keeper enclave, which remain private. Agent moves are verified off-chain against NEAR AI's attestation; only results and payouts are on-chain. Trust assumptions: NEAR AI's TEE (Intel, NVIDIA) and AWS Nitro for the keeper. Built with Claude Code; in-game AI runs on NEAR AI Cloud.
