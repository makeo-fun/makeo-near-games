// The Makeo pot operator: opens games, relays players' entries (so a player never sees a gas popup) and
// submits the keeper-signed result when a hidden game ends. It holds no authority over results: the contract
// pays only on a step the registered keeper signed, so a dishonest operator can delay a game, never steal it.
//
//   bun operator.ts create-pot [near]                    create NEAR_POT_CONTRACT as a sub-account of the operator
//   bun operator.ts deploy <wasm> [owner]                 deploy makeo-pot to NEAR_POT_CONTRACT and init it
//   bun operator.ts register-keeper <pubkey> <pcr0>       (owner) trust a keeper key, with its image's PCR0
//   bun operator.ts add-operator <account>                (owner)
//   bun operator.ts open <game> <stakeNear> <seats> <minutes> [rulesDigest]
//   bun operator.ts settle <proof.json|url>               {instance, output: {journal, state}, step, signature}
//   bun operator.ts demo-entry <game> <payout> <stakeNear>  enter a throwaway EVM seat (for a scripted game)
//   bun operator.ts serve                                  HTTP: POST /open /enter /settle, GET /game/:id
//
// Env: NEAR_NETWORK=testnet, NEAR_POT_CONTRACT, NEAR_OPERATOR_ACCOUNT, NEAR_OPERATOR_KEY (ed25519:…) or NEAR_OPERATOR_KEY_FILE,
//      NEAR_RPC_URL (optional), OPERATOR_TOKEN (bearer for /open and /settle), OPERATOR_PORT (8787),
//      OPERATOR_MAX_STAKE_NEAR (largest stake the operator sponsors per seat, default 0.5).
import { Account, JsonRpcProvider, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { canonicalJson, type Json } from "../../../verify/canonical";
import { recoverKeys, resultOf, stateHash, stepDigest, unredactSeries } from "../../../verify/keeper";
import { entryDigest, RPC_URL } from "../../../verify/near";

const env = (name: string) => {
  const v = process.env[name] ?? fromKeyFile(name);
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

/** NEAR_OPERATOR_KEY from NEAR_OPERATOR_KEY_FILE (a near-cli credentials JSON), so the key never sits in env or argv. */
function fromKeyFile(name: string): string | undefined {
  if (name !== "NEAR_OPERATOR_KEY" || !process.env.NEAR_OPERATOR_KEY_FILE) return undefined;
  const path = process.env.NEAR_OPERATOR_KEY_FILE.replace(/^~/, process.env.HOME ?? "~");
  return (JSON.parse(require("node:fs").readFileSync(path, "utf8")) as { private_key?: string }).private_key;
}

export const provider = () => new JsonRpcProvider({ url: RPC_URL });
const contract = () => env("NEAR_POT_CONTRACT");
const operator = () => new Account(env("NEAR_OPERATOR_ACCOUNT"), provider(), env("NEAR_OPERATOR_KEY") as KeyPairString);

export async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider().callFunction({ contractId: contract(), method, args })) as T;
}

async function call(method: string, args: Record<string, unknown>, opts: { deposit?: bigint; tgas?: string } = {}) {
  const tx = await operator().callFunctionRaw({
    contractId: contract(), methodName: method, args, gas: teraToGas(opts.tgas ?? "100"), deposit: opts.deposit ?? 0n,
  });
  const failure = JSON.stringify((tx as { status?: unknown }).status ?? {}).includes("Failure");
  const hash = (tx as { transaction?: { hash?: string } }).transaction?.hash ?? (tx as { transaction_outcome?: { id?: string } }).transaction_outcome?.id;
  if (failure) throw new Error(`${method} failed (${hash}): ${JSON.stringify((tx as { status?: unknown }).status)}`);
  return { tx: hash, value: decodeValue(tx) };
}

function decodeValue(tx: unknown): unknown {
  const s = (tx as { status?: { SuccessValue?: string } }).status?.SuccessValue;
  if (!s) return null;
  try { return JSON.parse(Buffer.from(s, "base64").toString()); } catch { return null; }
}

// ---------- owner setup ----------

export async function deploy(wasmPath: string, owner = env("NEAR_OPERATOR_ACCOUNT")) {
  const pot = new Account(contract(), provider(), (process.env.NEAR_POT_KEY ?? env("NEAR_OPERATOR_KEY")) as KeyPairString);
  const code = new Uint8Array(await Bun.file(wasmPath).arrayBuffer());
  const deployed = await pot.deployContract(code);
  const init = await pot.callFunctionRaw({ contractId: contract(), methodName: "new", args: { owner }, gas: teraToGas("30") });
  return { deploy: (deployed as { transaction?: { hash?: string } }).transaction?.hash, init: (init as { transaction?: { hash?: string } }).transaction?.hash };
}

