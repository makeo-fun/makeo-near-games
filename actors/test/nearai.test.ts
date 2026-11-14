import { expect, test } from "bun:test";
import { extractJson, NearAiClient } from "../src/nearai";

test("extractJson tolerates think blocks, fences and chatter", () => {
  expect(extractJson('{"move":1}')).toEqual({ move: 1 });
  expect(extractJson('<think>hmm {no}</think>\n```json\n{"move":{"play":3}}\n```')).toEqual({ move: { play: 3 } });
  expect(extractJson('Sure! {"move":2,"say":"hi"} done')).toEqual({ move: 2, say: "hi" });
  expect(extractJson("no json")).toBeNull();
});

test("the client sends the exact bytes it keeps, with the headers signatures need", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const reply = JSON.stringify({ id: "chatcmpl-abc", choices: [{ message: { content: '{"move":{"play":9},"reasoning":"x"}' } }] });
  const client = new NearAiClient({ apiKey: "k", model: "Qwen/Qwen3.6-35B-A3B-FP8", fetch: (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(reply); }) as never });
  const out = await client.complete({ system: "s", user: "u" });
  expect(seen!.url).toBe("https://cloud-api.near.ai/v1/chat/completions");
  expect(seen!.init.body).toBe(out.request_body);
  expect((seen!.init.headers as Record<string, string>)["x-no-aliasing"]).toBe("true");
  expect(JSON.parse(out.request_body).response_format).toEqual({ type: "json_object" });
  expect(out.response_body).toBe(reply);
  expect(out.chat_id).toBe("chatcmpl-abc");
  expect(out.json).toEqual({ move: { play: 9 }, reasoning: "x" });
});
