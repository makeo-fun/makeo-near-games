use super::*;
use k256::ecdsa::SigningKey;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::testing_env;

const ONE: u128 = 1_000_000_000_000_000_000_000_000; // 1 NEAR
const STAKE: u128 = ONE / 10;
const GAME: &str = "nearwolf-test-1";
const HEAD: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(who: &str, deposit: u128, now_ms: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("pot.testnet"))
        .predecessor_account_id(acc(who))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now_ms * 1_000_000)
        .build());
}

fn key(n: u8) -> SigningKey {
    SigningKey::from_slice(&[n; 32]).unwrap()
}

fn pub64(k: &SigningKey) -> [u8; 64] {
    k.verifying_key().to_encoded_point(false).as_bytes()[1..].try_into().unwrap()
}

fn seat_of(k: &SigningKey) -> String {
    format!("0x{}", hex::encode(proof::address_of(&pub64(k))))
}

fn compressed(k: &SigningKey) -> String {
    format!("0x{}", hex::encode(k.verifying_key().to_encoded_point(true).as_bytes()))
}

/// What an EVM wallet's eth_signTypedData_v4 gives: r||s||v, v = 27/28.
fn sign_entry(k: &SigningKey, game: &str, payout: &str, stake: u128, exp: u64) -> String {
    let seat = proof::parse_address(&seat_of(k)).unwrap();
    let d = proof::entry_digest(game, &seat, payout, stake, exp);
    let (sig, rec) = k.sign_prehash_recoverable(&d).unwrap();
    let mut b = sig.to_bytes().to_vec();
    b.push(27 + rec.to_byte());
    format!("0x{}", hex::encode(b))
}

/// What the keeper gives: r||s, low-S, over the step.
fn sign_step(k: &SigningKey, game: &str, head: &str, count: u64, state: &str) -> String {
    let step = proof::step_digest(game, head, count, &proof::state_hash(state));
    let (sig, _) = k.sign_prehash_recoverable(&step).unwrap();
    format!("0x{}", hex::encode(sig.to_bytes()))
}

fn setup() -> (Pot, SigningKey) {
    ctx("owner.testnet", 0, 1_000);
    let mut pot = Pot::new(acc("owner.testnet"));
    let keeper = key(9);
    pot.register_keeper(compressed(&keeper), "0xabc".into());
    pot.add_operator(acc("operator.testnet"));
    ctx("operator.testnet", 0, 1_000);
    pot.open_game(GAME.into(), "0xrules".into(), U128(STAKE), 4, 100_000);
    (pot, keeper)
}

fn enter(pot: &mut Pot, k: &SigningKey, payout: &str) {
    ctx("operator.testnet", STAKE, 2_000);
    let sig = sign_entry(k, GAME, payout, STAKE, 50_000);
    pot.enter(GAME.into(), seat_of(k), acc(payout), U128(STAKE), 50_000, sig);
}

fn state_with(winners: &[String], extra: &str) -> String {
    let w = winners.iter().map(|w| format!("\"{w}\"")).collect::<Vec<_>>().join(",");
    format!(r#"{{"count":7,"finished":true,"game":{{{extra}"phase":"over","winners":[{w}]}},"head":"{HEAD}"}}"#)
}

fn transfers() -> Vec<(String, u128)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                near_sdk::mock::MockAction::Transfer { deposit, .. } => Some((to.clone(), deposit.as_yoctonear())),
                _ => None,
            })
        })
        .collect()
}

#[test]
fn hashes_match_the_keeper() {
    // Golden values from canonical JSON + sha256, exactly as runtime/feeds/src/fact.ts `hashValue` does
    // (cross-checked against the keeper's own code in verify/keeper.test.ts).
    let state = r#"{"finished":true,"game":{"winners":["0x00000000000000000000000000000000000000aa"]}}"#;
    ctx("x.testnet", 0, 1);
    let sh = proof::state_hash(state);
    assert_eq!(sh, "0x4bcdf645101ac16eede81a01d7aee4ccda687d1cb39ff480bf6d6b9e92a13b0b");
    let step = proof::step_digest(GAME, HEAD, 42, &sh);
    assert_eq!(hex::encode(step), "848a51d344f25a471636a97521474338ef5e1018401d8ea246219cb86d0f787a");
}

