# Attack it yourself: refused on chain

Real NEAR testnet transactions against `pot.makeo-near.testnet`. Each attack was sent straight to the contract
(skipping the operator's own pre-checks) and **the contract refused it**. The target game is a finished Hold'em
game whose result the Makeo keeper (AWS Nitro enclave) signed:
`795650a8-2999-4971-b388-469c19b9c362:live:d382e6d7fec4d6d16d87f8d4326328dca923b18edaf9e1d9688ad1eb27905e30:free`,
pot opened in `JCgNHKEPWcVXBWBgm3taobN56FnKaBACzN1yJubFfnm8`. Script: [`operator/attacks.ts`](operator/attacks.ts).

| Attack | Transaction | Result |
|---|---|---|
| (a) `enter` with a forged `MakeoNearEntry` signature (Mallory signs for Alice's seat) | `2au4PcFxoPFxzCPRhdX8Rcm1rcmK3SgjDWbu7Dk3TiXv` | refused: `the entry is not signed by this seat` |
| (b) `enter` with Alice's real signature but a different payout account | `6ioDbcCRFsba2jnhDR9S8mRsj6zgR7yeJmEiFdtuUd5x` | refused: `the entry is not signed by this seat` |
| (c) `settle` with the keeper's real signature over a tampered state (the AI winner swapped for Alice) | `HNgPx9DtWRU3Pgi5xCxzppH2jr6oemYzP9F6MJHxSaU6` | refused: `not signed by a registered keeper` |
| (d) `settle` with the real state, signed by a key that is not the registered keeper | `GLQjijNp5dwuNnRrXzg1b9mMQTwKjt5aD55wFPwBbHeb` | refused: `not signed by a registered keeper` |
| honest `settle`: the keeper's signature, the real state | `7tjeL9B7puA5h8bY4x7vwTbZvwaiJq8Tk3XHPkbJN6GU` | **accepted** (the AI seat won, nobody had entered: record stored, nothing paid) |
| (e) a second `settle` on the settled game | `4HXk2GkRoL5YfPXCrmfEzQ4dKoJ5tV2CxkHTKKQFwE5p` | refused: `this game is settled or refunding` |

Open any hash on https://testnet.nearblocks.io/txns/<hash> to see the failure and its panic message.
The same cases run offline in `cargo test` (`enter_refuses_*`, `settle_refuses_*`, `settle_once`).
