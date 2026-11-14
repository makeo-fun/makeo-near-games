// Check a Makeo pot on NEAR: the game, its entries, and that its settled record is the keeper's signed result.
//
//   bun verify/near.ts <game> [--state state.json] [--keeper-url https://keeper…]
//
// It reads the record from the contract, finds the `settle` call's full state (on chain, in the transaction's
// arguments; or a file), rebuilds state_hash and the step exactly as the contract does, recovers the signer and
// checks it is a registered keeper, and that the winners and payouts follow from the state. With --keeper-url it
// also checks the keeper's live Nitro attestation names that key, from a registered PCR0.
// Env: NEAR_NETWORK (testnet), NEAR_POT_CONTRACT, NEAR_RPC_URL (optional).
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalJson, type Json } from "./canonical";
import { attestKeeper, recoverKeys, resultOf, stateHash, stepDigest } from "./keeper";

export const NETWORK = process.env.NEAR_NETWORK ?? "testnet";
export const RPC_URL = process.env.NEAR_RPC_URL ?? (NETWORK === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://rpc.testnet.fastnear.com");
export const NEARBLOCKS = NETWORK === "mainnet" ? "https://api.nearblocks.io" : "https://api-testnet.nearblocks.io";

// ---------- EIP-712 MakeoNearEntry (what a seat's EVM wallet signs) ----------

/** Domain chainId: 398 = NEAR testnet (397 mainnet). Kept here once; the contract has the same constant. */
export const EIP712_CHAIN_ID = 398;
export const ENTRY_DOMAIN = { name: "Makeo Games", version: "1", chainId: EIP712_CHAIN_ID } as const;
export const ENTRY_TYPES = {
  MakeoNearEntry: [
    { name: "game", type: "string" },
    { name: "seat", type: "address" },
    { name: "payout", type: "string" },
    { name: "stake", type: "uint128" },
    { name: "expiresAtMs", type: "uint64" },
  ],
} as const;

export type Entry = { game: string; seat: string; payout: string; stake: bigint | string; expiresAtMs: number };

/** For `eth_signTypedData_v4` / Privy `signTypedData`. */
export function entryTypedData(e: Entry) {
  return {
    domain: ENTRY_DOMAIN,
    types: ENTRY_TYPES,
    primaryType: "MakeoNearEntry" as const,
    message: { game: e.game, seat: e.seat.toLowerCase(), payout: e.payout, stake: BigInt(e.stake).toString(), expiresAtMs: e.expiresAtMs },
  };
}

const enc = new TextEncoder();
const word = (n: bigint) => hexToBytes(n.toString(16).padStart(64, "0"));
const k = (s: string) => keccak_256(enc.encode(s));
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

/** The EIP-712 digest the contract rebuilds (`proof::entry_digest`). */
export function entryDigest(e: Entry): string {
  const domain = keccak_256(cat(k("EIP712Domain(string name,string version,uint256 chainId)"), k(ENTRY_DOMAIN.name), k(ENTRY_DOMAIN.version), word(BigInt(EIP712_CHAIN_ID))));
  const seat = hexToBytes(e.seat.toLowerCase().replace(/^0x/, "").padStart(64, "0"));
  const struct = keccak_256(cat(
    k("MakeoNearEntry(string game,address seat,string payout,uint128 stake,uint64 expiresAtMs)"),
    k(e.game), seat, k(e.payout), word(BigInt(e.stake)), word(BigInt(e.expiresAtMs)),
  ));
  return `0x${bytesToHex(keccak_256(cat(Uint8Array.of(0x19, 0x01), domain, struct)))}`;
}

// ---------- AI receipts root (anchored on chain by attest_receipts) ----------

/**
 * The Merkle root of a game's published AI receipts, as agent-actors defines it (verify/receipts.ts): leaf =
 * sha256(canonical JSON of the receipt), receipts sorted by (at_ms, chat_id), node = sha256(left || right), an odd
 * last node carried up; zero receipts = sha256("").
 */
export function receiptsRoot(receipts: Array<{ at_ms?: number; chat_id?: string } & Record<string, unknown>>): string {
  const sorted = [...receipts].sort((a, b) => (Number(a.at_ms) - Number(b.at_ms)) || String(a.chat_id ?? "").localeCompare(String(b.chat_id ?? "")));
  let level = sorted.map((r) => sha256(new TextEncoder().encode(canonicalJson(r as Json))));
  if (!level.length) return `0x${bytesToHex(sha256(new Uint8Array()))}`;
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) next.push(level[i]!);
      else { const n = new Uint8Array(64); n.set(level[i]!); n.set(level[i + 1]!, 32); next.push(sha256(n)); }
    }
    level = next;
  }
  return `0x${bytesToHex(level[0]!)}`;
}

/** A receipts file: an array of receipts, or an object holding one under `receipts`. */
export function receiptsOf(file: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(file)) return file as never;
  const r = (file as { receipts?: unknown })?.receipts;
  if (Array.isArray(r)) return r as never;
  throw new Error("a receipts file is an array of receipts or {receipts: [...]}");
}

// ---------- NEAR RPC ----------

export async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "makeo", method, params }) });
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (body.error) throw new Error(`NEAR RPC ${method}: ${JSON.stringify(body.error)}`);
  return body.result as T;
}

