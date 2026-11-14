//! What the contract checks: a player's EIP-712 `MakeoNearEntry`, and the Makeo keeper's signed
//! hidden-game step. Both are plain secp256k1 over 32-byte digests, so `env::ecrecover` does it.

use near_sdk::env;

/// EIP-712 domain: `{ name: "Makeo Games", version: "1", chainId: 398 }` (398 = NEAR testnet).
pub const EIP712_NAME: &str = "Makeo Games";
pub const EIP712_VERSION: &str = "1";
pub const EIP712_CHAIN_ID: u64 = 398;
pub const ENTRY_TYPE: &str =
    "MakeoNearEntry(string game,address seat,string payout,uint128 stake,uint64 expiresAtMs)";

fn word_u128(v: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

pub fn domain_separator() -> Vec<u8> {
    let mut buf = Vec::with_capacity(32 * 4);
    buf.extend(env::keccak256(b"EIP712Domain(string name,string version,uint256 chainId)"));
    buf.extend(env::keccak256(EIP712_NAME.as_bytes()));
    buf.extend(env::keccak256(EIP712_VERSION.as_bytes()));
    buf.extend(word_u128(EIP712_CHAIN_ID as u128));
    env::keccak256(&buf)
}

/// The digest a seat's EVM wallet signs (`eth_signTypedData_v4`) to enter `game`, paid to `payout`.
pub fn entry_digest(game: &str, seat: &[u8; 20], payout: &str, stake: u128, expires_at_ms: u64) -> Vec<u8> {
    let mut s = Vec::with_capacity(32 * 6);
    s.extend(env::keccak256(ENTRY_TYPE.as_bytes()));
    s.extend(env::keccak256(game.as_bytes()));
    let mut addr = [0u8; 32];
    addr[12..].copy_from_slice(seat);
    s.extend(addr);
    s.extend(env::keccak256(payout.as_bytes()));
    s.extend(word_u128(stake));
    s.extend(word_u128(expires_at_ms as u128));
    let struct_hash = env::keccak256(&s);
    let mut m = Vec::with_capacity(66);
    m.extend([0x19, 0x01]);
    m.extend(domain_separator());
    m.extend(struct_hash);
    env::keccak256(&m)
}

pub fn parse_hex(s: &str) -> Option<Vec<u8>> {
    hex::decode(s.strip_prefix("0x").unwrap_or(s)).ok()
}

/// `0x` + 40 hex, lowercased.
pub fn parse_address(s: &str) -> Option<[u8; 20]> {
    let s = s.strip_prefix("0x")?;
    if s.len() != 40 {
        return None;
    }
    hex::decode(s).ok()?.try_into().ok()
}

pub fn address_of(pubkey64: &[u8; 64]) -> [u8; 20] {
    env::keccak256(pubkey64)[12..].try_into().unwrap()
}

/// SEC1 compressed key, `0x02|0x03` + x, as the keeper publishes it (`publicKey` in feeds/src/fact.ts).
pub fn compress(pubkey64: &[u8; 64]) -> String {
    let mut c = Vec::with_capacity(33);
    c.push(if pubkey64[63] & 1 == 1 { 3 } else { 2 });
    c.extend(&pubkey64[..32]);
    format!("0x{}", hex::encode(c))
}

/// The EVM address that signed `digest` with a 65-byte `r||s||v` signature (v = 27/28 or 0/1).
pub fn recover_address(digest: &[u8], sig65: &[u8]) -> Option<[u8; 20]> {
    if sig65.len() != 65 {
        return None;
    }
    let v = sig65[64];
    let v = if v >= 27 { v - 27 } else { v };
    if v > 1 {
        return None;
    }
    let pk = env::ecrecover(digest, &sig65[..64], v, true)?;
    Some(address_of(&pk))
}

/// Every compressed key a 64-byte `r||s` signature over `digest` could be from (v = 0, 1).
pub fn recover_keys(digest: &[u8], sig64: &[u8]) -> Vec<String> {
    if sig64.len() != 64 {
        return vec![];
    }
    (0..2u8).filter_map(|v| env::ecrecover(digest, sig64, v, true)).map(|pk| compress(&pk)).collect()
}

/// `0x` + the lowercase hex of sha256(bytes).
fn sha256_hex(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(env::sha256(bytes)))
}

/// `hashValue("makeo:runtime:state:v1", state)`: `state` must already be canonical JSON.
pub fn state_hash(canonical_state: &str) -> String {
    let mut b = Vec::with_capacity(canonical_state.len() + 48);
    b.extend(br#"{"domain":"makeo:runtime:state:v1","value":"#);
    b.extend(canonical_state.as_bytes());
    b.push(b'}');
    sha256_hex(&b)
}

/// `hashValue("makeo:hidden:step:v1", {instance, head, count, state})`, the digest the keeper signs.
pub fn step_digest(instance: &str, head: &str, count: u64, state_hash: &str) -> Vec<u8> {
    let instance = near_sdk::serde_json::to_string(instance).unwrap();
    let s = format!(
        r#"{{"domain":"makeo:hidden:step:v1","value":{{"count":{count},"head":"{head}","instance":{instance},"state":"{state_hash}"}}}}"#
    );
    env::sha256(s.as_bytes())
}

pub fn is_hash_hex(s: &str) -> bool {
    s.len() == 66 && s.starts_with("0x") && s[2..].bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
