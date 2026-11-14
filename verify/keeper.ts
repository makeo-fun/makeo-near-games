// Check what the Makeo keeper signed for a hidden game, and that the keeper is a real AWS Nitro enclave.
//
// The keeper signs, after every batch of a hidden game, its step (SPEC.md "Result format"):
//   state_hash = hashValue("makeo:runtime:state:v1", STATE)              STATE = the full final state
//   step       = hashValue("makeo:hidden:step:v1", {instance, head, count, state: state_hash})
//   signature  = secp256k1 r||s (low-S) over step, by the keeper's key
// The keeper key is the one its Nitro attestation names; the attestation's PCR0 names the image.
//
//   bun verify/keeper.ts attest <keeper-url> <pcr0> [...]   check the keeper's live attestation, print its key
//   bun verify/keeper.ts step <proof.json> <keeper-key>     check a {instance, head, count, state, signature}
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { canonicalJson, hashValue, type Json } from "./canonical";
import { verifyNitroAttestation } from "./nitro";

export type StepProof = {
  instance: string;
  head: string;
  count: number;
  /** The full final state: an object, or its canonical JSON text. */
  state: Json | string;
  signature: string;
};

export function stateText(state: Json | string): string {
  return typeof state === "string" ? state : canonicalJson(state);
}

/** hashValue("makeo:runtime:state:v1", state) over canonical text, exactly as the contract rebuilds it. */
export function stateHash(state: Json | string): string {
  const text = stateText(state);
  const parsed = JSON.parse(text) as Json;
  if (canonicalJson(parsed) !== text) throw new Error("the state is not canonical JSON: the keeper hashed canonical bytes");
  return hashValue("makeo:runtime:state:v1", parsed);
}

export function stepDigest(instance: string, head: string, count: number, stateHashHex: string): string {
  return hashValue("makeo:hidden:step:v1", { instance, head: head.toLowerCase(), count, state: stateHashHex });
}

/** The compressed keys a 64-byte r||s over `digest` may come from (the contract tries both v). */
export function recoverKeys(digestHex: string, signatureHex: string): string[] {
  const sig = hexToBytes(signatureHex.replace(/^0x/, ""));
  if (sig.length !== 64) throw new Error("a keeper signature is 64 bytes r||s");
  const digest = hexToBytes(digestHex.replace(/^0x/, ""));
  const out: string[] = [];
  for (const v of [0, 1]) {
    try {
      const recovered = secp256k1.Signature.fromBytes(sig, "compact").addRecoveryBit(v).recoverPublicKey(digest);
      out.push(`0x${bytesToHex(recovered.toBytes(true))}`);
    } catch {
      /* not this v */
    }
  }
  return out;
}

/** Checks a keeper's step proof; returns `{state_hash, step}`. Throws when `keeperKey` did not sign it. */
export function verifyStep(proof: StepProof, keeperKey: string) {
  const state_hash = stateHash(proof.state);
  const step = stepDigest(proof.instance, proof.head, proof.count, state_hash);
  const ok = secp256k1.verify(hexToBytes(proof.signature.replace(/^0x/, "")), hexToBytes(step.slice(2)), hexToBytes(keeperKey.replace(/^0x/, "")), { prehash: false, lowS: true });
  if (!ok) throw new Error(`the step ${step} is not signed by keeper ${keeperKey}`);
  return { state_hash, step };
}

type Outcome = { kind: "Ranking"; tiers: string[][] } | { kind: "Void"; reason?: string };

/**
 * What the contract reads from a settled state: `finished`, and the winners: `game.winners` (+ `game.shares`), or a
 * Makeo series' `game.outcome` (Ranking pays its first tier, Void refunds everyone).
 */
export function resultOf(state: Json | string) {
  type Picked = { winners?: string[]; shares?: number[] };
  const parsed = JSON.parse(stateText(state)) as { finished?: boolean; game?: Picked & { outcome?: Outcome | null; rules?: Picked & { hidden?: string } } };
  const game = parsed.game ?? {};
  // The same order as the contract: the game's winners, a series' rules winners, then its outcome's first tier.
  const rules = game.rules && game.rules.hidden === undefined ? game.rules : undefined;
  const from: Picked = game.winners ? game : rules?.winners ? rules : { winners: game.outcome?.kind === "Ranking" ? game.outcome.tiers[0] ?? [] : [] };
  return { finished: parsed.finished === true, winners: (from.winners ?? []).map((w) => w.toLowerCase()), shares: from.shares ?? null };
}

/**
 * A Makeo series keeps its rules' state redacted even once finished: `game.rules = {hidden: hash(rules)}`. Given the
 * rules' state (a finished game may publish it, e.g. in its public view), puts it back, checked against that hash.
 */
export function unredactSeries(state: Json, rules: Json): Json {
  const s = state as { game?: { rules?: { hidden?: string } } };
  const hidden = s.game?.rules?.hidden;
  if (typeof hidden !== "string") return state;
  if (hashValue("makeo:runtime:state:v1", rules) !== hidden) throw new Error("the published rules state does not hash to the redacted one");
  return { ...(state as object), game: { ...(s.game as object), rules } } as Json;
}

/** Fetches the keeper's attestation with a fresh nonce and checks it (AWS root, chain, PCR0, nonce, age). Returns its key. */
export async function attestKeeper(keeperUrl: string, pcr0: string[], maxAgeMs = 120_000) {
  if (!pcr0.length) throw new Error("pin at least one PCR0 (the contract's get_keepers lists the registered ones)");
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const res = await fetch(`${keeperUrl.replace(/\/$/, "")}/attestation?nonce=${nonce}`);
  const body = (await res.json()) as { nitro?: string; public_key?: string };
  if (!body.nitro) throw new Error("the keeper sent no Nitro attestation (a simulated keeper is not an enclave)");
  const document = await verifyNitroAttestation(body.nitro, { pcr0, nonce, maxAgeMs });
  if (!document.publicKey || !/^0x0[23][0-9a-f]{64}$/.test(document.publicKey)) throw new Error("attestation names no keeper key");
  return { key: document.publicKey, pcr0: document.pcrs[0]!, document };
}

if (import.meta.main) {
  const [cmd, a, ...rest] = process.argv.slice(2);
  if (cmd === "attest" && a) {
    const { key, pcr0 } = await attestKeeper(a, rest);
    console.log(JSON.stringify({ ok: true, keeper_key: key, pcr0 }, null, 2));
  } else if (cmd === "step" && a && rest[0]) {
    const proof = JSON.parse(await Bun.file(a).text()) as StepProof;
    const { state_hash, step } = verifyStep(proof, rest[0]);
    console.log(JSON.stringify({ ok: true, instance: proof.instance, state_hash, step, ...resultOf(proof.state) }, null, 2));
  } else {
    console.error("usage: bun verify/keeper.ts attest <keeper-url> <pcr0> [...] | step <proof.json> <keeper-key>");
    process.exit(2);
  }
}
