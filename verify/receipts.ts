#!/usr/bin/env bun
// verify/receipts.ts — recheck a published game's AI receipts offline, in one command, with no secrets.
//
//   bun verify/receipts.ts actors/receipts/<instance>.receipts.json
//   bun verify/receipts.ts actors/receipts/*.receipts.json --json
//
// For every receipt that came from NEAR AI (not a scripted fallback):
//   R1  sha256(stored request bytes) = request_sha256, and sha256(stored response bytes) = response_sha256
//   R2  the signed text is exactly "<model>:<request sha256>:<response sha256>" (model enclave), or
//       "<request sha256>:<response sha256>" (gateway): the same rule as [S2] in verify/nearai.ts
//   R3  EIP-191 ecrecover(signed text, signature) = signing_address            ([S3])
//   R4  signing_address is a signer in the stored NEAR AI attestation report    ([S4])
//       The report comes from the receipts file (`attestation`, fetched before the game), or else from
//       verify/fixtures/attestations/<model>.json (fetched after it; marked so in the output). Its quote
//       checks (A2–A8) can be rerun with `bun verify/attestation.ts`, which needs the network.
// Then it prints counts (verified, fallback, failed) and the receipts' Merkle root:
//   leaf_i = sha256(canonical JSON of receipt_i), receipts sorted by (at_ms, chat_id)
//   node   = sha256(left || right) over raw 32-byte hashes; an odd last node is carried up unchanged
//   root of zero receipts = sha256("") ; canonical JSON = sorted keys, no spaces (verify/nearai.ts runtime rules)
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { bytesToHex, hexToBytes, sha256 } from "../actors/src/verify-deps";
import { recoverPersonalSign, type AttestationReport } from "./nearai";

type Receipt = {
  game: string; seat: string; round: number; model: string; chat_id: string | null; request_sha256: string | null; response_sha256: string | null;
  signature: string | null; signing_address: string | null; verified: boolean; signer?: "model" | "gateway" | null; signed_text?: string | null;
  fallback?: string | null; at_ms: number; [key: string]: unknown;
};
type Published = { instance: string; receipts: Receipt[]; evidence?: Array<{ chat_id: string; request_body: string; response_body: string }>; attestation?: { report?: AttestationReport; nonce?: string; at_ms?: number } };

const utf8 = (s: string) => new TextEncoder().encode(s);
const sha = (s: string | Uint8Array) => bytesToHex(sha256(typeof s === "string" ? utf8(s) : s));

/** Canonical JSON: object keys sorted by UTF-8 bytes, no whitespace; undefined fields dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("non-finite number"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).filter((k) => object[k] !== undefined).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(object[k])}`).join(",")}}`;
}

export const leafOf = (receipt: Receipt) => sha256(utf8(canonicalJson(receipt)));
export function sortReceipts(receipts: Receipt[]) {
  return [...receipts].sort((a, b) => a.at_ms - b.at_ms || String(a.chat_id ?? "").localeCompare(String(b.chat_id ?? "")));
}
/** The Merkle root (hex) over the receipts' leaves, in (at_ms, chat_id) order. */
export function merkleRoot(receipts: Receipt[]): string {
  let level = sortReceipts(receipts).map(leafOf);
  if (!level.length) return sha("");
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? sha256(new Uint8Array([...level[i]!, ...level[i + 1]!])) : level[i]!);
    level = next;
  }
  return bytesToHex(level[0]!);
}

/** The signers a NEAR AI attestation report names: the gateway and every model enclave. */
function signersOf(report: AttestationReport) {
  const out = new Map<string, "gateway" | "model">();
  out.set(report.gateway_attestation.signing_address.toLowerCase(), "gateway");
  for (const m of report.model_attestations ?? []) out.set(m.signing_address.toLowerCase(), "model");
  return out;
}

export type ReceiptCheck = { chat_id: string | null; seat: string; round: number; status: "verified" | "fallback" | "failed"; failed: string[] };

