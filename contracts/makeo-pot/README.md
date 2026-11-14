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
