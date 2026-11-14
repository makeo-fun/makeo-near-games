// verify/nearai.ts — checks that an AI move really came from NEAR AI Cloud's TEE-attested inference.
//
// Read top to bottom. Every check has a tag like [A3] or [S2]; the in-game Receipt screen shows the
// same tags and links each line to the comment that explains it. The steps follow NEAR's own docs
// (docs.near.ai/cloud/verification: "Quote, Nonce, and Signer Bindings", "NEAR Model Attestations",
// "Response Signatures") and the reference verifier github.com/nearai/nearai-cloud-verifier.
//
//   A. Attestation (before any move): is the key that will sign really inside a genuine enclave?
//      A1  Fresh nonce: we make 32 random bytes; the enclave must put them in its quote.
//      A2  Intel TDX quote is genuine (Intel's certificate chain + TCB status, via Phala dcap-qvl).
//      A3  Not a debug enclave (a debug TD can be inspected by its host).
//      A4  Quote's report_data = signing address (padded to 32 bytes) || our nonce.
//      A5  The echoed request_nonce is ours.
//      A6  MRCONFIGID = 0x01 || sha256(app_compose) || zeros: the quote measures this exact config.
//      A7  The event log replays to the quote's RTMR3 (so its app/compose entries are authentic).
//      A8  (model only) NVIDIA GPU evidence: our nonce, and NVIDIA's NRAS says the GPUs are genuine
//          and in confidential-compute mode.
//   S. Signature (per move):
//      S1  Fetch GET /v1/signature/{chat_id}: NEAR's record of who signed this response.
//      S2  The signed text binds sha256(exact request bytes) and sha256(exact response bytes)
//          (and the model id when the model enclave signed).
//      S3  ecrecover(EIP-191(text), signature) = the signing_address in the record.
//      S4  That address is one we attested in A: the model enclave ("model") or the gateway
//          enclave ("gateway"). Only "model" binds the answer to the model's own TEE.
//
// What this does NOT prove (from NEAR's docs): instances of one model share a key, so a match does
// not name the exact machine; and a "gateway" signature proves the gateway relayed these bytes, not
// that the model produced them.
import {
  bytesToHex, ed25519, getCollateral, hexToBytes, keccak_256, PHALA_PCCS_URL, secp256k1, sha256, sha384, verifyQuoteWithCollateral,
} from "../actors/src/verify-deps";

export const NEAR_AI_BASE = "https://cloud-api.near.ai/v1";
export const NRAS_URL = "https://nras.attestation.nvidia.com/v3/attest/gpu";
/** TCB statuses we accept for a quote. NEAR's reference verifier also accepts "OutOfDate". */
export const ACCEPTED_TCB = ["UpToDate", "OutOfDate"];

export type Check = { id: string; label: string; ok: boolean; detail?: string };
export type SignerKind = "model" | "gateway";
export type AttestedSigner = { kind: SignerKind; address: string; algo: string; model?: string; checks: Check[]; ok: boolean };
export type Attestation = { nonce: string; at_ms: number; gateway: AttestedSigner; models: AttestedSigner[]; ok: boolean };

/** Options for the network-touching parts, so tests can run offline from recorded fixtures. */
export type VerifyOptions = {
  fetch?: typeof fetch;
  /** Intel collateral for a quote; default: fetched live from Phala's PCCS. */
  collateral?: (quote: Uint8Array, kind: SignerKind) => Promise<unknown>;
  /** Unix seconds to check certificates at; default now. */
  nowSecs?: number;
  /** NVIDIA verdict for a GPU payload; default: POST to NRAS. */
  nras?: (payload: unknown) => Promise<unknown>;
};

const hex0x = (b: Uint8Array) => `0x${bytesToHex(b)}`;
const unhex = (s: string) => hexToBytes(s.replace(/^0x/i, ""));
const utf8 = (s: string) => new TextEncoder().encode(s);
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
const check = (checks: Check[], id: string, label: string, ok: boolean, detail?: string) => { checks.push({ id, label, ok, ...(detail ? { detail } : {}) }); return ok; };

// ---- A. Attestation ------------------------------------------------------------------------------

