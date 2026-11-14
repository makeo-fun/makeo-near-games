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
Public URL: `https://dev.makeo.fun/api/near-agents` (clevergcp, `actors/deploy/`). Locally: `PORT=8790 bun actors/src/dispatch.ts`.

A game page calls `POST /seat {project, room, ai}` with `content-type: application/json` once its human has taken their own seat. The dispatcher seats the AI in the background, under their persona names. `GET /status?room=` reports progress. `GET /receipts?room=` returns the receipts once the game is over. `GET /health` reports whether seating is on.

### Security
The dispatcher is public and spends NEAR AI credit. These rules are in `src/dispatch-policy.ts` and `src/dispatch.ts`, and each one is tested in `test/dispatch.test.ts`.
- **Allowlist.** It serves only the NEARWOLF and NEAR Hold'em project ids; any other project is refused. The platform is fixed at `https://app-dev.makeo.fun`, and no URL or host is ever taken from a request (no SSRF). Game code is imported statically, never from a path in the request.
- **Free matches only.** Before seating, it connects and reads the room's live snapshot. It seats only when the room is a free match of that project (`free: true`, zero vault, instance `<project>:live:<room>:free`) that is still `Open`, before its entry deadline, with empty seats. It never seats more AI than there are empty seats. When nobody has entered yet, it keeps one seat free for the human. Agents use throwaway keys and only ever sign the free-entry digest, never a paid entry.
- **Strict input.** The body is at most 1 KB (Caddy also caps it at 4 KB), must be a JSON object, and must use `content-type: application/json`. `room` must be a 64-hex room id, `ai` an integer from 1 to 6, and `game`, if sent, must match `project`. Requests time out (15 s idle; 12 s for the room check). Nothing is passed to a shell, and nothing in a request becomes a file path.
- **Budget.** Global caps: 2 rooms at once, 6 rooms an hour, and 900 NEAR AI moves an hour. Once the move budget is spent, seats keep playing scripted legal moves, and their receipts say why. Per IP: 4 seat requests per 10 minutes and 120 requests a minute. The client IP comes from `CF-Connecting-IP` only when the TCP peer Caddy saw is a Cloudflare edge address; otherwise the peer address is used. Each room is dispatched once (repeat calls return its status), and each room runs for at most 45 minutes. Limits can be lowered with `DISPATCH_*` env vars, but not raised past hard maximums.
- **Kill switch.** Set `DISPATCH_DISABLED=1` and restart: new seat requests get a 503, and live seats switch to scripted moves.
- **CORS.** The `Access-Control-Allow-Origin` header is sent only to `https://nearwolf.games-dev.makeo.fun` and `https://near-holdem.games-dev.makeo.fun`, and credentials are never allowed. A `POST /seat` without one of those origins is refused with 403.
- **No leaks.** `/status` returns only persona names, throwaway wallet addresses and the model name. `/receipts` answers 409 until the game is over, because receipts carry each seat's reasoning and its prompt (which includes that seat's private view). `/health` returns no paths, keys or limits. Errors are generic.
- **Secrets.** `NEAR_AI_API_KEY` comes only from the environment (a mode-600 env file on the VM). It is never logged or returned, and log lines that mention reasoning, prompts or keys are dropped.
- **Deploy.** One bundled file runs in `oven/bun`. The container runs as a non-root user with a read-only filesystem, `cap_drop: ALL`, `no-new-privileges`, and limits of 512 MB of memory, 1 CPU and 128 processes. It has no host network and is published only on `127.0.0.1:18790`, and Caddy is the only way in.

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
