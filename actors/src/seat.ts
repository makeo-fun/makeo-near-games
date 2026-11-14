// An AI seat's identity, exactly as a human's: an EVM wallet key (the seat, `0x…`) grants a P-256
// session key with the EIP-712 GameSession grant, and the session key signs moves and view
// requests. Keys come from env (ACTOR_<N>_EVM_KEY) or are made fresh per run (mock rooms).
import { evmAddress, hex, hexToBytes, p256, secp256k1, sessionGrantDigest, type SessionGrant } from "./crypto";

export type Signature = { public_key: string; signature: string };

/** The same shape as the Games SDK's MakeoSigner. */
export interface SeatSigner {
  readonly wallet: string;
  readonly chainId: number;
  readonly grant: SessionGrant;
  sign(digest: string): Promise<Signature>;
  /** The seat's EVM wallet over a 32-byte EIP-712 digest: 0x r||s||v (v = 27/28). Used for MakeoNearEntry. */
  walletSign(digest: Uint8Array): string;
}

export function createSeat(options: { chainId: number; app?: string; evmKey?: string; ttlMs?: number }): SeatSigner {
  const evmKey = options.evmKey ? hexToBytes(options.evmKey.replace(/^0x/, "")) : secp256k1.utils.randomSecretKey();
  const wallet = evmAddress(secp256k1.getPublicKey(evmKey, false));
  const sessionKey = p256.utils.randomSecretKey();
  const sessionPublic = hex(p256.getPublicKey(sessionKey, true));
  const expires_ms = Date.now() + (options.ttlMs ?? 6 * 3600_000);
  // The wallet signs the EIP-712 digest once: r||s||v with v = 27 + recovery (what Privy/ethers return).
  const digest = sessionGrantDigest(options.chainId, wallet, sessionPublic, expires_ms, options.app);
  const walletSign = (d: Uint8Array) => {
    const recovered = secp256k1.sign(d, evmKey, { prehash: false, format: "recovered" }); // [rec, r, s]
    const rsv = new Uint8Array(65);
    rsv.set(recovered.slice(1), 0);
    rsv[64] = 27 + recovered[0]!;
    return hex(rsv);
  };
  const grant: SessionGrant = { key: sessionPublic, expires_ms, wallet_signature: walletSign(digest), ...(options.app ? { app: options.app } : {}) };
  return {
    wallet,
    chainId: options.chainId,
    grant,
    walletSign,
    // The session key signs the UTF-8 text of the 0x digest (ECDSA P-256/SHA-256, raw r||s).
    async sign(text: string) {
      const sig = p256.sign(new TextEncoder().encode(text), sessionKey, { lowS: true });
      return { public_key: sessionPublic, signature: hex(sig) };
    },
  };
}
