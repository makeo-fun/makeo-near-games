// The live transport's digests and sealing, checked against the app's and keeper's own code (read-only imports).
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { freeEntryDigest, openView, viewRequestDigestV2 } from "../src/makeo-transport";
import { createSeat } from "../src/seat";

const APP = `${process.env.HOME}/projects/makeo/app-near/src/worker/free-matches.ts`;
const KEEPER = `${process.env.HOME}/projects/makeo/platform/.claude/worktrees/near-devnet-c0f46d/runtime/keeper/src`;
const have = existsSync(APP) && existsSync(`${KEEPER}/hidden.ts`);

test.skipIf(!have)("free entry: the app's checkFreeEntry accepts our seat", async () => {
  const app = await import(APP);
  const projectId = "0f0e0d0c-0b0a-0908-0706-050403020100";
  const seat = createSeat({ chainId: 398, app: `create-${projectId}` });
  expect(freeEntryDigest("room1", seat.wallet)).toBe(app.freeEntryDigest("room1", seat.wallet));
  const { public_key, signature } = await seat.sign(freeEntryDigest("room1", seat.wallet));
  const checked = app.checkFreeEntry("room1", { wallet: seat.wallet, grant: seat.grant, public_key, signature }, { chainId: 398, app: `create-${projectId}` });
  expect(checked).toEqual({ wallet: seat.wallet.toLowerCase() });
});

test.skipIf(!have)("view v2: same digest as the keeper, and we open what the keeper seals", async () => {
  // near-devnet's hidden.ts has no node_modules here: use the platform's hashValue with the domain and
  // fields its viewRequestDigest(…, replyKey) hashes (hidden.ts: "makeo:keeper:view:v2" {instance, wallet, at_ms, reply_key}).
  const { hashValue } = await import(`${process.env.HOME}/projects/makeo/platform/runtime/feeds/src/fact.ts`);
  const hidden = { viewRequestDigest: (i: string, w: string, a: number, k: string) => hashValue("makeo:keeper:view:v2", { instance: i, wallet: w, at_ms: a, reply_key: k }) };
  expect(await Bun.file(`${KEEPER}/hidden.ts`).text()).toContain('hashValue("makeo:keeper:view:v2", { instance, wallet: wallet.toLowerCase(), at_ms: atMs, reply_key: replyKey.toLowerCase() })');
  const sealing = await import(`${KEEPER}/sealing.ts`);
  const reply = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const replyKey = `0x${Buffer.from(await crypto.subtle.exportKey("raw", reply.publicKey)).toString("hex")}`;
  const wallet = "0x" + "ab".repeat(20);
  expect(viewRequestDigestV2("p:live:r", wallet, 123, replyKey)).toBe(hidden.viewRequestDigest("p:live:r", wallet, 123, replyKey));
  const sealed = await sealing.sealView(replyKey, "p:live:r", wallet, 123, { role: "seer", hand: [1, 2] });
  expect(await openView(reply.privateKey, "p:live:r", wallet, 123, sealed)).toEqual({ role: "seer", hand: [1, 2] });
});

test.skipIf(!have)("sealed moves: the keeper opens what we seal", async () => {
  const sealing = await import(`${KEEPER}/sealing.ts`);
  const { seal } = await import("../src/crypto");
  const keys = await sealing.sealingKeys();
  const sealed = await seal(keys.publicHex, "p:live:r", { action: { series: "start" }, nonce: "00ff" });
  expect(await sealing.open(keys.pair.privateKey, "p:live:r", sealed)).toEqual({ action: { series: "start" }, nonce: "00ff" });
});
