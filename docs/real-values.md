# Real testnet values (for the video and README)

All on NEAR testnet. Verified on chain by the coordinator unless marked.

- Pot contract: `pot.makeo-near.testnet` (owner and operator `makeo-near.testnet`)
- Contract code hash on chain: `F85dRpxHnoy47uXaf1vTyPMSYTBFWjR7w6j294pdLS4w` = sha256 `d1d3ea65436800636f9271dc671a36a3c1349a3876f3081688476561fcea78c0` (redeploy tx `GWtL6Zo7mB3cX8DUkGetC4kxsxGWA7L2QyhCMCPwnNph`)
- Keeper registered: tx `4jbUSYHLAQDG8VrtAvBwYRDc5a3HSnMqMD2gLP5skxCK`
  - keeper key (AWS Nitro enclave): `0x03962d2cf414ed532bc8dca6f29818a69dad70d1d104e61305f8d2a1146fe075c2`
  - PCR0: `0e70ae798d787f8d88a156fe721bdbfb7b0bb9dc5ce97c394e5114499bd8b358105dbc83e40a9dba658ad8af0ed64078`
- NEAR AI: model `deepseek-ai/DeepSeek-V4.1-Flash-1017`, signer (model enclave, in the attestation report) `0xfe0071895500a9755c18044948ab4f4e1a7f337e`. Live Hold'em room: 94 of 94 AI moves verified.
- NEARWOLF paid match (settled): game `89411bc3-10c6-42ae-b17d-06442dec8b8d:live:faa2f7de…:free`
  - open_game tx `9oHnQLGP8ZUEzBhJ6ovq63LfjDS8EgMTtAKKgnNxTyev`, stake 0.1 NEAR, 7 seats (2 test humans + 5 NEAR AI agents)
  - entries: `7dkaYjvNG66GeCX8Lhf4Z1Y3r4mKNs4n2ok6kj5HNCBg`, `DJinPaB3k4GPKK7oK3kaPmFsN1DunJ9udHjzD7E5cfLs` (pot 0.2 NEAR)
  - settle tx: `H7BcxA4mP3u7xfTVhpGp7ZbvKYYxXzM6FMrwPFsiBDG5` (see Settled below)
- Hold'em paid match: open `C9LhkewHhFyBfsmX7Ry9vmY5zuJDY5vNwQWFvyiJMMAP`, entries `EtKHrf6GRxjNuUaN53UfMqDPirkrCkhsqgx3ELz2v3hE`, `7MA3AmWSF8FGVvPMHRL6L7m6ELQvk2rzbKYB1bAjT7Pw`; settle `DasVfojAm89e4Sz5Xw9nqzWekvbTZ8jqyjLAPe2huoDs` (see Settled below).
- Live games: https://nearwolf.games-dev.makeo.fun/ and https://near-holdem.games-dev.makeo.fun/
- Note: the "humans" in paid matches tonight are scripted test seats; stakes are sponsored testnet NEAR.

## Settled (both paid matches, NEAR testnet)
- NEARWOLF settle: `H7BcxA4mP3u7xfTVhpGp7ZbvKYYxXzM6FMrwPFsiBDG5`. Winning team 6 seats (2 entrants + 4 AI); the 2 entrants paid 0.1 NEAR each (receipts `13Kb7tAL1HjRY4UfTpVTfu9K8J6LdQXARaCXMvdrKtXR`, `9MzrfhgaLii6axmWFz8TRVpY5V2Vh6yBkATdBTHSw8SN`); the 4 AI winners counted out. Badges minted. 25 of 25 AI moves verified.
- Hold'em settle: `DasVfojAm89e4Sz5Xw9nqzWekvbTZ8jqyjLAPe2huoDs`. Winner entrant `0x9035…e876` paid 0.2 NEAR (receipt `7HFQQARJxt93uAWGaqqdcb9FupGHEUJis36RVkEFvq3c`). Badge minted. 93 of 93 AI moves verified.
- Both verify independently: `NEAR_POT_CONTRACT=pot.makeo-near.testnet bun verify/near.ts <game> --keeper-url https://keeper.makeo.fun`