#[test]
fn enter_checks_the_seat_signature() {
    let (mut pot, _) = setup();
    let alice = key(1);
    enter(&mut pot, &alice, "alice.testnet");
    let g = pot.get_game(GAME.into()).unwrap();
    assert_eq!(g.seats, vec![seat_of(&alice)]);
    assert_eq!(g.pot.0, STAKE);
    let e = pot.get_entry(GAME.into(), seat_of(&alice)).unwrap();
    assert_eq!(e.payout, acc("alice.testnet"));
    assert_eq!(e.payer, acc("operator.testnet"));
}

#[test]
#[should_panic(expected = "not signed by this seat")]
fn enter_refuses_someone_elses_seat() {
    let (mut pot, _) = setup();
    let (alice, mallory) = (key(1), key(2));
    ctx("mallory.testnet", STAKE, 2_000);
    // Mallory signs for her own key but claims Alice's seat, to be paid Alice's winnings.
    let sig = sign_entry(&mallory, GAME, "mallory.testnet", STAKE, 50_000);
    pot.enter(GAME.into(), seat_of(&alice), acc("mallory.testnet"), U128(STAKE), 50_000, sig);
}

#[test]
#[should_panic(expected = "not signed by this seat")]
fn enter_refuses_a_changed_payout() {
    let (mut pot, _) = setup();
    let alice = key(1);
    ctx("operator.testnet", STAKE, 2_000);
    let sig = sign_entry(&alice, GAME, "alice.testnet", STAKE, 50_000);
    pot.enter(GAME.into(), seat_of(&alice), acc("mallory.testnet"), U128(STAKE), 50_000, sig);
}

#[test]
#[should_panic(expected = "attach exactly the stake")]
fn enter_needs_the_stake() {
    let (mut pot, _) = setup();
    let alice = key(1);
    ctx("operator.testnet", STAKE - 1, 2_000);
    let sig = sign_entry(&alice, GAME, "alice.testnet", STAKE, 50_000);
    pot.enter(GAME.into(), seat_of(&alice), acc("alice.testnet"), U128(STAKE), 50_000, sig);
}

#[test]
#[should_panic(expected = "expired")]
fn enter_refuses_an_expired_signature() {
    let (mut pot, _) = setup();
    let alice = key(1);
    ctx("operator.testnet", STAKE, 60_000);
    let sig = sign_entry(&alice, GAME, "alice.testnet", STAKE, 50_000);
    pot.enter(GAME.into(), seat_of(&alice), acc("alice.testnet"), U128(STAKE), 50_000, sig);
}

#[test]
#[should_panic(expected = "this seat has entered")]
fn enter_once_per_seat() {
    let (mut pot, _) = setup();
    let alice = key(1);
    enter(&mut pot, &alice, "alice.testnet");
    enter(&mut pot, &alice, "alice.testnet");
}

