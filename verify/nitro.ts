// Copied as is from the Makeo keeper (runtime/keeper/src/nitro-web.ts): the verifier side of its real
// AWS Nitro attestation, WebCrypto only. The keeper itself stays private; this is how anyone checks it.

// REAL AWS Nitro attestation, checked with WebCrypto only: no node:crypto, no X.509 library, so it
// runs in a Cloudflare Worker (Create copies this file as is). It checks what src/nitro.ts checks:
// the COSE_Sign1 signature (ES384) by the leaf certificate, every certificate in the chain signed
// by the one before and valid now, the chain's root pinned by its SHA-256 fingerprint (AWS's Nitro
// root unless a test pins its own), PCR0 one of the trusted images, and nonce and age.
//
// PCR0 may be a list: during an upgrade the old and the new image are both the keeper (they unseal
// the same master, see nitro/pin.sh), so verifiers trust both until the old one is retired.

/** SHA-256 fingerprint of the AWS Nitro Enclaves root certificate (G1), as AWS publishes it. */
export const AWS_NITRO_ROOT_SHA256 = "641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b";

export type NitroDocument = { moduleId: string; timestamp: number; pcrs: Record<number, string>; publicKey: string | null; nonce: string | null };
export type NitroPolicy = { pcr0: string | string[]; nonce?: string; maxAgeMs: number; now?: number; rootSha256?: string };

// WebCrypto takes bytes backed by a plain ArrayBuffer; every array here is.
const buf = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

// ---- CBOR, as much as COSE and the attestation document use ----

type Cbor = number | string | Uint8Array | null | boolean | Cbor[] | Map<Cbor, Cbor> | { tag: number; value: Cbor };

function decodeCbor(bytes: Uint8Array): Cbor {
  let at = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return bytes[at++]!;
    if (info === 25) { const v = view.getUint16(at); at += 2; return v; }
    if (info === 26) { const v = view.getUint32(at); at += 4; return v; }
    if (info === 27) { const v = view.getBigUint64(at); at += 8; if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CBOR length too large"); return Number(v); }
    throw new Error("bad CBOR length");
  };
  const isBreak = () => { if (bytes[at] === 0xff) { at++; return true; } return false; };
  const item = (): Cbor => {
    if (at >= bytes.length) throw new Error("truncated CBOR");
    const head = bytes[at++]!, major = head >> 5, info = head & 31;
    if (info === 31) {
      // AWS's NSM writes the document as an indefinite-length map: items until a 0xff break.
      if (major === 2) { const parts: Uint8Array[] = []; while (!isBreak()) parts.push(item() as Uint8Array); return concat(...parts); }
      if (major === 3) { const parts: string[] = []; while (!isBreak()) parts.push(item() as string); return parts.join(""); }
      if (major === 4) { const out: Cbor[] = []; while (!isBreak()) out.push(item()); return out; }
      if (major === 5) { const map = new Map<Cbor, Cbor>(); while (!isBreak()) { const k = item(); map.set(k, item()); } return map; }
      throw new Error("bad indefinite CBOR");
    }
    switch (major) {
      case 0: return length(info);
      case 1: return -1 - length(info);
      case 2: { const n = length(info); const out = bytes.slice(at, at + n); at += n; if (out.length !== n) throw new Error("truncated CBOR"); return out; }
      case 3: { const n = length(info); const out = new TextDecoder().decode(bytes.subarray(at, at + n)); at += n; return out; }
      case 4: { const n = length(info); return Array.from({ length: n }, item); }
      case 5: { const n = length(info); const map = new Map<Cbor, Cbor>(); for (let i = 0; i < n; i++) { const k = item(); map.set(k, item()); } return map; }
      case 6: return { tag: length(info), value: item() };
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        throw new Error("CBOR floats are not used here");
    }
    throw new Error("bad CBOR");
  };
  const value = item();
  if (at !== bytes.length) throw new Error("trailing bytes after CBOR");
  return value;
}

function head(major: number, n: number): Uint8Array {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 0x100) return Uint8Array.of((major << 5) | 24, n);
  if (n < 0x10000) return Uint8Array.of((major << 5) | 25, n >> 8, n & 0xff);
  return Uint8Array.of((major << 5) | 26, n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
}
const cborBytes = (b: Uint8Array) => concat(head(2, b.length), b);

