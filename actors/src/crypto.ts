// The crypto an AI seat needs to be a normal Makeo player. Every digest here is byte-for-byte the
// one the Makeo runtime and keeper check (platform: runtime/crates/core auth.rs, keeper/src/session.ts,
// keeper/src/sealing.ts, packages/games-sdk local-run.ts). Keep them identical.
//
// Also re-exports the few primitives verify/nearai.ts uses, so that file has no package of its own.
import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export { p256, secp256k1, sha256, keccak_256, bytesToHex, hexToBytes };

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const utf8 = (text: string) => new TextEncoder().encode(text);
export const hex = (bytes: Uint8Array) => `0x${bytesToHex(bytes)}`;
export const sha256Hex = (bytes: Uint8Array | string) => bytesToHex(sha256(typeof bytes === "string" ? utf8(bytes) : bytes));

// ---- Canonical JSON and the runtime hash (feeds/src/fact.ts, auth::hash) -------------------------
export function canonicalJson(value: Json): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`runtime JSON holds safe integers only, got ${value}`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort(compareUtf8);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as Json)}`).join(",")}}`;
}
function compareUtf8(a: string, b: string) {
  const x = utf8(a), y = utf8(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}
/** makeo-runtime `auth::hash`: sha256 over sorted-key JSON of {domain, value}, as 0x hex. */
export const runtimeHash = (domain: string, value: unknown) => `0x${sha256Hex(canonicalJson({ domain, value: value as Json }))}`;

/** What a player signs for a move (games-sdk local-run.ts actionDigest). */
export const actionDigest = (manifestHash: string, id: string, actor: string, action: unknown) =>
  runtimeHash("makeo:runtime:action:v1", { manifest: manifestHash, id, actor: actor.toLowerCase(), action });
/** What a player's session key signs to read their own view of a hidden game (keeper hidden.ts). */
export const viewRequestDigest = (instance: string, wallet: string, atMs: number) =>
  runtimeHash("makeo:keeper:view:v1", { instance, wallet: wallet.toLowerCase(), at_ms: atMs });
/** The commitment a sealed move carries (engine.rs sealed_commitment). */
export const sealedCommitment = (action: unknown, nonce: string) => runtimeHash("makeo:runtime:sealed:v1", { action, nonce });

// ---- EIP-712 GameSession grant (keeper/src/session.ts) ------------------------------------------
function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const keccak = (...parts: Uint8Array[]) => keccak_256(concat(...parts));
function word(value: bigint | Uint8Array) {
  const out = new Uint8Array(32);
  if (value instanceof Uint8Array) out.set(value, 32 - value.length);
  else for (let i = 31, v = value; i >= 0 && v > 0n; i--, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
}
const unhex = (text: string) => hexToBytes(text.replace(/^0x/, ""));

export function sessionGrantDigest(chainId: number, wallet: string, sessionKey: string, expiresAtMs: number, app?: string): Uint8Array {
  const domain = keccak(keccak(utf8("EIP712Domain(string name,string version,uint256 chainId)")), keccak(utf8("Makeo Games")), keccak(utf8("1")), word(BigInt(chainId)));
  const fields = [word(unhex(wallet.toLowerCase())), keccak(unhex(sessionKey)), word(BigInt(expiresAtMs))];
  const session = app === undefined
    ? keccak(keccak(utf8("GameSession(address wallet,bytes sessionKey,uint64 expiresAtMs)")), ...fields)
    : keccak(keccak(utf8("GameSession(address wallet,bytes sessionKey,uint64 expiresAtMs,string app)")), ...fields, keccak(utf8(app)));
  return keccak(new Uint8Array([0x19, 0x01]), domain, session);
}

/** The Ethereum address of an uncompressed or compressed secp256k1 public key. */
export function evmAddress(publicKey: Uint8Array): string {
  const full = publicKey.length === 65 ? publicKey : secp256k1.Point.fromBytes(publicKey).toBytes(false);
  return hex(keccak_256(full.slice(1)).slice(12));
}

/** ecrecover over a 32-byte digest and a 65-byte r||s||v signature (v 0/1 or 27/28). */
export function ecrecover(digest: Uint8Array, signature: Uint8Array): string {
  if (signature.length !== 65) throw new Error("an ECDSA recoverable signature is 65 bytes");
  const v = signature[64]! >= 27 ? signature[64]! - 27 : signature[64]!;
  const point = secp256k1.Signature.fromBytes(signature.slice(0, 64), "compact").addRecoveryBit(v).recoverPublicKey(digest);
  return evmAddress(point.toBytes(false));
}

export type SessionGrant = { key: string; expires_ms: number; wallet_signature: string; app?: string };

// ---- Sealed moves (keeper/src/sealing.ts, games-sdk/src/sealing.ts; WebCrypto) -----------------
const INFO = utf8("makeo:sealed-move:v1") as Uint8Array<ArrayBuffer>;
const ab = (u: Uint8Array) => u as Uint8Array<ArrayBuffer>;
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
async function aesKey(shared: ArrayBuffer, salt: Uint8Array) {
  const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: ab(salt), info: INFO }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function sealingKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  return { pair, publicHex: hex(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))) };
}
export async function seal(sealKey: string, instance: string, opened: { action: unknown; nonce: string }) {
  const recipient = await crypto.subtle.importKey("raw", ab(unhex(sealKey)), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const mine = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: recipient }, mine.privateKey, 256);
  const key = await aesKey(shared, utf8(instance));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, ab(utf8(JSON.stringify(opened)))));
  const ephemeral = new Uint8Array(await crypto.subtle.exportKey("raw", mine.publicKey));
  return b64(concat(ephemeral, iv, ciphertext));
}
export async function openSealed(privateKey: CryptoKey, instance: string, sealed: string): Promise<{ action: unknown; nonce: string }> {
  const bytes = ab(unb64(sealed));
  if (bytes.length < 65 + 12 + 16) throw new Error("a sealed move is too short");
  const ephemeral = await crypto.subtle.importKey("raw", bytes.slice(0, 65), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeral }, privateKey, 256);
  const key = await aesKey(shared, utf8(instance));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(65, 77) }, key, bytes.slice(77));
  const value = JSON.parse(new TextDecoder().decode(plain)) as { action?: unknown; nonce?: unknown };
  if (value.action === undefined || typeof value.nonce !== "string") throw new Error("a sealed move holds {action, nonce}");
  return { action: value.action, nonce: value.nonce };
}

// ---- Checks the room/keeper make (used by the mock room so it is as strict as the real one) ----
export function verifySessionGrant(chainId: number, wallet: string, grant: SessionGrant) {
  if (!grant || !/^0x0[23][0-9a-f]{64}$/.test(grant.key)) throw new Error("a grant names a compressed P-256 session key");
  const recovered = ecrecover(sessionGrantDigest(chainId, wallet, grant.key, grant.expires_ms, grant.app), unhex(grant.wallet_signature));
  if (recovered !== wallet.toLowerCase()) throw new Error("session not granted by this wallet");
  if (grant.expires_ms < Date.now()) throw new Error("the session has expired");
}
export function verifySessionSignature(key: string, signature: string, digest: string) {
  const bytes = unhex(signature);
  const ok = p256.verify(bytes, utf8(digest), unhex(key), { format: bytes.length === 64 ? "compact" : "der", lowS: false });
  if (!ok) throw new Error("session signature verification failed");
}