/** [A1] A fresh nonce: 32 random bytes as 64 hex characters, made here, never reused. */
export function freshNonce() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** GET /v1/attestation/report for `model` with our nonce: the gateway's report plus the model's. */
export async function fetchAttestationReport(model: string, nonce: string, options: VerifyOptions & { apiKey?: string } = {}) {
  const url = new URL(`${NEAR_AI_BASE}/attestation/report`);
  for (const [k, v] of Object.entries({ model, provider: "near", include_tls_fingerprint: "false", signing_algo: "ecdsa", nonce })) url.searchParams.set(k, v);
  const response = await (options.fetch ?? fetch)(url, {
    headers: { accept: "application/json", "x-no-aliasing": "true", ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`attestation report: HTTP ${response.status} ${await response.text()}`);
  return (await response.json()) as AttestationReport;
}

export type NearReport = {
  signing_address: string; signing_algo: string; intel_quote: string; request_nonce: string;
  event_log: unknown; info: { tcb_info: unknown }; nvidia_payload?: string; model_name?: string; tls_cert_fingerprint?: string;
};
export type AttestationReport = { gateway_attestation: NearReport; model_attestations?: NearReport[] };

/** [A6, A7] helpers. RTMR3 = fold SHA-384 over the imr-3 events, from 48 zero bytes. */
export function replayRtmr3(eventLog: unknown): Uint8Array {
  let rtmr3 = new Uint8Array(48);
  for (const event of json(eventLog) as Array<{ imr: number; event_type: number; event: string; event_payload?: string; digest?: string }>) {
    if (event.imr !== 3) continue;
    const type = new Uint8Array(4);
    new DataView(type.buffer).setUint32(0, event.event_type, true);
    const digest = sha384(new Uint8Array([...type, ...utf8(":"), ...utf8(event.event), ...utf8(":"), ...unhex(event.event_payload ?? "")]));
    if (event.digest && !equal(unhex(event.digest), digest)) throw new Error(`event log digest mismatch at ${event.event}`);
    rtmr3 = sha384(new Uint8Array([...rtmr3, ...digest]));
  }
  return rtmr3;
}

/** Runs A2–A8 on one report (the gateway's or a model's) for our nonce. */
export async function checkReport(report: NearReport, kind: SignerKind, nonce: string, options: VerifyOptions = {}): Promise<AttestedSigner> {
  const checks: Check[] = [];
  const signer: AttestedSigner = { kind, address: report.signing_address.toLowerCase(), algo: report.signing_algo, ...(report.model_name ? { model: report.model_name } : {}), checks, ok: false };
  try {
    // [A2] The quote is a genuine Intel TDX quote: Intel's certificates sign it and its TCB is acceptable.
    const quote = unhex(report.intel_quote);
    const collateral = options.collateral ? await options.collateral(quote, kind) : await getCollateral(PHALA_PCCS_URL, quote);
    const verified = verifyQuoteWithCollateral(Buffer.from(quote), collateral as never, options.nowSecs ?? Math.floor(Date.now() / 1000)) as { status: string; advisory_ids?: string[]; report: { type: string; data: Record<string, Uint8Array> } };
    if (!check(checks, "A2", "Intel TDX quote verified", ACCEPTED_TCB.includes(verified.status) && verified.report.type === "td10", `TCB ${verified.status}${verified.advisory_ids?.length ? ` (${verified.advisory_ids.join(", ")})` : ""}`)) return signer;
    const td = verified.report.data;
    // [A3] Bit 0 of TD attributes is DEBUG.
    check(checks, "A3", "not a debug enclave", (td.tdAttributes![0]! & 1) === 0);
    // [A4] report_data (64 bytes) = signing identity zero-padded to 32 bytes || our 32-byte nonce.
    const identity = unhex(report.signing_address);
    const bound = report.tls_cert_fingerprint ? sha256(new Uint8Array([...identity, ...unhex(report.tls_cert_fingerprint)])) : new Uint8Array([...identity, ...new Uint8Array(32 - identity.length)]);
    check(checks, "A4", "quote binds the signing address and our nonce", equal(td.reportData!, new Uint8Array([...bound, ...unhex(nonce)])), `signer ${signer.address}`);
    // [A5] The echoed nonce matches (the quote check above is what makes it trustworthy).
    check(checks, "A5", "echoed nonce is ours", report.request_nonce?.toLowerCase() === nonce.toLowerCase());
    // [A6] The configuration the enclave runs (its docker compose) is the one the quote measures.
    const appCompose = (json(report.info.tcb_info) as { app_compose: string }).app_compose;
    check(checks, "A6", "quote measures this app config", equal(td.mrConfigId!, new Uint8Array([1, ...sha256(utf8(appCompose)), ...new Uint8Array(15)])), `compose sha256 ${bytesToHex(sha256(utf8(appCompose)))}`);
    // [A7] The runtime event log is authentic: replaying it gives the quote's RTMR3.
    let replayed: Uint8Array | null = null;
    try { replayed = replayRtmr3(report.event_log); } catch (e) { check(checks, "A7", "event log replays to RTMR3", false, (e as Error).message); }
    if (replayed) check(checks, "A7", "event log replays to RTMR3", equal(replayed, td.rtMr3!));
    // [A8] GPU evidence (model enclaves): the payload carries our nonce and NVIDIA says it is genuine.
    if (report.nvidia_payload) {
      const payload = JSON.parse(report.nvidia_payload) as { nonce?: string };
      if (check(checks, "A8a", "GPU evidence carries our nonce", payload.nonce?.toLowerCase() === nonce.toLowerCase())) {
        const verdict = options.nras ? await options.nras(payload) : await nras(payload, options.fetch);
        const token = (verdict as Array<[string, string]>)?.[0]?.[1];
        const claims = token ? JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) : {};
        check(checks, "A8b", "NVIDIA NRAS: GPUs genuine, confidential mode", claims["x-nvidia-overall-att-result"] === true && String(claims.eat_nonce ?? nonce).toLowerCase() === nonce.toLowerCase());
      }
    } else if (kind === "model") {
      check(checks, "A8a", "GPU evidence present", false, "model report has no nvidia_payload");
    }
  } catch (e) {
    check(checks, "A", "attestation could not be checked", false, (e as Error).message);
  }
  signer.ok = checks.length > 0 && checks.every((c) => c.ok);
  return signer;
}

async function nras(payload: unknown, fetcher: typeof fetch = fetch) {
  const response = await fetcher(NRAS_URL, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`NRAS: HTTP ${response.status}`);
  return response.json();
}

/** A: checks the gateway and every model candidate in a report fetched with `nonce`. */
export async function checkAttestation(report: AttestationReport, nonce: string, options: VerifyOptions = {}): Promise<Attestation> {
  const gateway = await checkReport(report.gateway_attestation, "gateway", nonce, options);
  const models = await Promise.all((report.model_attestations ?? []).map((m) => checkReport(m, "model", nonce, options)));
  return { nonce, at_ms: Date.now(), gateway, models, ok: gateway.ok && models.length > 0 && models.every((m) => m.ok) };
}

/** A1–A8 end to end: fresh nonce, fetch, check. Do this BEFORE the completions it will vouch for. */
export async function attest(model: string, options: VerifyOptions & { apiKey?: string } = {}) {
  const nonce = freshNonce();
  return checkAttestation(await fetchAttestationReport(model, nonce, options), nonce, options);
}

// ---- S. Signature -------------------------------------------------------------------------------

export type SignatureRecord = { text: string; signature: string; signing_address: string; signing_algo: string; signature_kind?: string };

/** [S1] NEAR's signature record for a completion, by its chat id. A 404 can be brief: retry a few times. */
export async function fetchSignature(chatId: string, model: string, options: { apiKey: string; fetch?: typeof fetch; tries?: number }): Promise<SignatureRecord> {
  const url = new URL(`${NEAR_AI_BASE}/signature/${encodeURIComponent(chatId)}`);
  url.searchParams.set("model", model);
  url.searchParams.set("signing_algo", "ecdsa");
  let last = "";
  for (let i = 0; i < (options.tries ?? 5); i++) {
    const response = await (options.fetch ?? fetch)(url, { headers: { accept: "application/json", authorization: `Bearer ${options.apiKey}` }, signal: AbortSignal.timeout(15_000) });
    const body = (await response.json().catch(() => ({}))) as SignatureRecord & { error_code?: string; message?: string };
    if (response.ok && body.signature && !body.error_code) return body;
    last = `HTTP ${response.status} ${body.error_code ?? ""} ${body.message ?? ""}`.trim();
    if (response.status !== 404 && response.ok === false) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no signature for ${chatId}: ${last}`);
}

/** EIP-191 personal_sign recovery: the address that signed the UTF-8 `text`. */
export function recoverPersonalSign(text: string, signature: string): string {
  const message = utf8(text);
  const digest = keccak_256(new Uint8Array([...utf8(`\x19Ethereum Signed Message:\n${message.length}`), ...message]));
  const sig = unhex(signature);
  if (sig.length !== 65) throw new Error("an ECDSA signature is 65 bytes");
  const v = sig[64]! >= 27 ? sig[64]! - 27 : sig[64]!;
  const point = secp256k1.Signature.fromBytes(sig.slice(0, 64), "compact").addRecoveryBit(v).recoverPublicKey(digest);
  return hex0x(keccak_256(point.toBytes(false).slice(1)).slice(12));
}

export type SignatureResult = { ok: boolean; signer: SignerKind | null; signing_address: string | null; signature: string | null; text: string | null; checks: Check[] };

/** S2–S4: does `record` sign exactly these bytes, by a key attested in `attestation`? */
export function checkSignature(input: { record: SignatureRecord; model: string; requestBody: string | Uint8Array; responseBody: string | Uint8Array; attestation: Attestation }): SignatureResult {
  const { record, attestation } = input;
  const checks: Check[] = [];
  const kind: SignerKind | null = record.signature_kind === "provider_tee" ? "model" : record.signature_kind === "gateway" ? "gateway" : null;
  // [S2] The text is "<sha256 request>:<sha256 response>", prefixed by the model id when the model signed.
  const bytes = (b: string | Uint8Array) => (typeof b === "string" ? utf8(b) : b);
  const hashes = `${bytesToHex(sha256(bytes(input.requestBody)))}:${bytesToHex(sha256(bytes(input.responseBody)))}`;
  const expected = kind === "model" ? `${input.model}:${hashes}` : hashes;
  check(checks, "S2", "signature covers these exact request and response bytes", kind !== null && record.text === expected, kind === null ? `unknown signature_kind ${record.signature_kind}` : undefined);
  // [S3] Recover the signer from the signature (ECDSA; Ed25519 verifies against the key directly).
  let recovered: string | null = null;
  try {
    if (record.signing_algo === "ed25519") recovered = ed25519.verify(unhex(record.signature), utf8(record.text), unhex(record.signing_address)) ? record.signing_address.toLowerCase() : null;
    else recovered = recoverPersonalSign(record.text, record.signature);
  } catch { recovered = null; }
  check(checks, "S3", "signature recovers to the signing address", recovered !== null && recovered === record.signing_address.toLowerCase(), recovered ?? undefined);
  // [S4] The signer is an attested model enclave, or the attested gateway. NEAR's docs ask for one
  // matching report, but they also note that instances of one model share a signing key, and the
  // report can list several instances. So: at least one verified report must have this exact
  // (address, algorithm), and no report with that key may have failed its checks.
  const same = (m: AttestedSigner) => m.address === recovered && m.algo === record.signing_algo;
  const pool = kind === "model" ? attestation.models.filter(same) : kind === "gateway" && same(attestation.gateway) ? [attestation.gateway] : [];
  check(checks, "S4", kind === "model" ? "signer is the attested model enclave" : "signer is the attested NEAR AI gateway", pool.length > 0 && pool.every((m) => m.ok), `${pool.filter((m) => m.ok).length} attested report(s) with this key`);
  const ok = checks.every((c) => c.ok);
  return { ok, signer: ok ? kind : null, signing_address: recovered, signature: record.signature, text: record.text, checks };
}

/**
 * The runner's verifier: attests once (and again every `refreshMs`), then checks each response.
 * Usage: `const verify = createNearAiVerifier({ apiKey, model }); await verify({ chat_id, model, request_body, response_body })`.
 */
export function createNearAiVerifier(config: { apiKey: string; model: string; refreshMs?: number } & VerifyOptions) {
  let attestation: Promise<Attestation> | null = null;
  let at = 0;
  const current = () => {
    if (!attestation || Date.now() - at > (config.refreshMs ?? 30 * 60_000)) {
      at = Date.now();
      attestation = attest(config.model, config);
      attestation.catch(() => { attestation = null; });
    }
    return attestation;
  };
  void current(); // preflight: attest before the first completion
  const verifier = async (input: { chat_id: string; model: string; request_body: string; response_body: string }) => {
    const a = await current();
    const record = await fetchSignature(input.chat_id, input.model, { apiKey: config.apiKey, fetch: config.fetch });
    const result = checkSignature({ record, model: input.model, requestBody: input.request_body, responseBody: input.response_body, attestation: a });
    return {
      verified: result.ok && (result.signer === "gateway" ? a.gateway.ok : a.models.some((m) => m.ok)),
      signature: result.signature, signing_address: result.signing_address, signed_text: result.text, signer: result.signer,
      checks: [...(result.signer === "gateway" ? a.gateway.checks : a.models.flatMap((m) => m.checks)), ...result.checks],
      reason: result.checks.filter((c) => !c.ok).map((c) => `${c.id} ${c.label}`).join("; ") || undefined,
    };
  };
  return Object.assign(verifier, { attestation: current });
}