export async function view<T>(contract: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await rpc<{ result: number[] }>("query", {
    request_type: "call_function", finality: "final", account_id: contract, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(result.result).toString()) as T;
}

export type ReceiptsAnchor = { root: string; count: number; attested_at_ms: number; attested_by: string };
export type Record = {
  receipts?: ReceiptsAnchor | null;
  game: string; rules_digest: string; count: number; head: string; state_hash: string; step: string; keeper: string;
  winners: string[]; payouts: { seat: string; account: string; amount: string }[]; refunded: boolean; settled_at_ms: number; settled_by: string;
};
export type Keeper = { pubkey: string; pcr0: string; registered_at_ms: number };

/** The `settle` call's arguments for `game`, from the chain (via the nearblocks index, then the RPC). */
export async function settleArgs(contract: string, game: string): Promise<{ state: string; keeper_sig: string; tx: string } | null> {
  const res = await fetch(`${NEARBLOCKS}/v1/account/${contract}/txns?method=settle&per_page=50`);
  if (!res.ok) return null;
  const { txns } = (await res.json()) as { txns?: { transaction_hash: string; predecessor_account_id: string; outcomes?: { status?: boolean } }[] };
  for (const t of txns ?? []) {
    const tx = await rpc<{ transaction: { actions: { FunctionCall?: { method_name: string; args: string } }[] } }>("tx", { tx_hash: t.transaction_hash, sender_account_id: t.predecessor_account_id, wait_until: "FINAL" });
    for (const a of tx.transaction.actions) {
      if (a.FunctionCall?.method_name !== "settle") continue;
      const args = JSON.parse(Buffer.from(a.FunctionCall.args, "base64").toString()) as { game: string; state: string; keeper_sig: string };
      if (args.game === game) return { state: args.state, keeper_sig: args.keeper_sig, tx: t.transaction_hash };
    }
  }
  return null;
}

export async function verifyGame(contract: string, game: string, opts: { state?: string; keeperUrl?: string; receipts?: unknown } = {}) {
  const [g, record, keepers] = await Promise.all([
    view<unknown>(contract, "get_game", { game }), view<Record | null>(contract, "get_record", { game }), view<Keeper[]>(contract, "get_keepers"),
  ]);
  if (!g) throw new Error(`no game ${game} on ${contract}`);
  if (!record) return { game: g, settled: false };
  const found = opts.state ? { state: opts.state, keeper_sig: "", tx: "" } : await settleArgs(contract, game);
  if (!found) throw new Error("could not find the settle transaction's state: pass --state");
  const state_hash = stateHash(found.state);
  if (state_hash !== record.state_hash) throw new Error(`the state hashes to ${state_hash}, the record says ${record.state_hash}`);
  const step = stepDigest(game, record.head, record.count, state_hash);
  if (step !== record.step) throw new Error("the record's step does not follow from its state");
  if (found.keeper_sig && !recoverKeys(step, found.keeper_sig).includes(record.keeper)) throw new Error("the settle signature is not the record's keeper's");
  const registered = keepers.find((k) => k.pubkey === record.keeper);
  if (!registered) throw new Error(`keeper ${record.keeper} is not registered on the contract`);
  const result = resultOf(found.state);
  if (!result.finished) throw new Error("the signed state is not finished");
  if (JSON.stringify(result.winners) !== JSON.stringify(record.winners)) throw new Error("the record's winners are not the state's");
  let attested: string | undefined;
  if (opts.keeperUrl) {
    const live = await attestKeeper(opts.keeperUrl, keepers.map((k) => k.pcr0.replace(/^0x/, "")));
    if (live.key !== record.keeper) throw new Error(`the live keeper attests ${live.key}, not ${record.keeper}`);
    attested = live.pcr0;
  }
  let receipts: { root: string; count: number } | undefined;
  if (opts.receipts !== undefined) {
    const list = receiptsOf(opts.receipts);
    const root = receiptsRoot(list);
    if (!record.receipts) throw new Error("this game's AI receipts are not anchored on chain");
    if (root !== record.receipts.root) throw new Error(`the receipts file hashes to ${root}, the chain anchored ${record.receipts.root}`);
    if (list.length !== record.receipts.count) throw new Error(`the file has ${list.length} receipts, the chain anchored ${record.receipts.count}`);
    receipts = { root, count: list.length };
  }
  return { settled: true, game: g, record, keeper: registered, state_hash, step, tx: found.tx || undefined, attested_pcr0: attested, result, receipts };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const game = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"))[0];
  const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const contract = flag("contract") ?? process.env.NEAR_POT_CONTRACT;
  if (!game || !contract) {
    console.error("usage: NEAR_POT_CONTRACT=pot.testnet bun verify/near.ts <game> [--state state.json] [--keeper-url URL] [--receipts file.receipts.json]");
    process.exit(2);
  }
  const statePath = flag("state");
  const receiptsPath = flag("receipts");
  const out = await verifyGame(contract, game, {
    state: statePath ? (await Bun.file(statePath).text()).trim() : undefined, keeperUrl: flag("keeper-url"),
    receipts: receiptsPath ? JSON.parse(await Bun.file(receiptsPath).text()) : undefined,
  });
  console.log(JSON.stringify({ ok: true, ...out }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}
