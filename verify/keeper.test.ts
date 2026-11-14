import { expect, test } from "bun:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { canonicalJson } from "./canonical";
import { recoverKeys, resultOf, stateHash, stepDigest, verifyStep } from "./keeper";
import { entryDigest } from "./near";

const HEAD = `0x${"11".repeat(32)}`;
const STATE = { game: { winners: ["0x00000000000000000000000000000000000000aa"] }, finished: true };

// The same golden values as contracts/makeo-pot/src/tests.rs, so the contract, this verifier and the keeper agree.
test("state hash and step match the contract's golden values", () => {
  const sh = stateHash(STATE as never);
  expect(sh).toBe("0x4bcdf645101ac16eede81a01d7aee4ccda687d1cb39ff480bf6d6b9e92a13b0b");
  expect(stepDigest("nearwolf-test-1", HEAD, 42, sh)).toBe("0x848a51d344f25a471636a97521474338ef5e1018401d8ea246219cb86d0f787a");
});

test("entry digest matches viem's EIP-712 hashTypedData and the contract", () => {
  expect(entryDigest({ game: "nearwolf-test-1", seat: "0x00000000000000000000000000000000000000aa", payout: "alice.testnet", stake: 10n ** 23n, expiresAtMs: 50_000 }))
    .toBe("0x517dc8afe6e9fc37811557b0da82e1077447df98c27286343c00b36ed411e2c3");
});

test("a step signed the way the keeper signs it verifies, and recovers the keeper's key", () => {
  const priv = secp256k1.utils.randomSecretKey();
  const key = `0x${bytesToHex(secp256k1.getPublicKey(priv, true))}`;
  const text = canonicalJson(STATE as never);
  const step = stepDigest("g1", HEAD, 7, stateHash(text));
  // runtime/keeper/src/hidden.ts: secp256k1.sign(step, key, { prehash: false, lowS: true })
  const signature = `0x${bytesToHex(secp256k1.sign(hexToBytes(step.slice(2)), priv, { prehash: false, lowS: true }))}`;
  expect(verifyStep({ instance: "g1", head: HEAD, count: 7, state: text, signature }, key).step).toBe(step);
  expect(recoverKeys(step, signature)).toContain(key);
  expect(() => verifyStep({ instance: "g2", head: HEAD, count: 7, state: text, signature }, key)).toThrow();
  expect(resultOf(text)).toEqual({ finished: true, winners: ["0x00000000000000000000000000000000000000aa"], shares: null });
});

test("a non-canonical state is refused (the keeper hashed canonical bytes)", () => {
  expect(() => stateHash('{"finished":true, "game":{}}')).toThrow(/canonical/);
});

test("a series' outcome names the winners, and its redacted rules state can be put back", async () => {
  const { unredactSeries } = await import("./keeper");
  const rules = { night: 3, roles: { "0xaa": "wolf" } };
  const { hashValue } = await import("./canonical");
  const redacted = { finished: true, game: { outcome: { kind: "Ranking", tiers: [["0xAA"], ["0xbb"]] }, rules: { hidden: hashValue("makeo:runtime:state:v1", rules) } } };
  expect(resultOf(redacted as never).winners).toEqual(["0xaa"]);
  expect((unredactSeries(redacted as never, rules) as { game: { rules: unknown } }).game.rules).toEqual(rules);
  expect(() => unredactSeries(redacted as never, { night: 4 })).toThrow("does not hash");
  expect(resultOf({ finished: true, game: { outcome: { kind: "Void", reason: "x" } } } as never).winners).toEqual([]);
});
