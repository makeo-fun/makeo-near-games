# Makeo on NEAR — games where AI plays fair

> Every multiplayer game dies the same way: an empty lobby. Fill it with AI? Only if it can't cheat.

[Makeo](https://makeo.fun) turns a description into a hosted multiplayer game. For the NEAR HACKATHON we made Makeo games run on NEAR, and taught them to fill empty seats with **verified AI agents**:

- **Every player, human or agent, is dealt a private view by a hardware enclave** (the Makeo keeper, an AWS Nitro enclave). Each seat sees only its own role or cards — not the other players, not the agents, not us.
- **Every agent move comes from NEAR AI Cloud and is signed inside its TEE** (Intel TDX + NVIDIA confidential GPU). We check each signature against the attested key and publish receipts, including the agent's private reasoning once the game ends.
- **The money lives on NEAR.** Humans stake into a NEAR contract; the enclave signs the final result; the contract checks that signature and pays only the humans. Today agents play without a wallet and are counted out of the pot. Next, we're experimenting with agents that hold their own NEAR accounts.

Two games made this way, live on Makeo's devnet:

| Game | Play | What it shows |
|---|---|---|
| **NEARWOLF** | https://nearwolf.games-dev.makeo.fun/ | Werewolf with humans and AI villagers. AI agents bluff and accuse; roles are sealed per seat; confessionals unseal at the end. |
| **NEAR Hold'em** ("the Glassino") | https://near-holdem.games-dev.makeo.fun/ | No-Limit Hold'em with AI seats. The house is glass, your hand isn't: hole cards sealed to you, every street checked against the keeper's commitments. |

Tracks: **Games With Real Economies** (primary), Privacy & Private AI, Agent Economy, Open Innovation.

## It ran for real (NEAR testnet)

| What | Where |
|---|---|
| Pot contract | [`pot.makeo-near.testnet`](https://testnet.nearblocks.io/address/pot.makeo-near.testnet) — on-chain code hash `F85dRpxHnoy47uXaf1vTyPMSYTBFWjR7w6j294pdLS4w` = sha256 `d1d3ea65…78c0` of `contracts/makeo-pot` |
| Keeper registered (Nitro key + PCR0) | [`4jbUSYHL…`](https://testnet.nearblocks.io/txns/4jbUSYHLAQDG8VrtAvBwYRDc5a3HSnMqMD2gLP5skxCK) — key `0x03962d2c…75c2`, PCR0 `0e70ae79…4078` |
| Paid NEARWOLF match (2 staking test humans + 5 NEAR AI agents) | open [`9oHnQLGP…`](https://testnet.nearblocks.io/txns/9oHnQLGP8ZUEzBhJ6ovq63LfjDS8EgMTtAKKgnNxTyev), entries [`7dkaYjvN…`](https://testnet.nearblocks.io/txns/7dkaYjvNG66GeCX8Lhf4Z1Y3r4mKNs4n2ok6kj5HNCBg) [`DJinPaB3…`](https://testnet.nearblocks.io/txns/DJinPaB3k4GPKK7oK3kaPmFsN1DunJ9udHjzD7E5cfLs), settle [`H7BcxA4m…`](https://testnet.nearblocks.io/txns/H7BcxA4mP3u7xfTVhpGp7ZbvKYYxXzM6FMrwPFsiBDG5): village won, both humans paid 0.1 NEAR, the 4 AI winners counted out. 25/25 AI moves verified. |
| Paid Hold'em match (2 staking test humans + 2 NEAR AI agents) | open [`C9LhkewH…`](https://testnet.nearblocks.io/txns/C9LhkewHhFyBfsmX7Ry9vmY5zuJDY5vNwQWFvyiJMMAP), entries [`EtKHrf6G…`](https://testnet.nearblocks.io/txns/EtKHrf6GRxjNuUaN53UfMqDPirkrCkhsqgx3ELz2v3hE) [`7MA3AmWS…`](https://testnet.nearblocks.io/txns/7MA3AmWSF8FGVvPMHRL6L7m6ELQvk2rzbKYB1bAjT7Pw), settle [`DasVfojA…`](https://testnet.nearblocks.io/txns/DasVfojAm89e4Sz5Xw9nqzWekvbTZ8jqyjLAPe2huoDs): the human chip leader won 0.2 NEAR. 93/93 AI moves verified. |
| NEAR AI | model `deepseek-ai/DeepSeek-V4.1-Flash-1017`, model-enclave signer `0xfe00…337e`; every receipt in `actors/receipts/` |

All values: [`docs/real-values.md`](docs/real-values.md).

## Do X, see Y

```bash
# 1. Check a settled game yourself: finds the settle tx, rebuilds the keeper's signed step,
#    checks the registered keeper and the live Nitro attestation
cd verify && bun install && cd ..
NEAR_POT_CONTRACT=pot.makeo-near.testnet bun verify/near.ts \
  89411bc3-10c6-42ae-b17d-06442dec8b8d:live:faa2f7de6968ba0132a95e19909d9b99befe26f194bfde88d8ba44798b78efff:free \
  --keeper-url https://keeper.makeo.fun
#    → ok

# 2. Contract tests (forged entries, wrong signer, changed state, refunds, AI counted out, badges)
cd contracts/makeo-pot && cargo test          # → 26 passed

# 3. Verifier and actor tests (golden vectors from the keeper and viem; a real NEAR AI signature fixture)
cd verify && bun test && cd ../actors && bun install && bun run test

# 4. Watch AI agents play NEARWOLF locally (scripted moves without a key; real, verified moves with one)
bun actors/src/harness.ts --game games/nearwolf --ai 5
NEAR_AI_API_KEY=… bun actors/src/harness.ts --game games/nearwolf --ai 5 --human auto

# 5. Drop N verified agents into any live Makeo room
bun actors/src/join.ts --game games/holdem --project 795650a8-2999-4971-b388-469c19b9c362 --ai 3
```

## How it fits together

```
 player (human: browser · agent: actors/)          Makeo keeper (AWS Nitro enclave)         NEAR testnet
 ─────────────────────────────────────────          ─────────────────────────────────         ────────────
 EIP-712 GameSession grant → P-256 session key ──▶  deals roles / cards, sealed per seat
 reads OWN sealed view  ◀───────────────────────    runs the game rules (rules.wasm)
 agent: prompt → NEAR AI Cloud (TDX+GPU TEE)
        → signature checked (verify/nearai.ts)
 sealed move ─────────────────────────────────────▶ opens moves, advances the game
 human stake: EIP-712 MakeoNearEntry ──── operator relays ──────────────────────────────▶ pot.enter (ecrecover)
                                                    signs the final state ───── settle ─▶ pot.settle: keeper sig ✓,
                                                                                            pays humans, badges, record
```

- `contracts/makeo-pot/` — the NEAR contract (near-sdk Rust) and the operator that relays entries and settles. [README](contracts/makeo-pot/README.md)
- `actors/` — verified AI players: NEAR AI client, live room transport, `join.ts`, receipts. [README](actors/README.md)
- `verify/` — independent checkers: `nearai.ts` (attestation + per-move signatures), `keeper.ts` and `nitro.ts` (keeper step + Nitro attestation), `near.ts` (on-chain record).
- `games/nearwolf/`, `games/holdem/` — the two Makeo games: rules, clients, the AI actor for each.
- `SPEC.md` — the contracts between the pieces (identity, EIP-712 messages, result format, agent seats).

## Honest notes
- **Testnet only.** Stakes in the paid matches were sponsored testnet NEAR, and the "humans" in those two matches were scripted test seats (no staking button in the browser yet). Real humans have played live free matches with NEAR AI agents in both games.
- **What existed before the hackathon:** the Makeo platform (prompt-to-game, rooms, runtime) and the Makeo keeper enclave. They are private and not in this repo. **Built in the window (Nov 1–14):** everything in this repo — the NEAR contract and operator, the verifiers, the AI actor system, both games — plus the platform's NEAR integration (Privy NEAR wallets, the near-result route, agent seats via free-entry), which lives on private branches of the platform and app.
- Agent moves are verified off-chain (receipts and `verify/nearai.ts`); only the game result and payout are on-chain.
- Trust assumptions: NEAR AI's TEE (Intel, NVIDIA attestation), AWS Nitro for the keeper, and whoever controls the keeper's PCR pins.
- AI-assisted: built with Claude Code; in-game AI runs on NEAR AI Cloud.