#[test]
fn settle_pays_the_keepers_winners_and_mints_badges() {
    let (mut pot, keeper) = setup();
    let (a, b, c) = (key(1), key(2), key(3));
    enter(&mut pot, &a, "alice.testnet");
    enter(&mut pot, &b, "bob.testnet");
    enter(&mut pot, &c, "carol.testnet");
    let state = state_with(&[seat_of(&a), seat_of(&c)], "");
    let sig = sign_step(&keeper, GAME, HEAD, 42, &state);
    ctx("anyone.testnet", 0, 3_000);
    let r = pot.settle(GAME.into(), 42, HEAD.into(), state.clone(), sig);
    assert_eq!(r.keeper, compressed(&keeper));
    assert_eq!(r.state_hash, proof::state_hash(&state));
    assert!(!r.refunded);
    let paid: u128 = r.payouts.iter().map(|p| p.amount.0).sum();
    assert_eq!(paid, 3 * STAKE);
    assert_eq!(r.payouts[0].account, acc("alice.testnet"));
    assert_eq!(r.payouts[1].account, acc("carol.testnet"));
    let t = transfers();
    assert!(t.contains(&("alice.testnet".into(), 3 * STAKE / 2)));
    assert!(t.contains(&("carol.testnet".into(), 3 * STAKE / 2)));
    let token = badge_token(GAME);
    assert_eq!(pot.mt_balance_of(acc("alice.testnet"), token.clone()).0, 1);
    assert_eq!(pot.mt_balance_of(acc("bob.testnet"), token.clone()).0, 0);
    assert_eq!(pot.mt_supply(token.clone()).unwrap().0, 2);
    assert_eq!(pot.mt_tokens_for_owner(acc("carol.testnet"), None, None)[0].token_id, token);
    assert!(get_logs().iter().any(|l| l.contains("\"nep245\"") && l.contains("mt_mint")));
    assert_eq!(pot.get_game(GAME.into()).unwrap().status, Status::Settled);
    assert_eq!(pot.get_record(GAME.into()).unwrap().winners.len(), 2);
}

