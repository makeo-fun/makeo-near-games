// Makeo's canonical JSON and hashValue, as the runtime and the keeper compute them
// (serde_json compact output, object keys sorted by UTF-8 bytes, integers only).
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function canonicalJson(value: Json): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`canonical JSON holds safe integers only, got ${value}`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort(compareUtf8);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as Json)}`).join(",")}}`;
}

function compareUtf8(a: string, b: string) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

/** `0x` + sha256(canonical JSON of `{domain, value}`). */
export function hashValue(domain: string, value: Json): string {
  return `0x${bytesToHex(sha256(new TextEncoder().encode(canonicalJson({ domain, value }))))}`;
}
