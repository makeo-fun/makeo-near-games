# actors — AI players for Makeo games, on NEAR AI Cloud

An AI seat is a normal Makeo player. It has its own EVM key (the seat), which grants a P-256 session key (EIP-712 `GameSession`). It reads its own sealed view, asks a TEE-attested model on NEAR AI Cloud for a JSON move, checks the response signature (`verify/nearai.ts`), then seals, signs and submits the move. Every move gets a receipt.

```bash
cd actors && bun install && bun run test                 # runner, mock room, client, verify/nearai.ts
bun actors/src/harness.ts                                # you + 2 AI seats, Last Card demo, in the terminal
bun actors/src/harness.ts --game games/nearwolf --ai 5   # your game: games/<g>/actor.ts + games/<g>/mock.ts
NEAR_AI_API_KEY=… bun actors/src/harness.ts --human auto # real NEAR AI moves, verified, with receipts
```

## What a game provides
- `games/<g>/actor.ts`: `persona`, `legalMoves(view)`, `prompt(view, log, persona)`, `parseMove(json, legal)`, as SPEC.md defines them. Optional: `round(view)` and `fallback(view, legal, persona)`. See `src/example-game.ts` (`lastCardActor`), and use `personaPreamble()` for the JSON answer contract `{"move", "reasoning", "say"}`.
- `games/<g>/mock.ts`: `export const mockGame: MockGame`, the rules as a small TypeScript reducer (`seats`, `setup`, `view`, `publicLog`, `apply`, `finished`, optional `tick`). This is for local play only; the real game runs the Rust rules in the keeper.

## Files
| File | What |
|---|---|
| `src/runner.ts` | `ActorSeat` and `runActors`: view, prompt, NEAR AI, verify, parse, seal, submit, receipt. Any failure falls back to a scripted legal move. |
| `src/nearai.ts` | NEAR AI Cloud client. Keeps the exact request and response bytes the signature covers. |
| `../verify/nearai.ts` | Attestation checks (TDX, nonce, compose, RTMR3, NVIDIA) and signature checks, tagged A1–A8 and S1–S4 for the Receipt screen. |
| `src/transport.ts` | `RoomTransport`: the one interface to a room. `MockRoom` (in process) and `HttpTransport` implement it. |
| `src/mock-room.ts` | A local hidden room plus keeper. It checks grants and signatures, opens sealed moves, checks commitments, and can serve over HTTP. |
| `src/seat.ts`, `src/crypto.ts` | Seat identity and the platform's exact digests (cross-checked against `platform/runtime/keeper`). |
| `src/receipts.ts` | Receipts. `reasoning` stays hidden until the game ends; `publish()` then writes `receipts/<instance>.receipts.json`, including the raw bytes. |
| `src/personas.ts` | Six personas: name, voice, style and short lines. |

Receipt: `{game, seat, round, model, chat_id, request_sha256, response_sha256, signature, signing_address, verified, move, reasoning}`. It also carries `signer` (`"model"` or `"gateway"`), `fallback` (why the move was scripted), `say`, `signed_text` and `at_ms`.
