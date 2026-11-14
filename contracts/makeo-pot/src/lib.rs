//! makeo-pot: pots for Makeo games on NEAR.
//!
//! - A player enters with a stake and an EIP-712 `MakeoNearEntry` signed by their seat's EVM wallet,
//!   which binds the seat that plays to the NEAR account that is paid.
//! - Only the Makeo keeper (an attested AWS Nitro enclave) settles: `settle` takes the full final
//!   state of the hidden game and the keeper's signature over its step (see SPEC.md "Result format"),
//!   rebuilds the digest, recovers the signer and checks it is a registered keeper key.
//! - Winners are paid to their payout accounts, get a soulbound NEP-245 badge, and the record stays.
//! - No result by the deadline: every entry can be refunded.

pub mod proof;

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, Value};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise};

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Operators,
    Keepers,
    Games,
    Entries,
    Records,
    Badges,
    BadgeSupply,
    BadgesOf,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Open,
    Settled,
    Refunding,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Keeper {
    /// SEC1 compressed secp256k1 key, `0x02…`/`0x03…`, as the keeper's `/health` and attestation name it.
    pub pubkey: String,
    /// The enclave image it was attested from (hex PCR0), public and auditable.
    pub pcr0: String,
    pub registered_at_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Game {
    pub game: String,
    pub rules_digest: String,
    pub stake: U128,
    pub max_seats: u32,
    pub deadline_ms: u64,
    pub seats: Vec<String>,
    pub pot: U128,
    pub status: Status,
    pub opened_by: AccountId,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Entry {
    pub seat: String,
    pub payout: AccountId,
    /// Who attached the stake (the player, or the operator that sponsors it); refunds go back here.
    pub payer: AccountId,
    pub stake: U128,
    pub refunded: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Payout {
    pub seat: String,
    pub account: AccountId,
    pub amount: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Record {
    pub game: String,
    pub rules_digest: String,
    pub count: u64,
    pub head: String,
    pub state_hash: String,
    pub step: String,
    pub keeper: String,
    pub winners: Vec<String>,
    pub payouts: Vec<Payout>,
    /// True when no winner had entered (or the game was a draw): every stake went back to its payer.
    pub refunded: bool,
    pub settled_at_ms: u64,
    pub settled_by: AccountId,
}

#[near(serializers = [json])]
pub struct MtToken {
    pub token_id: String,
    pub owner_id: Option<AccountId>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Pot {
    owner: AccountId,
    operators: IterableMap<AccountId, ()>,
    keepers: IterableMap<String, Keeper>,
    games: LookupMap<String, Game>,
    entries: LookupMap<String, Entry>,
    records: LookupMap<String, Record>,
    badges: LookupMap<String, u128>,
    badge_supply: LookupMap<String, u128>,
    badges_of: LookupMap<AccountId, Vec<String>>,
}

fn entry_key(game: &str, seat: &str) -> String {
    format!("{game}\n{seat}")
}

fn badge_key(token: &str, owner: &AccountId) -> String {
    format!("{token}\n{owner}")
}

pub fn badge_token(game: &str) -> String {
    format!("makeo:{game}:winner")
}

/// Who won, from the signed state's `game`: its own `winners`, or a Makeo series' `outcome` (the runtime's result:
/// `Ranking` pays its first tier, `Void` refunds everyone).
fn winners_of(game: &Value) -> Vec<Value> {
    if let Some(w) = game.get("winners").and_then(Value::as_array) {
        return w.clone();
    }
    match game.get("outcome") {
        Some(o) if o.get("kind").and_then(Value::as_str) == Some("Ranking") => o
            .get("tiers")
            .and_then(Value::as_array)
            .and_then(|t| t.first())
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        Some(o) if o.get("kind").and_then(Value::as_str) == Some("Void") => vec![],
        _ => env::panic_str("the game state has no winners array and no outcome"),
    }
}

fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

#[near]
impl Pot {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            operators: IterableMap::new(Key::Operators),
            keepers: IterableMap::new(Key::Keepers),
            games: LookupMap::new(Key::Games),
            entries: LookupMap::new(Key::Entries),
            records: LookupMap::new(Key::Records),
            badges: LookupMap::new(Key::Badges),
            badge_supply: LookupMap::new(Key::BadgeSupply),
            badges_of: LookupMap::new(Key::BadgesOf),
        }
    }

    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
    }

    // ---------- owner ----------

    /// Registers a keeper key with the PCR0 its attestation came from. Owner only.
    pub fn register_keeper(&mut self, pubkey_secp256k1: String, pcr0: String) {
        self.only_owner();
        let pubkey = pubkey_secp256k1.to_lowercase();
        let raw = proof::parse_hex(&pubkey).unwrap_or_default();
        require!(raw.len() == 33 && (raw[0] == 2 || raw[0] == 3), "a compressed secp256k1 key: 0x02/0x03 + 64 hex");
        require!(pubkey.starts_with("0x"), "a key is 0x-prefixed");
        let keeper = Keeper { pubkey: pubkey.clone(), pcr0: pcr0.to_lowercase(), registered_at_ms: now_ms() };
        env::log_str(&format!("keeper registered {pubkey} pcr0 {}", keeper.pcr0));
        self.keepers.insert(pubkey, keeper);
    }

    pub fn remove_keeper(&mut self, pubkey_secp256k1: String) {
        self.only_owner();
        self.keepers.remove(&pubkey_secp256k1.to_lowercase());
    }

    pub fn add_operator(&mut self, account_id: AccountId) {
        self.only_owner();
        self.operators.insert(account_id, ());
    }

    pub fn remove_operator(&mut self, account_id: AccountId) {
        self.only_owner();
        self.operators.remove(&account_id);
    }

    // ---------- games ----------

    /// Opens a pot for one keeper instance (`game` = the keeper's instance id). Owner or operator.
    pub fn open_game(&mut self, game: String, rules_digest: String, stake_yocto: U128, max_seats: u32, deadline_ms: u64) {
        let caller = env::predecessor_account_id();
        require!(caller == self.owner || self.operators.contains_key(&caller), "only the owner or an operator opens games");
        require!(!game.is_empty() && game.len() <= 128, "a game id is 1..128 bytes");
        require!(!self.games.contains_key(&game), "this game is already open");
        require!(max_seats >= 1 && max_seats <= 32, "1..32 seats");
        require!(deadline_ms > now_ms(), "the deadline is in the past");
        self.games.insert(
            game.clone(),
            Game {
                game,
                rules_digest: rules_digest.to_lowercase(),
                stake: stake_yocto,
                max_seats,
                deadline_ms,
                seats: vec![],
                pot: U128(0),
                status: Status::Open,
                opened_by: caller,
            },
        );
    }

    /// Enters `seat` with the attached stake. Anyone may submit it (the operator relays it so the player
    /// needs no gas), but only with the seat's EIP-712 `MakeoNearEntry` signature.
    #[payable]
    pub fn enter(&mut self, game: String, seat: String, payout: AccountId, stake: U128, expires_at_ms: u64, sig: String) {
        let seat = seat.to_lowercase();
        let seat_bytes = proof::parse_address(&seat).unwrap_or_else(|| env::panic_str("a seat is 0x + 40 hex"));
        let mut g = self.games.get(&game).cloned().unwrap_or_else(|| env::panic_str("no such game"));
        require!(g.status == Status::Open, "this game is not open");
        require!(now_ms() < g.deadline_ms, "this game's entry has closed");
        require!(now_ms() < expires_at_ms, "this entry signature has expired");
        require!((g.seats.len() as u32) < g.max_seats, "this game is full");
        require!(!self.entries.contains_key(&entry_key(&game, &seat)), "this seat has entered");
        require!(stake.0 == g.stake.0, "the signed stake is not this game's stake");
        require!(env::attached_deposit().as_yoctonear() == stake.0, "attach exactly the stake");
        let sig = proof::parse_hex(&sig).unwrap_or_default();
        let digest = proof::entry_digest(&game, &seat_bytes, payout.as_str(), stake.0, expires_at_ms);
        let signer = proof::recover_address(&digest, &sig).unwrap_or_else(|| env::panic_str("a bad entry signature"));
        require!(signer == seat_bytes, "the entry is not signed by this seat");
        g.seats.push(seat.clone());
        g.pot = U128(g.pot.0 + stake.0);
        self.games.insert(game.clone(), g);
        self.entries.insert(
            entry_key(&game, &seat),
            Entry { seat: seat.clone(), payout: payout.clone(), payer: env::predecessor_account_id(), stake, refunded: false },
        );
        env::log_str(&format!("enter {game} {seat} -> {payout}"));
    }

    /// Settles a finished hidden game on the keeper's signed step. Anyone may submit it.
    /// `state` is the full final state as canonical JSON; see SPEC.md "Result format".
    pub fn settle(&mut self, game: String, count: u64, head: String, state: String, keeper_sig: String) -> Record {
        let mut g = self.games.get(&game).cloned().unwrap_or_else(|| env::panic_str("no such game"));
        require!(g.status == Status::Open, "this game is settled or refunding");
        let head = head.to_lowercase();
        require!(proof::is_hash_hex(&head), "head is 0x + 64 lowercase hex");
        let state_hash = proof::state_hash(&state);
        let step = proof::step_digest(&game, &head, count, &state_hash);
        let sig = proof::parse_hex(&keeper_sig).unwrap_or_default();
        let keeper = proof::recover_keys(&step, &sig)
            .into_iter()
            .find(|k| self.keepers.contains_key(k))
            .unwrap_or_else(|| env::panic_str("not signed by a registered keeper"));

        let parsed: Value = serde_json::from_str(&state).unwrap_or_else(|_| env::panic_str("state is not JSON"));
        require!(parsed.get("finished") == Some(&Value::Bool(true)), "the game has not finished");
        let inner = parsed.get("game").unwrap_or_else(|| env::panic_str("state has no game"));
        let winners: Vec<String> = winners_of(inner)
            .iter()
            .map(|w| w.as_str().map(str::to_lowercase).unwrap_or_else(|| env::panic_str("a winner is a seat address")))
            .collect();
        let shares: Vec<u128> = match inner.get("shares") {
            None | Some(Value::Null) => vec![1; winners.len()],
            Some(v) => v
                .as_array()
                .unwrap_or_else(|| env::panic_str("shares is an array"))
                .iter()
                .map(|s| s.as_u64().unwrap_or_else(|| env::panic_str("a share is an integer")) as u128)
                .collect(),
        };
        require!(shares.len() == winners.len(), "shares and winners differ in length");

        // Only winners who entered are paid; their weights split the pot.
        let mut paid: Vec<(Entry, u128)> = vec![];
        for (w, share) in winners.iter().zip(shares.iter()) {
            if *share == 0 {
                continue;
            }
            if let Some(e) = self.entries.get(&entry_key(&game, w)) {
                if !paid.iter().any(|(p, _)| &p.seat == w) {
                    paid.push((e.clone(), *share));
                }
            }
        }
        let total_weight: u128 = paid.iter().map(|(_, s)| *s).sum();
        let pot = g.pot.0;
        let mut payouts = vec![];
        let refunded = total_weight == 0;
        if refunded {
            for seat in &g.seats {
                let key = entry_key(&game, seat);
                let mut e = self.entries.get(&key).cloned().unwrap();
                if e.stake.0 > 0 {
                    Promise::new(e.payer.clone()).transfer(NearToken::from_yoctonear(e.stake.0)).detach();
                }
                payouts.push(Payout { seat: seat.clone(), account: e.payer.clone(), amount: e.stake });
                e.refunded = true;
                self.entries.insert(key, e);
            }
        } else {
            let mut given = 0u128;
            let mut amounts: Vec<u128> = paid.iter().map(|(_, s)| pot / total_weight * s + pot % total_weight * s / total_weight).collect();
            given += amounts.iter().sum::<u128>();
            amounts[0] += pot - given; // dust to the first paid winner
            let token = badge_token(&game);
            for ((e, _), amount) in paid.iter().zip(amounts) {
                if amount > 0 {
                    Promise::new(e.payout.clone()).transfer(NearToken::from_yoctonear(amount)).detach();
                }
                payouts.push(Payout { seat: e.seat.clone(), account: e.payout.clone(), amount: U128(amount) });
                self.mint_badge(&token, &e.payout);
            }
        }

        g.status = Status::Settled;
        let record = Record {
            game: game.clone(),
            rules_digest: g.rules_digest.clone(),
            count,
            head,
            state_hash,
            step: format!("0x{}", hex::encode(&step)),
            keeper,
            winners,
            payouts,
            refunded,
            settled_at_ms: now_ms(),
            settled_by: env::predecessor_account_id(),
        };
        self.games.insert(game.clone(), g);
        self.records.insert(game.clone(), record.clone());
        env::log_str(&format!(
            "EVENT_JSON:{}",
            serde_json::json!({"standard": "makeo-pot", "version": "1.0.0", "event": "settle", "data": [&record]})
        ));
        record
    }

    /// After the deadline, an unsettled game's entry goes back to whoever paid its stake. Anyone may call it.
    pub fn refund(&mut self, game: String, seat: String) {
        let seat = seat.to_lowercase();
        let mut g = self.games.get(&game).cloned().unwrap_or_else(|| env::panic_str("no such game"));
        require!(g.status != Status::Settled, "this game is settled");
        require!(now_ms() >= g.deadline_ms, "the deadline has not passed");
        let key = entry_key(&game, &seat);
        let mut e = self.entries.get(&key).cloned().unwrap_or_else(|| env::panic_str("no such entry"));
        require!(!e.refunded, "already refunded");
        e.refunded = true;
        g.status = Status::Refunding;
        g.pot = U128(g.pot.0 - e.stake.0);
        if e.stake.0 > 0 {
            Promise::new(e.payer.clone()).transfer(NearToken::from_yoctonear(e.stake.0)).detach();
        }
        self.entries.insert(key, e);
        self.games.insert(game, g);
    }

    // ---------- views ----------

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn get_keepers(&self) -> Vec<Keeper> {
        self.keepers.values().cloned().collect()
    }

    pub fn get_operators(&self) -> Vec<AccountId> {
        self.operators.keys().cloned().collect()
    }

    pub fn get_game(&self, game: String) -> Option<Game> {
        self.games.get(&game).cloned()
    }

    pub fn get_entry(&self, game: String, seat: String) -> Option<Entry> {
        self.entries.get(&entry_key(&game, &seat.to_lowercase())).cloned()
    }

    pub fn get_record(&self, game: String) -> Option<Record> {
        self.records.get(&game).cloned()
    }

    /// The digest a seat signs to enter (for clients and tests): hex.
    pub fn entry_digest(&self, game: String, seat: String, payout: AccountId, stake: U128, expires_at_ms: u64) -> String {
        let seat = proof::parse_address(&seat.to_lowercase()).unwrap_or_else(|| env::panic_str("a seat is 0x + 40 hex"));
        format!("0x{}", hex::encode(proof::entry_digest(&game, &seat, payout.as_str(), stake.0, expires_at_ms)))
    }

    // ---------- NEP-245 badges (soulbound: minted on settle, never transferred) ----------

    fn mint_badge(&mut self, token: &str, owner: &AccountId) {
        let key = badge_key(token, owner);
        let had = self.badges.get(&key).copied().unwrap_or(0);
        self.badges.insert(key, had + 1);
        let supply = self.badge_supply.get(token).copied().unwrap_or(0);
        self.badge_supply.insert(token.to_string(), supply + 1);
        if had == 0 {
            let mut list = self.badges_of.get(owner).cloned().unwrap_or_default();
            list.push(token.to_string());
            self.badges_of.insert(owner.clone(), list);
        }
        env::log_str(&format!(
            "EVENT_JSON:{}",
            serde_json::json!({"standard": "nep245", "version": "1.0.0", "event": "mt_mint",
                "data": [{"owner_id": owner, "token_ids": [token], "amounts": ["1"], "memo": "Makeo winner badge"}]})
        ));
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(self.badges.get(&badge_key(&token_id, &account_id)).copied().unwrap_or(0))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids.into_iter().map(|t| self.mt_balance_of(account_id.clone(), t)).collect()
    }

    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        self.badge_supply.get(&token_id).map(|s| U128(*s))
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<String>) -> Vec<Option<U128>> {
        token_ids.into_iter().map(|t| self.mt_supply(t)).collect()
    }

    pub fn mt_token(&self, token_ids: Vec<String>) -> Vec<Option<MtToken>> {
        token_ids
            .into_iter()
            .map(|t| self.badge_supply.get(&t).map(|_| MtToken { token_id: t.clone(), owner_id: None }))
            .collect()
    }

    pub fn mt_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u32>) -> Vec<MtToken> {
        let list = self.badges_of.get(&account_id).cloned().unwrap_or_default();
        let from = from_index.map(|f| f.0 as usize).unwrap_or(0);
        let limit = limit.unwrap_or(50) as usize;
        list.into_iter().skip(from).take(limit).map(|t| MtToken { token_id: t, owner_id: Some(account_id.clone()) }).collect()
    }

    pub fn mt_metadata_contract(&self) -> Value {
        serde_json::json!({"spec": "mt-1.0.0", "name": "Makeo game badges", "symbol": "MAKEO",
            "description": "A soulbound badge for each Makeo game won, settled on the keeper's signed result"})
    }

    #[payable]
    pub fn mt_transfer(&mut self) {
        env::panic_str("Makeo badges are soulbound");
    }

    #[payable]
    pub fn mt_batch_transfer(&mut self) {
        env::panic_str("Makeo badges are soulbound");
    }
}

#[cfg(test)]
mod tests;