// ---- X.509, as much as a signature check needs (DER) ----

type Der = { tag: number; start: number; end: number; whole: Uint8Array; body: Uint8Array };
function der(bytes: Uint8Array, at = 0): Der {
  const tag = bytes[at]!;
  let len = bytes[at + 1]!, header = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error("bad DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + bytes[at + 2 + i]!;
    header = 2 + n;
  }
  const end = at + header + len;
  if (end > bytes.length) throw new Error("truncated DER");
  return { tag, start: at, end, whole: bytes.subarray(at, end), body: bytes.subarray(at + header, end) };
}
function children(node: Der): Der[] {
  const out: Der[] = [];
  for (let at = 0; at < node.body.length;) { const c = der(node.body, at); out.push(c); at = c.end; }
  return out;
}

// ecdsa-with-SHA256/384 and the curves they are used with here.
const SIG_ALGS: Record<string, string> = { "2a8648ce3d040302": "SHA-256", "2a8648ce3d040303": "SHA-384" };
const CURVES: Record<string, { name: string; size: number }> = { "2b81040022": { name: "P-384", size: 48 }, "2a8648ce3d030107": { name: "P-256", size: 32 } };

type Cert = { raw: Uint8Array; tbs: Uint8Array; hash: string; signature: Uint8Array; issuer: string; subject: string; notBefore: number; notAfter: number; spki: Uint8Array; curve: { name: string; size: number } };

function time(node: Der): number {
  const s = new TextDecoder().decode(node.body);
  // UTCTime YYMMDDHHMMSSZ (years 1950-2049), GeneralizedTime YYYYMMDDHHMMSSZ.
  const full = node.tag === 0x17 ? `${Number(s.slice(0, 2)) >= 50 ? "19" : "20"}${s}` : s;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(full);
  if (!m) throw new Error("bad certificate time");
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
}

function parseCert(raw: Uint8Array): Cert {
  const [tbsNode, algNode, sigNode] = children(der(raw));
  if (!tbsNode || !algNode || !sigNode || sigNode.tag !== 0x03) throw new Error("not an X.509 certificate");
  const hash = SIG_ALGS[hex(children(algNode)[0]!.body)];
  if (!hash) throw new Error("certificate is not signed with ECDSA");
  let fields = children(tbsNode);
  if (fields[0]!.tag === 0xa0) fields = fields.slice(1); // [0] version
  const [, , issuer, validity, subject, spki] = fields; // serial, signature algorithm, issuer, ...
  const [notBefore, notAfter] = children(validity!);
  const curveOid = hex(children(children(spki!)[0]!)[1]!.body);
  const curve = CURVES[curveOid];
  if (!curve) throw new Error("certificate key is not on P-256 or P-384");
  return {
    raw, tbs: tbsNode.whole, hash, signature: sigNode.body.subarray(1), // a BIT STRING's first byte is its unused bits
    issuer: hex(issuer!.whole), subject: hex(subject!.whole),
    notBefore: time(notBefore!), notAfter: time(notAfter!), spki: spki!.whole, curve,
  };
}

/** An ECDSA signature as DER SEQUENCE {r, s}, as WebCrypto wants it: r and s, fixed width. */
function rawSignature(sig: Uint8Array, size: number) {
  const [r, s] = children(der(sig));
  const fixed = (n: Uint8Array) => {
    const trimmed = n[0] === 0 ? n.subarray(1) : n;
    if (trimmed.length > size) throw new Error("bad ECDSA signature");
    return concat(new Uint8Array(size - trimmed.length), trimmed);
  };
  return concat(fixed(r!.body), fixed(s!.body));
}

const importKey = (c: Cert) => crypto.subtle.importKey("spki", buf(c.spki), { name: "ECDSA", namedCurve: c.curve.name }, false, ["verify"]);

// ---- the document ----

const base64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const asBytes = (value: Cbor | undefined, what: string) => {
  if (!(value instanceof Uint8Array)) throw new Error(`attestation ${what} is missing`);
  return value;
};

