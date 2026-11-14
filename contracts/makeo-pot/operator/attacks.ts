// Attacks on the live pot, sent as real testnet transactions that the contract refuses. It bypasses the
// operator's own pre-checks (which refuse these before they cost gas) and calls the contract directly, then
// records each transaction hash and the contract's panic message in ATTACKS.json for ATTACKS.md.
//
//   bun attacks.ts <near-result.json of a finished, keeper-signed game that has no pot yet>
//
// The target is a pot opened under that game's exact keeper instance. Order: two forged entries, a tampered
// settle, a settle signed by another key, the honest settle (it succeeds), then a second settle.
import { Account, JsonRpcProvider, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { checkProof, openGame, seatKey, type RoomProof } from "./operator";
import { RPC_URL } from "../../../verify/near";

const proofPath = process.argv[2]!;
const proof = JSON.parse(await Bun.file(proofPath).text()) as RoomProof;
const game = proof.instance;
const contractId = process.env.NEAR_POT_CONTRACT!;
const keyFile = process.env.NEAR_OPERATOR_KEY_FILE!.replace(/^~/, process.env.HOME!);
const key = (JSON.parse(await Bun.file(keyFile).text()) as { private_key: string }).private_key as KeyPairString;
const account = new Account(process.env.NEAR_OPERATOR_ACCOUNT!, new JsonRpcProvider({ url: RPC_URL }), key);

type Attempt = { attack: string; method: string; tx: string; refused: boolean; panic: string };
const results: Attempt[] = [];

async function attempt(attack: string, method: string, args: Record<string, unknown>, deposit = 0n) {
  let tx = "", panic = "", refused = false;
  try {
    const out = await account.callFunctionRaw({ contractId, methodName: method, args, gas: teraToGas("300"), deposit, throwOnFailure: false } as never) as {
      transaction?: { hash?: string }; transaction_outcome?: { id?: string }; status?: { Failure?: unknown; SuccessValue?: string };
    };
    tx = out.transaction?.hash ?? out.transaction_outcome?.id ?? "";
    if (out.status && "Failure" in out.status) {
      refused = true;
      const s = JSON.stringify(out.status.Failure);
      panic = (s.match(/Smart contract panicked: ([^"\\]+)/) ?? s.match(/"ExecutionError":"([^"]+)"/) ?? [, s])[1]!;
    }
  } catch (e) {
    // near-api-js may throw on a failed receipt: the hash and the panic are in the error.
    const m = e instanceof Error ? e.message : String(e);
    refused = true;
    panic = (m.match(/Smart contract panicked: (.+?)(?:\n|$)/) ?? [, m])[1]!.slice(0, 200);
    tx = (e as { context?: { transactionHash?: string }; transactionHash?: string }).context?.transactionHash ?? (e as { transactionHash?: string }).transactionHash ?? (m.match(/[1-9A-HJ-NP-Za-km-z]{43,44}/) ?? [""])[0];
  }
  results.push({ attack, method, tx, refused, panic });
  console.log(`${refused ? "REFUSED" : "ACCEPTED"} ${attack}: ${tx} ${panic}`);
}

// The pot, under the game's exact keeper instance.
const stake = nearToYocto("0.1");
const opened = await openGame({ game, stakeNear: "0.1", seats: 4, minutes: 60 });
console.log(`open ${game}: ${opened.tx}`);

// (a) A forged entry: the seat claimed is Alice's, the signature is Mallory's (to collect Alice's winnings).
const alice = seatKey(), mallory = seatKey();
const payout = bytesToHex(secp256k1.utils.randomSecretKey());
const exp = Date.now() + 30 * 60_000;
await attempt("(a) enter with a forged MakeoNearEntry signature", "enter",
  { game, seat: alice.seat, payout, stake: stake.toString(), expires_at_ms: exp, sig: mallory.signEntry(game, payout, stake, exp) }, stake);
// (b) Alice's real signature, for her payout, replayed with another payout account.
const other = bytesToHex(secp256k1.utils.randomSecretKey());
await attempt("(b) enter whose signature binds a different payout account", "enter",
  { game, seat: alice.seat, payout: other, stake: stake.toString(), expires_at_ms: exp, sig: alice.signEntry(game, payout, stake, exp) }, stake);

const checked = await checkProof(proof);
const settleArgs = { game, count: checked.count, head: checked.head, state: checked.state, keeper_sig: proof.signature };
// (c) The keeper's real signature over a state with one winner changed (an AI winner swapped for Alice's seat).
const won = checked.result.winners[0]!;
const tampered = checked.state.split(won).join(alice.seat);
if (tampered === checked.state) throw new Error("could not tamper the state");
await attempt("(c) settle with a tampered final state (a winner changed)", "settle", { ...settleArgs, state: tampered });
// (d) The real state, signed by a key that is not the registered keeper.
const forger = secp256k1.utils.randomSecretKey();
await attempt("(d) settle signed by a key that is not the registered keeper", "settle",
  { ...settleArgs, keeper_sig: `0x${bytesToHex(secp256k1.sign(hexToBytes(checked.step.slice(2)), forger, { prehash: false, lowS: true }))}` });
// The honest settle: the keeper's own signature over the real state. It is accepted.
await attempt("honest settle (the keeper's signature, the real state)", "settle", settleArgs);
// (e) The same, again, on the now settled game.
await attempt("(e) a second settle on an already settled game", "settle", settleArgs);

await Bun.write(new URL("../ATTACKS.json", import.meta.url).pathname, JSON.stringify({ contract: contractId, game, open: opened.tx, results }, null, 2) + "\n");
