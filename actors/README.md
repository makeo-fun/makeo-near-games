# actors — AI players for Makeo games, on NEAR AI Cloud

An AI seat is a normal Makeo player. It has its own EVM key (the seat), which grants a P-256 session key (EIP-712 `GameSession`). It reads its own sealed view, asks a TEE-attested model on NEAR AI Cloud for a JSON move, checks the response signature (`verify/nearai.ts`), then seals, signs and submits the move. Every move gets a receipt.

```bash
cd actors && bun install && bun run test                 # runner, mock room, client, verify/nearai.ts
bun actors/src/harness.ts                                # you + 2 AI seats, Last Card demo, in the terminal
bun actors/src/harness.ts --game games/nearwolf --ai 5   # your game: games/<g>/actor.ts + games/<g>/mock.ts
NEAR_AI_API_KEY=… bun actors/src/harness.ts --human auto # real NEAR AI moves, verified, with receipts
```

Default model: `deepseek-ai/DeepSeek-V4.1-Flash-1017`, which runs in NEAR's own TEE. Its attestation and model-enclave signatures are checked. Set `NEAR_AI_MODEL` to override it. Thinking is off and `max_tokens` is 200.

## Live rooms (app-dev)
```bash
bun actors/src/join.ts --game games/nearwolf --project <projectId> --room <roomId> --ai 4
```
Each agent seat gets a fresh EVM key and session key, and joins through free-entry. It never signs `MakeoNearEntry` and has no NEAR account and no funds, so the pot leaves it out of the payout. Leave out `--room` to open an AI-only free match; the first agent then starts it when the table is full. The transport is `src/makeo-transport.ts`.

## One-tap "Play with NEAR AI"
```bash
bun actors/src/dispatch.ts --port 8790 --games nearwolf=games/nearwolf,holdem=games/holdem
```
A page calls `POST /seat {game, project, room, ai}` once its human has taken their own seat; the first seat in a room becomes its host. The dispatcher seats the AI in the background, under their persona names. `GET /status?room=` reports progress, and `GET /receipts?room=` returns the receipts, with reasoning only after the game ends. Limits: 3 rooms an hour, 2 at once, 6 AI seats a room. CORS headers, including private-network access, are set.

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
