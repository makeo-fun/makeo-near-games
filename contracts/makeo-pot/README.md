# makeo-pot: Makeo game pots on NEAR

Pots, results and badges for Makeo games, settled **only** on a result signed by the Makeo keeper: an AWS Nitro
enclave that deals every player a private view and runs hidden games. Neither Makeo's operator nor any player can
change who is paid.

## How it works
1. `open_game(game, rules_digest, stake_yocto, max_seats, deadline_ms)`: the operator opens a pot for one keeper
   game (`game` = the keeper's instance id).
2. `enter(game, seat, payout, stake, expires_at_ms, sig)`: the stake is attached, and `sig` is the seat's EVM wallet's
   EIP-712 `MakeoNearEntry(string game,address seat,string payout,uint128 stake,uint64 expiresAtMs)` under
   `{name: "Makeo Games", version: "1", chainId: 398}`. The contract checks it with `env::keccak256` + `env::ecrecover`.
   That binds the seat that plays to the NEAR account that is paid. The operator relays it, so players pay no gas.
3. `settle(game, count, head, state, keeper_sig)`: anyone submits the game's full final state. The contract rebuilds
   exactly what the keeper signed after the last move (see SPEC.md "Result format"):
   `step = sha256({"domain":"makeo:hidden:step:v1","value":{count, head, instance, state: sha256(state)}})`,
   recovers the signer and requires a keeper key the owner registered (with its enclave PCR0, `get_keepers`).
   It reads `finished` and `game.winners` (+ optional `game.shares`) from the signed state, pays the winners' payout
   accounts, mints each a soulbound NEP-245 badge (`makeo:<game>:winner`) and stores the record (`get_record`).
4. `refund(game, seat)`: no result by the deadline → every stake goes back.

## Do X, see Y
```bash
cargo test                                   # 22 unit tests: forged entries, wrong signer, changed state, refunds, badges
cargo near build non-reproducible-wasm       # target/near/makeo_pot.wasm
cd operator && bun install && bun test       # a whole game on a local NEAR sandbox: deploy → enter → settle → paid
cd ../../../verify && bun install && bun test   # the verifiers agree with the contract and the keeper (golden vectors)
NEAR_POT_CONTRACT=<contract> bun verify/near.ts <game> --keeper-url <keeper>   # check a settled game on testnet
```

## Live on NEAR testnet: `pot.makeo-near.testnet`
Keeper registered: `0x03962d2cf414ed532bc8dca6f29818a69dad70d1d104e61305f8d2a1146fe075c2` from enclave image PCR0
`0e70ae798d787f8d88a156fe721bdbfb7b0bb9dc5ce97c394e5114499bd8b358105dbc83e40a9dba658ad8af0ed64078` (`get_keepers`).

| Game (keeper instance) | Players | Settle tx | Paid |
|---|---|---|---|
| Hold'em `795650a8-…:live:09f847d2…:free` | 2 staked humans + 2 AI seats | `DasVfojAm89e4Sz5Xw9nqzWekvbTZ8jqyjLAPe2huoDs` | the chip leader, 0.2 NEAR + badge |
| NEARWOLF `89411bc3-…:live:faa2f7de…:free` | 2 staked humans + 5 AI seats | `H7BcxA4mP3u7xfTVhpGp7ZbvKYYxXzM6FMrwPFsiBDG5` | both entrants on the winning team, 0.1 NEAR each + badge; the AI winners counted out |

Check either yourself, against the chain and the live enclave:
```bash
cd verify && bun install && cd ..
NEAR_POT_CONTRACT=pot.makeo-near.testnet bun verify/near.ts \
  795650a8-2999-4971-b388-469c19b9c362:live:09f847d247323028fcd88c79114071af76879b6573e9de07ac97753f8473f4b1:free \
  --keeper-url https://keeper.makeo.fun
```
It finds the `settle` transaction, rebuilds the state hash and the keeper's step from the state in its arguments,
checks the signer is the registered keeper, and verifies the enclave's live AWS Nitro attestation names that key.