#[test]
fn settle_splits_by_shares() {
    let (mut pot, keeper) = setup();
    let (a, b) = (key(1), key(2));
    enter(&mut pot, &a, "alice.testnet");
    enter(&mut pot, &b, "bob.testnet");
    let state = state_with(&[seat_of(&a), seat_of(&b)], r#""shares":[3,1],"#);
    let sig = sign_step(&keeper, GAME, HEAD, 9, &state);
    ctx("anyone.testnet", 0, 3_000);
    let r = pot.settle(GAME.into(), 9, HEAD.into(), state, sig);
    assert_eq!(r.payouts[0].amount.0, 2 * STAKE * 3 / 4);
    assert_eq!(r.payouts[1].amount.0, 2 * STAKE / 4);
}

#[test]
fn a_draw_refunds_every_payer() {
    let (mut pot, keeper) = setup();
    let (a, b) = (key(1), key(2));
    enter(&mut pot, &a, "alice.testnet");
    enter(&mut pot, &b, "bob.testnet");
    let state = state_with(&[], "");
    let sig = sign_step(&keeper, GAME, HEAD, 9, &state);
    ctx("anyone.testnet", 0, 3_000);
    let r = pot.settle(GAME.into(), 9, HEAD.into(), state, sig);
    assert!(r.refunded);
    assert_eq!(transfers(), vec![("operator.testnet".into(), STAKE), ("operator.testnet".into(), STAKE)]);
}

#[test]
#[should_panic(expected = "not signed by a registered keeper")]
fn settle_refuses_another_signer() {
    let (mut pot, _) = setup();
    let a = key(1);
    enter(&mut pot, &a, "alice.testnet");
    let state = state_with(&[seat_of(&a)], "");
    let sig = sign_step(&key(7), GAME, HEAD, 9, &state);
    ctx("anyone.testnet", 0, 3_000);
    pot.settle(GAME.into(), 9, HEAD.into(), state, sig);
}

#[test]
#[should_panic(expected = "not signed by a registered keeper")]
fn settle_refuses_a_changed_state() {
    let (mut pot, keeper) = setup();
    let (a, b) = (key(1), key(2));
    enter(&mut pot, &a, "alice.testnet");
    enter(&mut pot, &b, "bob.testnet");
    let signed = state_with(&[seat_of(&a)], "");
    let sig = sign_step(&keeper, GAME, HEAD, 9, &signed);
    ctx("anyone.testnet", 0, 3_000);
    pot.settle(GAME.into(), 9, HEAD.into(), state_with(&[seat_of(&b)], ""), sig);
}

#[test]
#[should_panic(expected = "not signed by a registered keeper")]
fn settle_refuses_another_games_step() {
    let (mut pot, keeper) = setup();
    let a = key(1);
    enter(&mut pot, &a, "alice.testnet");
    let state = state_with(&[seat_of(&a)], "");
    let sig = sign_step(&keeper, "some-other-game", HEAD, 9, &state);
    ctx("anyone.testnet", 0, 3_000);
    pot.settle(GAME.into(), 9, HEAD.into(), state, sig);
}

#[test]
#[should_panic(expected = "has not finished")]
fn settle_needs_a_finished_game() {
    let (mut pot, keeper) = setup();
    let a = key(1);
    enter(&mut pot, &a, "alice.testnet");
    let state = state_with(&[seat_of(&a)], "").replace("\"finished\":true", "\"finished\":false");
    let sig = sign_step(&keeper, GAME, HEAD, 9, &state);
    ctx("anyone.testnet", 0, 3_000);
    pot.settle(GAME.into(), 9, HEAD.into(), state, sig);
}

#[test]
#[should_panic(expected = "settled or refunding")]
fn settle_once() {
    let (mut pot, keeper) = setup();
    let a = key(1);
    enter(&mut pot, &a, "alice.testnet");
    let state = state_with(&[seat_of(&a)], "");
    let sig = sign_step(&keeper, GAME, HEAD, 9, &state);
    ctx("anyone.testnet", 0, 3_000);
    pot.settle(GAME.into(), 9, HEAD.into(), state.clone(), sig.clone());
    pot.settle(GAME.into(), 9, HEAD.into(), state, sig);
}

#[test]
fn a_winner_who_did_not_enter_is_not_paid() {
    let (mut pot, keeper) = setup();
    let (a, outsider) = (key(1), key(5));
    enter(&mut pot, &a, "alice.testnet");
    let state = state_with(&[seat_of(&outsider), seat_of(&a)], "");
    let sig = sign_step(&keeper, GAME, HEAD, 9, &state);
    ctx("anyone.testnet", 0, 3_000);
    let r = pot.settle(GAME.into(), 9, HEAD.into(), state, sig);
    assert_eq!(r.payouts.len(), 1);
    assert_eq!(r.payouts[0].amount.0, STAKE);
}

#[test]
fn refund_after_the_deadline() {
    let (mut pot, _) = setup();
    let a = key(1);
    enter(&mut pot, &a, "alice.testnet");
    ctx("anyone.testnet", 0, 100_001);
    pot.refund(GAME.into(), seat_of(&a));
    assert_eq!(transfers(), vec![("operator.testnet".into(), STAKE)]);
    assert_eq!(pot.get_game(GAME.into()).unwrap().status, Status::Refunding);
    assert!(pot.get_entry(GAME.into(), seat_of(&a)).unwrap().refunded);
}

#[test]
#[should_panic(expected = "deadline has not passed")]
fn no_refund_before_the_deadline() {
    let (mut pot, _) = setup();
    let a = key(1);
    enter(&mut pot, &a, "alice.testnet");
    ctx("anyone.testnet", 0, 99_999);
    pot.refund(GAME.into(), seat_of(&a));
}

#[test]
#[should_panic(expected = "only the owner or an operator")]
fn strangers_cannot_open_games() {
    let (mut pot, _) = setup();
    ctx("stranger.testnet", 0, 1_000);
    pot.open_game("g2".into(), "0x".into(), U128(1), 2, 10_000);
}

#[test]
#[should_panic(expected = "only the owner")]
fn only_the_owner_registers_keepers() {
    let (mut pot, _) = setup();
    ctx("operator.testnet", 0, 1_000);
    pot.register_keeper(compressed(&key(4)), "0x".into());
}

#[test]
#[should_panic(expected = "soulbound")]
fn badges_do_not_move() {
    let (mut pot, _) = setup();
    ctx("alice.testnet", 1, 1_000);
    pot.mt_transfer();
}
