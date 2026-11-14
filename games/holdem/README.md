# NEAR Hold'em

No-Limit Texas Hold'em sit-and-go for 2 to 6 players, made on Makeo: humans and AI players at one table, every
hole card dealt by Makeo's keeper (an attested AWS Nitro enclave), every AI decision signed inside
a TEE on NEAR AI Cloud.

| Path | What |
|---|---|
| `rules/src/sitgo.rs` | The contest: a sit-and-go. Everyone pays the same entry and starts with 100 chips; blinds double every 5 hands; it ends when one player holds every chip or after 60 hands, and the chip leader takes the pot. Once finished, the public view carries `winners`, `shares` (final chips) and `state` (the full final rules state) for settlement on NEAR. |
| `rules/src/lib.rs` | One hand: blinds, preflop/flop/turn/river betting, fold/check/call/raise/all-in, the no-limit minimum raise (a short all-in does not reopen betting), side pots, showdown, turn timers (out of time: check if free, else fold). Hand ranking and pot splitting use `makeo_runtime::cards` (`best_five`, `settle`). |
| `rules/tests/rules.rs` | 27 rule tests: evaluator vectors, blinds and action order (heads-up and 3–6 handed), min-raise, short all-ins, side pots, split pots and odd chips, all-in runouts, timeouts, secrecy of folded hands, commitments, 3,000 random hands for chip conservation. |
| `rules/tests/sitgo.rs` | 7 sit-and-go tests, including a paid game that settles and publishes its exact final state (under 50 KB). |
| `rules/tests/table.rs` | 8 tests of the hand engine at a Makeo table (buy-in, deal, showdown history, folds, clock, leaving mid-hand). |
| `client/` | The table page: deep-night table, chunky actions (F / C / R / A keys), staged showdowns, and the **Receipt** screen. |
| `shared/holdem.ts` | The rules' hand view in TypeScript, legal moves, a scripted player, the AI prompt text. |
| `actor.ts` | The AI seat (SPEC "AI actor protocol"): personas, `legalMoves`, `prompt`, `parseMove`, `fallback`. |
| `mock.ts` | A TypeScript stand-in for the rules, for `actors/`' local harness only. |

## How the deal is checked

At the deal, the keeper commits to every hole card and all five board cards:
`commit = SHA-256({"domain":"makeo:holdem:card:v1","value":{"card":n,"salt":s}})`, with a fresh secret
salt per card. The commitments are in every player's view before the first bet. Board cards are
opened (card + salt) as they are turned, each player sees the opening of their own two cards, and
hands that reach a showdown are opened to everyone. **Folded hands are never opened.** The Receipt
screen recomputes every opening in the browser; `commitments_match_the_browser_recomputation` pins
the Rust and browser hashes to the same bytes. The keeper also commits to the table's seed in the
manifest and publishes it when the table closes, so every hand can be replayed with these rules.

## Try it

- Preview (needs a Makeo sign-in): Free play → Practice vs CPU → choose 1–5 opponents. Play to a
  showdown, then **Receipt**.
- Free match with friends / Paid match (test money in preview): open the match, share its invite link,
  join from other tabs, then Start. Add `#autoplay` to a tab's URL (or run `makeoBot(true)` in its
  console) to let that seat play itself.
- AI seats locally: `bun actors/src/harness.ts --game games/holdem --ai 3 --human auto` (scripted
  without `NEAR_AI_API_KEY`; NEAR AI Cloud with it). Receipts land in `actors/receipts/`; open the
  page with `?receipts=<url>` or load the file on the Receipt screen.
- Rule tests: `makeo_test_rules` (Makeo's hosted builder runs the tests, the conformance suite and the ABI check).