/** Checks a Nitro attestation document (base64 COSE_Sign1) and returns what it attests. Throws otherwise. */
export async function verifyNitroAttestation(document: string, policy: NitroPolicy): Promise<NitroDocument> {
  const cose = decodeCbor(base64(document));
  const sign1 = cose && typeof cose === "object" && "tag" in cose ? cose.value : cose;
  if (!Array.isArray(sign1) || sign1.length !== 4) throw new Error("not a COSE_Sign1 document");
  const [protectedHeader, , payload, signature] = sign1;
  if (!(protectedHeader instanceof Uint8Array) || !(payload instanceof Uint8Array) || !(signature instanceof Uint8Array)) throw new Error("malformed COSE_Sign1");
  const alg = decodeCbor(protectedHeader);
  if (!(alg instanceof Map) || alg.get(1) !== -35) throw new Error("attestation is not signed with ES384");

  const doc = decodeCbor(payload);
  if (!(doc instanceof Map)) throw new Error("attestation payload is not a map");
  const bundle = doc.get("cabundle");
  if (!Array.isArray(bundle) || bundle.length === 0) throw new Error("attestation cabundle is missing");
  // cabundle runs root first, then intermediates; the leaf signs the document.
  const chain = [...bundle.map((c) => parseCert(asBytes(c, "cabundle entry"))), parseCert(asBytes(doc.get("certificate"), "certificate"))];
  const fingerprint = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", buf(chain[0]!.raw))));
  if (fingerprint !== (policy.rootSha256 ?? AWS_NITRO_ROOT_SHA256).replace(/:/g, "").toLowerCase()) throw new Error("attestation does not chain to the pinned root");
  const now = policy.now ?? Date.now();
  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i]!, issuer = chain[Math.max(0, i - 1)]!;
    if (cert.issuer !== issuer.subject) throw new Error(`attestation certificate ${i} is not issued by the one before it`);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: cert.hash }, await importKey(issuer), rawSignature(cert.signature, issuer.curve.size), buf(cert.tbs));
    if (!ok) throw new Error(`attestation certificate ${i} is not signed by its issuer`);
    if (cert.notBefore > now || cert.notAfter < now) throw new Error(`attestation certificate ${i} is not valid now`);
  }
  const leaf = chain.at(-1)!;
  const toSign = concat(head(4, 4), Uint8Array.of(0x6a), new TextEncoder().encode("Signature1"), cborBytes(protectedHeader), cborBytes(new Uint8Array()), cborBytes(payload));
  if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-384" }, await importKey(leaf), buf(signature), toSign))) throw new Error("attestation signature does not verify");

  const pcrMap = doc.get("pcrs");
  if (!(pcrMap instanceof Map)) throw new Error("attestation pcrs are missing");
  const pcrs: Record<number, string> = {};
  for (const [k, v] of pcrMap) if (typeof k === "number" && v instanceof Uint8Array) pcrs[k] = hex(v);
  if (!pcrs[0] || /^0+$/.test(pcrs[0])) throw new Error("the enclave runs in debug mode (PCR0 is zero)");
  const trusted = (Array.isArray(policy.pcr0) ? policy.pcr0 : policy.pcr0.split(",")).map((p) => p.trim().toLowerCase());
  if (!trusted.includes(pcrs[0])) throw new Error("the keeper is not running a trusted image (PCR0 mismatch)");

  const timestamp = Number(doc.get("timestamp"));
  const age = now - timestamp;
  if (!(age >= -60_000 && age <= policy.maxAgeMs)) throw new Error("attestation is stale");
  const nonceBytes = doc.get("nonce");
  const nonce = nonceBytes instanceof Uint8Array ? new TextDecoder().decode(nonceBytes) : null;
  if (policy.nonce !== undefined && nonce !== policy.nonce) throw new Error("attestation nonce mismatch");
  const key = doc.get("public_key");
  return { moduleId: String(doc.get("module_id") ?? ""), timestamp, pcrs, publicKey: key instanceof Uint8Array ? `0x${hex(key)}` : null, nonce };
}

/** The keeper's fact-signing key a verified document names. Throws if it names none. */
export async function attestedKeeperKey(document: string, policy: NitroPolicy): Promise<string> {
  const { publicKey } = await verifyNitroAttestation(document, policy);
  if (!publicKey || !/^0x0[23][0-9a-f]{64}$/.test(publicKey)) throw new Error("attestation names no keeper key");
  return publicKey;
}
