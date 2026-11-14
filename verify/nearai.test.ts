// Tests for verify/nearai.ts, offline, from fixtures recorded live from cloud-api.near.ai:
//   fixtures/attestation-report.json  GET /v1/attestation/report?model=Qwen/Qwen3.6-35B-A3B-FP8&provider=near&signing_algo=ecdsa
//   fixtures/attestation-nonce.txt    the nonce we sent
//   fixtures/collateral-*.json        Intel collateral for each quote (Phala PCCS) at recording time
//   fixtures/nras-response.json       NVIDIA NRAS verdict for the model's GPU evidence
//   fixtures/recorded-at.txt          unix seconds the certificates are checked at
// Signature tests use a local test key until a real signature fixture is recorded (record.ts).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { secp256k1 } from "../actors/src/verify-deps";
import { checkAttestation, checkSignature, recoverPersonalSign, type Attestation, type AttestationReport } from "./nearai";

const dir = join(import.meta.dir, "fixtures");
const read = (name: string) => readFileSync(join(dir, name), "utf8");
const report = JSON.parse(read("attestation-report.json")) as AttestationReport;
const nonce = read("attestation-nonce.txt").trim();
const offline = {
  collateral: async (_q: Uint8Array, kind: string) => JSON.parse(read(`collateral-${kind}.json`)),
  nowSecs: Number(read("recorded-at.txt").trim()),
  nras: async () => JSON.parse(read("nras-response.json")),
};

test("A: the recorded gateway and model attestations pass every check", async () => {
  const a = await checkAttestation(report, nonce, offline);
  for (const c of [...a.gateway.checks, ...a.models.flatMap((m) => m.checks)]) expect({ id: c.id, ok: c.ok, detail: c.detail }).toMatchObject({ ok: true });
  expect(a.ok).toBe(true);
  expect(a.gateway.address).toBe("0xb98a789cdc4817275f5155593ba73ef2a957e779");
  expect(a.models[0]!.model).toBe("Qwen/Qwen3.6-35B-A3B-FP8");
  expect(a.models[0]!.checks.map((c) => c.id)).toEqual(["A2", "A3", "A4", "A5", "A6", "A7", "A8a", "A8b"]);
}, 30_000);

test("A: another nonce (a replayed report) fails A4 and A5", async () => {
  const a = await checkAttestation(report, "11".repeat(32), offline);
  expect(a.ok).toBe(false);
  const failed = a.gateway.checks.filter((c) => !c.ok).map((c) => c.id);
  expect(failed).toEqual(["A4", "A5"]);
}, 30_000);

test("A: a changed app config fails A6; a changed quote fails A2", async () => {
  const tampered = structuredClone(report);
  const info = tampered.gateway_attestation.info as { tcb_info: unknown };
  const tcb = typeof info.tcb_info === "string" ? JSON.parse(info.tcb_info) : info.tcb_info;
  tcb.app_compose = `${tcb.app_compose} `;
  info.tcb_info = typeof info.tcb_info === "string" ? JSON.stringify(tcb) : tcb;
  const q = tampered.model_attestations![0]!.intel_quote;
  tampered.model_attestations![0]!.intel_quote = q.slice(0, 1200) + (q[1200] === "0" ? "1" : "0") + q.slice(1201);
  const a = await checkAttestation(tampered, nonce, offline);
  expect(a.gateway.checks.find((c) => c.id === "A6")!.ok).toBe(false);
  expect(a.models[0]!.ok).toBe(false);
}, 30_000);

