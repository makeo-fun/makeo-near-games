// Test human seats for a paid NEAR match. A seat enters the pot by signing MakeoNearEntry with its own
// EVM key (the same key that granted its Makeo session), naming a NEAR account to be paid, and the
// operator relays it (POST /enter; the operator sponsors the stake). Agent (AI) seats never do this.
// The digest is the contract's proof::entry_digest (copied from verify/near.ts, cross-checked in tests).
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes, keccak_256 } from "./crypto";
import type { SeatSigner } from "./seat";

export const EIP712_CHAIN_ID = 398; // NEAR testnet, as in verify/near.ts
export type Entry = { game: string; seat: string; payout: string; stake: bigint | string; expiresAtMs: number };

const enc = new TextEncoder();
const word = (n: bigint) => hexToBytes(n.toString(16).padStart(64, "0"));
const k = (s: string) => keccak_256(enc.encode(s));
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

export function entryDigest(e: Entry): Uint8Array {
  const domain = keccak_256(cat(k("EIP712Domain(string name,string version,uint256 chainId)"), k("Makeo Games"), k("1"), word(BigInt(EIP712_CHAIN_ID))));
  const seat = hexToBytes(e.seat.toLowerCase().replace(/^0x/, "").padStart(64, "0"));
  const struct = keccak_256(cat(k("MakeoNearEntry(string game,address seat,string payout,uint128 stake,uint64 expiresAtMs)"), k(e.game), seat, k(e.payout), word(BigInt(e.stake)), word(BigInt(e.expiresAtMs))));
  return keccak_256(cat(Uint8Array.of(0x19, 0x01), domain, struct));
}

/** A fresh NEAR implicit account: its id is the hex of an ed25519 public key (no funding needed to receive). */
export function implicitAccount() {
  const secret = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(secret);
  return { accountId: bytesToHex(pub), secretKeyHex: bytesToHex(secret) };
}

/** NEAR amount ("0.1") to yocto (10^24). */
export function yocto(near: string): bigint {
  const [whole, frac = ""] = near.split(".");
  if (!/^\d+$/.test(whole!) || !/^\d*$/.test(frac) || frac.length > 24) throw new Error(`bad NEAR amount ${near}`);
  return BigInt(whole!) * 10n ** 24n + BigInt(frac.padEnd(24, "0") || "0");
}

/** Signs and relays a test human seat's entry. Returns the operator's answer. */
export async function enterPot(options: { operator: string; signer: SeatSigner; game: string; payout: string; stakeNear: string; ttlMs?: number; fetch?: typeof fetch }) {
  const stake = yocto(options.stakeNear);
  const entry: Entry = { game: options.game, seat: options.signer.wallet, payout: options.payout, stake, expiresAtMs: Date.now() + (options.ttlMs ?? 30 * 60_000) };
  const sig = options.signer.walletSign(entryDigest(entry));
  const body = JSON.stringify({ game: entry.game, seat: entry.seat.toLowerCase(), payout: entry.payout, stake: stake.toString(), expiresAtMs: entry.expiresAtMs, sig });
  // Retry only when the operator could not be reached (nothing was sent on chain); an answer is final.
  let response: Response | null = null;
  for (let attempt = 0; !response; attempt++) {
    try {
      response = await (options.fetch ?? fetch)(`${options.operator.replace(/\/$/, "")}/enter`, { method: "POST", headers: { "content-type": "application/json" }, body });
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || answer.error) throw new Error(`operator /enter: ${String(answer.error ?? response.status)}`);
  return answer;
}
