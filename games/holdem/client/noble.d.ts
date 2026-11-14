// Types for the two pinned noble modules the Receipt screen uses to recheck AI signatures.
declare module "https://esm.sh/@noble/curves@1.4.0/secp256k1" {
  export const secp256k1: {
    Signature: {
      fromCompact(hex: string): { addRecoveryBit(bit: number): { recoverPublicKey(digest: Uint8Array): { toRawBytes(compressed: boolean): Uint8Array } } };
    };
  };
}
declare module "https://esm.sh/@noble/hashes@1.4.0/sha3" {
  export function keccak_256(data: Uint8Array): Uint8Array;
}
