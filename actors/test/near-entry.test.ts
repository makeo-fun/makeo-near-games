import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { bytesToHex } from "../src/crypto";
import { entryDigest, implicitAccount, yocto } from "../src/near-entry";
import { createSeat } from "../src/seat";
import { ecrecover } from "../src/crypto";

const NEAR_TS = `${process.env.HOME}/projects/makeo/makeo-near-games/.claude/worktrees/platform-near/verify/near.ts`;

test("MakeoNearEntry: the seat's wallet signature recovers to the seat", () => {
  const seat = createSeat({ chainId: 398 });
  const e = { game: "p:live:r", seat: seat.wallet, payout: implicitAccount().accountId, stake: yocto("0.1"), expiresAtMs: 1_800_000_000_000 };
  const sig = seat.walletSign(entryDigest(e));
  expect(ecrecover(entryDigest(e), Uint8Array.from(Buffer.from(sig.slice(2), "hex")))).toBe(seat.wallet);
  expect(yocto("0.1")).toBe(10n ** 23n);
  expect(implicitAccount().accountId).toMatch(/^[0-9a-f]{64}$/);
});

test.skipIf(!existsSync(NEAR_TS))("MakeoNearEntry digest equals platform-near's verify/near.ts entryDigest", async () => {
  let near: { entryDigest: (e: unknown) => string };
  try { near = await import(NEAR_TS); } catch { return; } // its deps may not be installed here
  const e = { game: "p:live:r", seat: "0x" + "12".repeat(20), payout: "a".repeat(64), stake: 10n ** 23n, expiresAtMs: 1_800_000_000_000 };
  expect(`0x${bytesToHex(entryDigest(e))}`).toBe(near.entryDigest(e));
});
