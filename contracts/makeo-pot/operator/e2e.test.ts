// End to end on a local NEAR sandbox: deploy makeo-pot, register a keeper key, open a game, relay two signed
// entries, settle on a step signed exactly as the Makeo keeper signs it, and check the payouts, badges and record.
// Needs the wasm: `cargo near build non-reproducible-wasm` in contracts/makeo-pot.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, DEFAULT_PUBLIC_KEY, Sandbox } from "near-sandbox";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const WASM = new URL("../target/near/makeo_pot.wasm", import.meta.url).pathname;
let sandbox: Sandbox;
let op: typeof import("./operator");
let verify: typeof import("../../../verify/near");
let canonical: typeof import("../../../verify/canonical");
let keeperLib: typeof import("../../../verify/keeper");
const keeperPriv = secp256k1.utils.randomSecretKey();
const keeperKey = `0x${bytesToHex(secp256k1.getPublicKey(keeperPriv, true))}`;
const ONE = 10n ** 24n;

beforeAll(async () => {
  sandbox = await Sandbox.start({});
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY as KeyPairString);
  for (const name of ["pot", "operator"]) await root.createSubAccount({ accountOrPrefix: name, publicKey: DEFAULT_PUBLIC_KEY, nearToTransfer: 50n * ONE });
  Object.assign(process.env, {
    NEAR_RPC_URL: sandbox.rpcUrl, NEAR_NETWORK: "sandbox", NEAR_POT_CONTRACT: `pot.${DEFAULT_ACCOUNT_ID}`,
    NEAR_OPERATOR_ACCOUNT: `operator.${DEFAULT_ACCOUNT_ID}`, NEAR_OPERATOR_KEY: DEFAULT_PRIVATE_KEY, NEAR_POT_KEY: DEFAULT_PRIVATE_KEY,
  });
  op = await import("./operator");
  verify = await import("../../../verify/near");
  canonical = await import("../../../verify/canonical");
  keeperLib = await import("../../../verify/keeper");
  void KeyPair;
}, 120_000);

afterAll(async () => { await sandbox?.tearDown(); });

test("deploy → open → relayed entries → keeper-signed settle → payouts, badges, record", async () => {
  await op.deploy(WASM);
  await op.registerKeeper(keeperKey, "0xpcr0-of-the-keeper-image");
  expect((await op.view<{ pubkey: string }[]>("get_keepers"))[0]!.pubkey).toBe(keeperKey);

  const game = `nearwolf-e2e-${Date.now()}`;
  await op.openGame({ game, stakeNear: "0.1", seats: 6, minutes: 30, rulesDigest: "0xrules" });

  // Payouts go to NEAR implicit accounts, as Privy's embedded NEAR wallets are; they are created on transfer.
  const payA = bytesToHex(secp256k1.utils.randomSecretKey());
  const payB = bytesToHex(secp256k1.utils.randomSecretKey());
  const a = op.seatKey(), b = op.seatKey();
  const stake = ONE / 10n, exp = Date.now() + 10 * 60_000;
  await op.relayEnter({ game, seat: a.seat, payout: payA, stake: stake.toString(), expiresAtMs: exp, sig: a.signEntry(game, payA, stake, exp) });
  await op.relayEnter({ game, seat: b.seat, payout: payB, stake: stake.toString(), expiresAtMs: exp, sig: b.signEntry(game, payB, stake, exp) });
  // A forged entry (B's signature for A's seat) is refused before it costs gas.
  await expect(op.relayEnter({ game, seat: a.seat, payout: payB, stake: stake.toString(), expiresAtMs: exp, sig: b.signEntry(game, payB, stake, exp) })).rejects.toThrow("not the seat");
  expect((await op.view<{ seats: string[] }>("get_game", { game })).seats).toEqual([a.seat, b.seat]);

  // A finished game's full state, as the room keeps it (redacting nothing once finished), ~30 KB like a long game.
  const actionIds = Object.fromEntries(Array.from({ length: 360 }, (_, i) => [`0x${i.toString(16).padStart(64, "0")}`, i + 1]));
  const state = {
    count: 420, head: `0x${"22".repeat(32)}`, now_ms: Date.now(), action_ids: actionIds, receipt_ids: [], ledger: { balances: {}, withdrawals: {}, deposited: "0" },
    finished: true,
    game: { phase: "over", winners: [a.seat], roles: { [a.seat]: "villager", [b.seat]: "werewolf" }, seed: `0x${"33".repeat(32)}` },
  };
  const text = canonical.canonicalJson(state as never);
  console.log(`state: ${text.length} bytes`);
  const stateHash = keeperLib.stateHash(text);
  const head = `0x${"44".repeat(32)}`;
  const step = keeperLib.stepDigest(game, head, 420, stateHash);
  const signature = `0x${bytesToHex(secp256k1.sign(hexToBytes(step.slice(2)), keeperPriv, { prehash: false, lowS: true }))}`;
  const proof = { instance: game, output: { journal: { checkpoint: { event_count: 420, input_head: head, state_hash: stateHash } }, state: state as never }, step, signature };

  // A proof from another signer is refused before it costs gas.
  const other = secp256k1.utils.randomSecretKey();
  await expect(op.settle({ ...proof, signature: `0x${bytesToHex(secp256k1.sign(hexToBytes(step.slice(2)), other, { prehash: false, lowS: true }))}` })).rejects.toThrow("registered keeper");

  const settled = await op.settle(proof);
  expect(settled.winners).toEqual([a.seat]);
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const tx = await provider.viewTransactionStatus({ txHash: settled.tx!, accountId: process.env.NEAR_OPERATOR_ACCOUNT!, waitUntil: "FINAL" } as never) as { transaction_outcome: { outcome: { gas_burnt: number } }; receipts_outcome: { outcome: { gas_burnt: number } }[] };
  const gas = tx.transaction_outcome.outcome.gas_burnt + tx.receipts_outcome.reduce((n, r) => n + r.outcome.gas_burnt, 0);
  console.log(`settle burnt ${(gas / 1e12).toFixed(1)} Tgas for ${text.length} bytes of state`);

  const record = await op.view<{ winners: string[]; keeper: string; state_hash: string; payouts: { account: string; amount: string }[] }>("get_record", { game });
  expect(record.keeper).toBe(keeperKey);
  expect(record.state_hash).toBe(stateHash);
  expect(record.payouts).toEqual([{ seat: a.seat, account: payA, amount: (2n * stake).toString() }]);
  const balance = BigInt(((await provider.viewAccount({ accountId: payA } as never)) as { amount: string }).amount);
  expect(balance).toBe(2n * stake);
  expect(await op.view("mt_balance_of", { account_id: payA, token_id: `makeo:${game}:winner` })).toBe("1");

  // Anyone can check it: the record follows from the signed state, by a registered keeper.
  const checked = await verify.verifyGame(process.env.NEAR_POT_CONTRACT!, game, { state: text });
  expect(checked).toMatchObject({ settled: true, step, state_hash: stateHash });
}, 180_000);
