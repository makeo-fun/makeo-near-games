import { expect, test } from "bun:test";
import { lastCardActor, lastCardGame } from "../src/example-game";
import { MockRoom } from "../src/mock-room";
import { pickPersonas } from "../src/personas";
import { runActors } from "../src/runner";
import type { Inference } from "../src/nearai";
import { ReceiptStore } from "../src/receipts";

test("three scripted AI seats play Last Card to the end in a sealed mock room", async () => {
  const room = await MockRoom.create(lastCardGame, { game: "lastcard", seed: 7 });
  const { outcome, receipts } = await runActors({ game: "lastcard", actor: lastCardActor, personas: pickPersonas(3), transport: room, inference: null, verify: null, timeoutMs: 5000 });
  expect(outcome).toBe("finished");
  expect(receipts.all().length).toBe(9);
  expect(receipts.all().every((r) => r.fallback === "AI off")).toBe(true);
  room.close();
});

test("model moves go through parseMove; reasoning is private until the end; bad answers fall back", async () => {
  let calls = 0;
  const inference: Inference = {
    model: "test-model",
    async complete(prompt) {
      calls++;
      const hand = JSON.parse(prompt.user).your_hand as number[];
      const answer = calls % 4 === 0 ? { move: { play: 99 } } : { move: { play: Math.max(...hand) }, reasoning: "play high", say: "Top card." };
      const request_body = JSON.stringify({ messages: [prompt] });
      const response_body = JSON.stringify({ id: `chat-${calls}`, choices: [{ message: { content: JSON.stringify(answer) } }] });
      return { chat_id: `chat-${calls}`, json: answer, text: JSON.stringify(answer), request_body, response_body };
    },
  };
  const room = await MockRoom.create(lastCardGame, { game: "lastcard", seed: 3 });
  const store = new ReceiptStore();
  const hiddenDuringPlay: boolean[] = [];
  const { outcome, receipts } = await runActors({
    game: "lastcard", actor: lastCardActor, personas: pickPersonas(3), transport: room, inference, timeoutMs: 5000, receipts: store,
    verify: async () => { hiddenDuringPlay.push(store.list().every((r) => r.reasoning === null)); return { verified: true, signature: "0xsig", signing_address: "0xabc", signed_text: "a:b", signer: "model" }; },
  });
  expect(hiddenDuringPlay.every(Boolean)).toBe(true);
  expect(outcome).toBe("finished");
  const all = receipts.all();
  expect(all.length).toBe(9);
  expect(all.filter((r) => r.fallback).length).toBeGreaterThan(0);
  expect(all.filter((r) => !r.fallback).every((r) => r.verified && r.reasoning === "play high" && r.request_sha256?.length === 64)).toBe(true);
  expect(receipts.list().some((r) => r.reasoning)).toBe(true); // published at the end
  expect(room.chat.length).toBeGreaterThan(0);
  room.close();
});

test("the mock room refuses a move signed by the wrong key", async () => {
  const room = await MockRoom.create(lastCardGame, { game: "lastcard", seed: 1, sealed: false });
  const { createSeat } = await import("../src/seat");
  const info = await room.info();
  const seats = [0, 1, 2].map(() => createSeat({ chainId: info.chainId, app: info.app }));
  for (const s of seats) await room.join(s.wallet, s.grant);
  const sig = await seats[1]!.sign("0x00");
  const ack = await room.submit({ id: "x", event: { kind: "Action", actor: seats[0]!.wallet, action: { play: 1 }, session: seats[0]!.grant }, signatures: [sig] });
  expect(ack.accepted).toBe(false);
  room.close();
});