export function checkPublished(file: Published, fixturesDir = join(import.meta.dir, "fixtures", "attestations")) {
  const evidence = new Map((file.evidence ?? []).map((e) => [e.chat_id, e]));
  const reports = new Map<string, { signers: Map<string, "gateway" | "model">; source: string }>();
  const reportFor = (model: string) => {
    if (reports.has(model)) return reports.get(model)!;
    let found: { signers: Map<string, "gateway" | "model">; source: string } | null = null;
    if (file.attestation?.report) found = { signers: signersOf(file.attestation.report), source: "receipts file (fetched before the game)" };
    else {
      const path = join(fixturesDir, `${model.replace(/[^a-zA-Z0-9.-]+/g, "_")}.json`);
      if (existsSync(path)) found = { signers: signersOf((JSON.parse(readFileSync(path, "utf8")) as { report: AttestationReport }).report), source: `${basename(path)} (fetched after the game)` };
    }
    reports.set(model, found ?? { signers: new Map(), source: "none" });
    return reports.get(model)!;
  };
  const checks: ReceiptCheck[] = file.receipts.map((r) => {
    const base = { chat_id: r.chat_id, seat: r.seat, round: r.round };
    if (r.fallback || !r.chat_id) return { ...base, status: "fallback" as const, failed: [] };
    const failed: string[] = [];
    const e = evidence.get(r.chat_id);
    // [R1] the stored bytes are the bytes the hashes name
    if (!e || sha(e.request_body) !== r.request_sha256 || sha(e.response_body) !== r.response_sha256) failed.push("R1 request/response bytes");
    // [R2] the signed text binds those hashes (and the model id for a model-enclave signature)
    const hashes = `${r.request_sha256}:${r.response_sha256}`;
    const expected = r.signer === "gateway" ? hashes : `${r.model}:${hashes}`;
    if (r.signed_text !== expected) failed.push("R2 signed text");
    // [R3] the signature recovers to the signing address
    let recovered: string | null = null;
    try { recovered = r.signature && r.signed_text ? recoverPersonalSign(r.signed_text, r.signature) : null; } catch { recovered = null; }
    if (!recovered || recovered !== r.signing_address?.toLowerCase()) failed.push("R3 signature");
    // [R4] the signer is attested, as the kind the receipt claims
    const kind = recovered ? reportFor(r.model).signers.get(recovered) : undefined;
    if (!kind || kind !== (r.signer ?? "model")) failed.push("R4 signer not in attestation report");
    return { ...base, status: failed.length ? "failed" as const : "verified" as const, failed };
  });
  const count = (s: ReceiptCheck["status"]) => checks.filter((c) => c.status === s).length;
  return {
    instance: file.instance, receipts: file.receipts.length,
    verified: count("verified"), fallback: count("fallback"), failed: count("failed"),
    merkle_root: merkleRoot(file.receipts),
    attestation_sources: Object.fromEntries([...reports].map(([m, r]) => [m, r.source])),
    failures: checks.filter((c) => c.status === "failed"),
  };
}

if (import.meta.main) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!files.length) { console.log("usage: bun verify/receipts.ts <file.receipts.json>... [--json]"); process.exit(2); }
  let bad = 0;
  const all = files.map((f) => checkPublished(JSON.parse(readFileSync(f, "utf8")) as Published));
  if (process.argv.includes("--json")) console.log(JSON.stringify(all, null, 2));
  else for (const r of all) {
    console.log(`${r.instance}\n  receipts ${r.receipts}: verified ${r.verified}, fallback ${r.fallback}, failed ${r.failed}\n  merkle root ${r.merkle_root}`);
    for (const [m, s] of Object.entries(r.attestation_sources)) console.log(`  attestation for ${m}: ${s}`);
    for (const f of r.failures) console.log(`  FAILED ${f.chat_id} (${f.seat} r${f.round}): ${f.failed.join(", ")}`);
  }
  for (const r of all) bad += r.failed;
  process.exit(bad ? 1 : 0);
}