/** Creates the pot's account as a sub-account of the operator, controlled by the operator's key. */
export async function createPot(nearToTransfer: string) {
  const pot = contract();
  const parent = env("NEAR_OPERATOR_ACCOUNT");
  if (!pot.endsWith(`.${parent}`)) throw new Error(`${pot} is not a sub-account of ${parent}`);
  const { KeyPair } = await import("near-api-js");
  const publicKey = KeyPair.fromString(env("NEAR_OPERATOR_KEY") as KeyPairString).getPublicKey().toString();
  const tx = await operator().createSubAccount({ accountOrPrefix: pot, publicKey, nearToTransfer: nearToYocto(nearToTransfer) });
  return { tx: (tx as { transaction?: { hash?: string } }).transaction?.hash, account: pot };
}

export const registerKeeper = (pubkey: string, pcr0: string) => call("register_keeper", { pubkey_secp256k1: pubkey, pcr0 });
export const addOperator = (account: string) => call("add_operator", { account_id: account });

// ---------- games ----------

export async function openGame(input: { game: string; stakeNear: string; seats: number; minutes: number; rulesDigest?: string }) {
  return call("open_game", {
    game: input.game, rules_digest: input.rulesDigest ?? "", stake_yocto: nearToYocto(input.stakeNear).toString(),
    max_seats: input.seats, deadline_ms: Date.now() + input.minutes * 60_000,
  });
}

export type EntryRequest = { game: string; seat: string; payout: string; stake: string; expiresAtMs: number; sig: string };

/** Relays a seat's signed entry; the operator attaches (sponsors) the stake, and refunds go back to it. */
export async function relayEnter(e: EntryRequest) {
  const max = nearToYocto(process.env.OPERATOR_MAX_STAKE_NEAR ?? "0.5");
  if (BigInt(e.stake) > max) throw new Error("this operator sponsors stakes up to OPERATOR_MAX_STAKE_NEAR");
  // Check the signature here too, so a bad one costs no gas.
  const digest = entryDigest({ game: e.game, seat: e.seat, payout: e.payout, stake: BigInt(e.stake), expiresAtMs: e.expiresAtMs });
  const sig = hexToBytes(e.sig.replace(/^0x/, ""));
  if (sig.length !== 65) throw new Error("an entry signature is 65 bytes r||s||v");
  const v = sig[64]! >= 27 ? sig[64]! - 27 : sig[64]!;
  const pub = secp256k1.Signature.fromBytes(sig.slice(0, 64), "compact").addRecoveryBit(v).recoverPublicKey(hexToBytes(digest.slice(2)));
  const signer = `0x${bytesToHex(keccak_256(pub.toBytes(false).slice(1)).slice(12))}`;
  if (signer !== e.seat.toLowerCase()) throw new Error(`the entry is signed by ${signer}, not the seat ${e.seat}`);
  return call("enter", { game: e.game, seat: e.seat.toLowerCase(), payout: e.payout, stake: e.stake, expires_at_ms: e.expiresAtMs, sig: e.sig }, { deposit: BigInt(e.stake) });
}

/** What the Makeo room keeps of a hidden game's last batch: the keeper's reply. */
export type RoomProof = {
  instance: string;
  output: { journal: { checkpoint: { event_count: number; input_head: string; state_hash: string }; public_view?: { game?: { state?: Json } } }; state: Json };
  step: string;
  signature: string;
};

/** Checks a room's final proof against the contract's rules and the registered keepers, before spending gas. */
export async function checkProof(p: RoomProof) {
  const { checkpoint } = p.output.journal;
  // A Makeo series keeps its rules' state redacted; a finished game publishes it in its public view
  // (`public_view.game.state`), checked here against the redacted hash.
  const published = p.output.journal.public_view?.game?.state;
  const full = published !== undefined ? unredactSeries(p.output.state, published) : p.output.state;
  const state = canonicalJson(full);
  const sh = stateHash(state);
  if (sh !== checkpoint.state_hash) {
    throw new Error(`the room's state hashes to ${sh}, not the signed ${checkpoint.state_hash}: the game still redacts its finished state (SPEC.md "Result format")`);
  }
  const step = stepDigest(p.instance, checkpoint.input_head, checkpoint.event_count, sh);
  if (step !== p.step.toLowerCase()) throw new Error("the room's step does not follow from its output");
  const keepers = await view<{ pubkey: string }[]>("get_keepers");
  const keeper = recoverKeys(step, p.signature).find((k) => keepers.some((r) => r.pubkey === k));
  if (!keeper) throw new Error("the step is not signed by a registered keeper");
  const result = resultOf(state);
  if (!result.finished) throw new Error("the game has not finished");
  return { state, keeper, result, step, head: checkpoint.input_head, count: checkpoint.event_count };
}