// ---- Signatures --------------------------------------------------------------------------------
const key = secp256k1.utils.randomSecretKey();
function personalSign(text: string) {
  const { keccak_256 } = require("../actors/src/verify-deps");
  const m = new TextEncoder().encode(text);
  const digest = keccak_256(new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${m.length}`), ...m]));
  const rec = secp256k1.sign(digest, key, { prehash: false, format: "recovered" });
  return `0x${Buffer.from([...rec.slice(1), 27 + rec[0]!]).toString("hex")}`;
}
const address = recoverPersonalSign("probe", personalSign("probe"));
const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const model = "Qwen/Qwen3.6-35B-A3B-FP8";
const request = JSON.stringify({ model, messages: [{ role: "user", content: "pick" }] });
const response = JSON.stringify({ id: "chatcmpl-1", choices: [{ message: { content: "{\"move\":1}" } }] });
const attested = (addr: string, kind: "model" | "gateway"): Attestation => {
  const s = { kind, address: addr, algo: "ecdsa", checks: [], ok: true };
  return { nonce, at_ms: 0, gateway: kind === "gateway" ? s : { ...s, address: "0x0000000000000000000000000000000000000001", kind: "gateway" }, models: kind === "model" ? [{ ...s, model }] : [], ok: true };
};

test("S: a model-enclave signature over the exact bytes verifies as 'model'", () => {
  const text = `${model}:${sha(request)}:${sha(response)}`;
  const r = checkSignature({ record: { text, signature: personalSign(text), signing_address: address, signing_algo: "ecdsa", signature_kind: "provider_tee" }, model, requestBody: request, responseBody: response, attestation: attested(address, "model") });
  expect(r.checks.map((c) => [c.id, c.ok])).toEqual([["S2", true], ["S3", true], ["S4", true]]);
  expect(r.signer).toBe("model");
});

test("S: a gateway signature verifies as 'gateway'", () => {
  const text = `${sha(request)}:${sha(response)}`;
  const r = checkSignature({ record: { text, signature: personalSign(text), signing_address: address, signing_algo: "ecdsa", signature_kind: "gateway" }, model, requestBody: request, responseBody: response, attestation: attested(address, "gateway") });
  expect(r.ok).toBe(true);
  expect(r.signer).toBe("gateway");
});

test("S: changed response bytes fail S2; an unattested signer fails S4; a forged address fails S3", () => {
  const text = `${model}:${sha(request)}:${sha(response)}`;
  const record = { text, signature: personalSign(text), signing_address: address, signing_algo: "ecdsa", signature_kind: "provider_tee" };
  const changed = checkSignature({ record, model, requestBody: request, responseBody: `${response} `, attestation: attested(address, "model") });
  expect(changed.checks.find((c) => c.id === "S2")!.ok).toBe(false);
  const stranger = checkSignature({ record, model, requestBody: request, responseBody: response, attestation: attested("0x00000000000000000000000000000000000000ff", "model") });
  expect(stranger.checks.find((c) => c.id === "S4")!.ok).toBe(false);
  const forged = checkSignature({ record: { ...record, signing_address: "0x00000000000000000000000000000000000000ff" }, model, requestBody: request, responseBody: response, attestation: attested("0x00000000000000000000000000000000000000ff", "model") });
  expect(forged.checks.find((c) => c.id === "S3")!.ok).toBe(false);
  expect(forged.ok).toBe(false);
});

test("S: several attested instances sharing one key pass; a failed report with that key fails", () => {
  const text = `${model}:${sha(request)}:${sha(response)}`;
  const record = { text, signature: personalSign(text), signing_address: address, signing_algo: "ecdsa", signature_kind: "provider_tee" };
  const twice = attested(address, "model");
  twice.models.push({ ...twice.models[0]! });
  expect(checkSignature({ record, model, requestBody: request, responseBody: response, attestation: twice }).ok).toBe(true);
  twice.models[1]!.ok = false;
  expect(checkSignature({ record, model, requestBody: request, responseBody: response, attestation: twice }).ok).toBe(false);
});

test("S: a real recorded signature verifies, when one has been recorded", async () => {
  let fixture: { record: never; model: string; request_body: string; response_body: string; attestation: Attestation } | null = null;
  try { fixture = JSON.parse(read("signature.json")); } catch { /* not recorded yet: run verify/record.ts with NEAR_AI_API_KEY */ }
  if (!fixture) return;
  expect((fixture.record as { signature_kind: string }).signature_kind).toBe("provider_tee");
  const r = checkSignature({ record: fixture.record, model: fixture.model, requestBody: fixture.request_body, responseBody: fixture.response_body, attestation: fixture.attestation });
  expect(r.ok).toBe(true);
});