export async function settle(p: RoomProof) {
  const checked = await checkProof(p);
  const done = await call("settle", { game: p.instance, count: checked.count, head: checked.head, state: checked.state, keeper_sig: p.signature }, { tgas: "300" });
  return { ...done, keeper: checked.keeper, winners: checked.result.winners };
}

async function loadProof(where: string): Promise<RoomProof> {
  if (/^https?:\/\//.test(where)) {
    const res = await fetch(where);
    if (!res.ok) throw new Error(`${where}: ${res.status}`);
    return (await res.json()) as RoomProof;
  }
  return JSON.parse(await Bun.file(where).text()) as RoomProof;
}

/** A throwaway EVM seat that signs its own MakeoNearEntry: for scripted games and the demo. */
export function seatKey() {
  const priv = secp256k1.utils.randomSecretKey();
  const seat = `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(priv, false).slice(1)).slice(12))}`;
  return {
    seat,
    priv: `0x${bytesToHex(priv)}`,
    signEntry(game: string, payout: string, stake: bigint, expiresAtMs: number) {
      const d = hexToBytes(entryDigest({ game, seat, payout, stake, expiresAtMs }).slice(2));
      const sig = secp256k1.sign(d, priv, { prehash: false, lowS: true, format: "recovered" });
      // noble's recovered format is v||r||s; EVM wallets give r||s||v with v = 27/28.
      return `0x${bytesToHex(sig.slice(1))}${(27 + sig[0]!).toString(16)}`;
    },
  };
}

// ---------- HTTP ----------

function serve() {
  const token = process.env.OPERATOR_TOKEN;
  const authorized = (req: Request) => !!token && req.headers.get("authorization") === `Bearer ${token}`;
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization" } });
  const server = Bun.serve({
    hostname: process.env.OPERATOR_HOST ?? "127.0.0.1",
    port: Number(process.env.OPERATOR_PORT ?? 8787),
    async fetch(req) {
      const url = new URL(req.url);
      try {
        if (req.method === "OPTIONS") return json({});
        if (req.method === "GET" && url.pathname === "/health") return json({ ok: true, contract: contract(), operator: env("NEAR_OPERATOR_ACCOUNT") });
        if (req.method === "GET" && url.pathname.startsWith("/game/")) {
          const game = decodeURIComponent(url.pathname.slice(6));
          const [g, record] = await Promise.all([view("get_game", { game }), view("get_record", { game })]);
          return json({ game: g, record });
        }
        if (req.method === "POST" && url.pathname === "/enter") return json(await relayEnter((await req.json()) as EntryRequest));
        if (!authorized(req)) return json({ error: "unauthorized" }, 401);
        const body = (await req.json()) as Record<string, unknown>;
        if (req.method === "POST" && url.pathname === "/open") return json(await openGame(body as never));
        if (req.method === "POST" && url.pathname === "/settle") return json(await settle(typeof body.url === "string" ? await loadProof(body.url) : (body as never)));
        return json({ error: "not found" }, 404);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    },
  });
  console.log(`makeo-pot operator on :${server.port} for ${contract()} as ${env("NEAR_OPERATOR_ACCOUNT")}`);
}

if (import.meta.main) {
  const [cmd, ...a] = process.argv.slice(2);
  const out = (v: unknown) => console.log(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2));
  switch (cmd) {
    case "create-pot": out(await createPot(a[0] ?? "3.5")); break;
    case "deploy": out(await deploy(a[0]!, a[1])); break;
    case "register-keeper": out(await registerKeeper(a[0]!, a[1]!)); break;
    case "add-operator": out(await addOperator(a[0]!)); break;
    case "open": out(await openGame({ game: a[0]!, stakeNear: a[1]!, seats: Number(a[2]), minutes: Number(a[3]), rulesDigest: a[4] })); break;
    case "settle": out(await settle(await loadProof(a[0]!))); break;
    case "check": out(await checkProof(await loadProof(a[0]!))); break;
    case "demo-entry": {
      const k = seatKey();
      const stake = nearToYocto(a[2]!);
      const expiresAtMs = Date.now() + 30 * 60_000;
      out({ seat: k.seat, priv: k.priv, ...(await relayEnter({ game: a[0]!, seat: k.seat, payout: a[1]!, stake: stake.toString(), expiresAtMs, sig: k.signEntry(a[0]!, a[1]!, stake, expiresAtMs) })) });
      break;
    }
    case "serve": serve(); break;
    default:
      console.error("usage: bun operator.ts deploy|register-keeper|add-operator|open|settle|check|demo-entry|serve …");
      process.exit(2);
  }
}
