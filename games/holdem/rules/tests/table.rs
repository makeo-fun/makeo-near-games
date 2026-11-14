//! The game at a paid, hidden table: buy-ins, hands dealt with secret luck, each player's own
//! cards, showdowns staged from history, folded hands never shown, leaving mid-hand.
use makeo_runtime::testkit::{self, wallet, Harness};
use makeo_runtime::TableRules;
use makeo_series::table::{Program, State};
use near_holdem::{Holdem as Game, Hand, SHOWDOWN_MS};
use serde_json::{json, Value};

type P = Program<Game>;
const CHIP: u128 = 10_000;
const SECRET: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";

fn table() -> Harness<P> {
    let config = json!({
        "table": {"chip": CHIP.to_string(), "min_buyin": 100, "max_buyin": 400, "seats": 6, "gap_ms": 0, "closes_ms": 3_600_000,
            "fees": {"platform_bps": 0, "creator_bps": 0, "platform": wallet(8).to_lowercase(), "creator": wallet(9).to_lowercase()}},
        "rules": {"small_blind": 1, "big_blind": 2, "turn_ms": 25_000}
    });
    Harness::new(testkit::manifest(Game::ID, config, &[])).hidden(SECRET)
}

fn view(h: &Harness<P>) -> Value {
    h.output.as_ref().unwrap().journal.public_view.clone()
}

fn hand(h: &Harness<P>) -> Hand {
    h.game::<State<Hand>>().hand.expect("a hand in play").game
}

fn seated(players: &[u8]) -> Harness<P> {
    let mut h = table();
    for (seat, p) in players.iter().enumerate() {
        h.deposit(*p, 100 * CHIP).unwrap();
        h.act(*p, json!({"table": "sit", "seat": seat})).unwrap();
    }
    h
}

fn player_of(wallet_hex: &str) -> u8 {
    (1..=9).find(|n| wallet(*n).eq_ignore_ascii_case(wallet_hex)).unwrap()
}

/// Plays the hand in play to its end: `choice(player, options)` gives each move.
fn play_out(h: &mut Harness<P>, choice: impl Fn(u8, &Value) -> Value) {
    let id = view(h)["hand"]["id"].clone();
    while view(h)["hand"]["id"] == id {
        let Some(actor) = view(h)["hand"]["actor"].as_str().map(str::to_string) else { break };
        let p = player_of(&actor);
        let options = h.view_for(p).unwrap()["hand"]["game"]["options"].clone();
        h.act(p, json!({"game": choice(p, &options)})).unwrap();
    }
}

fn passive(_: u8, o: &Value) -> Value {
    if o["check"].as_bool().unwrap() { json!({"move": "check"}) } else { json!({"move": "call"}) }
}

fn stacks(h: &Harness<P>) -> Vec<u64> {
    view(h)["seats"].as_object().unwrap().values().map(|s| s["stack"].as_u64().unwrap()).collect()
}

#[test]
fn a_hand_from_buy_in_to_showdown() {
    let mut h = seated(&[1, 2, 3]);
    // Two sat and a hand was dealt; the third waits for the next. Play the first out.
    play_out(&mut h, passive);
    h.wait(SHOWDOWN_MS);
    h.tick().unwrap();
    assert_eq!(view(&h)["phase"], "Playing");
    let dealt = hand(&h);
    assert_eq!(dealt.players.len(), 3);
    // Nobody sees a card in the public view; each player sees exactly their own two.
    assert!(view(&h)["hand"]["game"]["hole"].as_array().unwrap().iter().all(Value::is_null));
    for p in 1..=3u8 {
        let mine = h.view_for(p).unwrap()["hand"]["game"]["hole"].clone();
        let me = dealt.players.iter().position(|s| s.wallet.eq_ignore_ascii_case(&wallet(p))).unwrap();
        for (i, c) in mine.as_array().unwrap().iter().enumerate() {
            if i == me { assert_eq!(c, &json!(dealt.hole[i])) } else { assert!(c.is_null()) }
        }
    }
    let before: u64 = stacks(&h).iter().sum();
    play_out(&mut h, passive);
    // The showdown is in the history with every hand still in face up, named, and the board.
    let last = view(&h)["history"].as_array().unwrap().last().unwrap().clone();
    let shown = &last["public_hand"]["game"];
    assert_eq!(shown["street"], "Showdown");
    assert_eq!(shown["board"].as_array().unwrap().len(), 5);
    assert!(shown["hole"].as_array().unwrap().iter().all(Value::is_array));
    assert!(shown["showdown"]["names"][0].is_string());
    let changes: i64 = last["changes"].as_object().unwrap().values().map(|v| v.as_i64().unwrap()).sum();
    assert_eq!(changes, 0);
    assert_eq!(stacks(&h).iter().sum::<u64>(), before);
    // The showdown stays up before the next deal.
    assert!(view(&h)["hand"].is_null());
    h.wait(SHOWDOWN_MS - 100);
    h.tick().unwrap();
    assert!(view(&h)["hand"].is_null(), "dealt over the showdown");
    h.wait(100);
    h.tick().unwrap();
    assert!(!view(&h)["hand"].is_null());
}

#[test]
fn folded_cards_are_never_shown_in_history() {
    let mut h = seated(&[1, 2, 3]);
    play_out(&mut h, passive);
    h.wait(SHOWDOWN_MS);
    h.tick().unwrap();
    let first = view(&h)["hand"]["actor"].as_str().map(player_of).unwrap();
    play_out(&mut h, |p, o| if p == first { json!({"move": "fold"}) } else { passive(p, o) });
    let last = view(&h)["history"].as_array().unwrap().last().unwrap().clone();
    let game = &last["public_hand"]["game"];
    let players = game["players"].as_array().unwrap();
    let folded = players.iter().position(|s| s["wallet"].as_str().unwrap().eq_ignore_ascii_case(&wallet(first))).unwrap();
    assert!(game["hole"][folded].is_null(), "the folded hand stays hidden: {game}");
    assert!(game["openings"]["hole"][folded].is_null());
    assert_eq!(game["hole"].as_array().unwrap().iter().filter(|c| c.is_array()).count(), 2);
}

#[test]
fn a_fold_deals_the_next_hand_at_once_and_moves_the_button() {
    let mut h = seated(&[1, 2]);
    let id = view(&h)["hand"]["id"].as_u64().unwrap();
    let button = hand(&h).button;
    play_out(&mut h, |_, _| json!({"move": "fold"}));
    assert_eq!(view(&h)["hand"]["id"].as_u64().unwrap(), id + 1);
    assert_ne!(hand(&h).button, button);
    let s = stacks(&h);
    assert_eq!(s.iter().sum::<u64>(), 200);
    assert!(s.contains(&99) && s.contains(&101));
}

#[test]
fn out_of_turn_and_bad_moves_are_refused_by_the_table() {
    let mut h = seated(&[1, 2]);
    let actor = player_of(view(&h)["hand"]["actor"].as_str().unwrap());
    let other = if actor == 1 { 2 } else { 1 };
    assert!(h.act(other, json!({"game": {"move": "call"}})).unwrap_err().contains("turn"));
    assert!(h.act(actor, json!({"game": {"move": "check"}})).unwrap_err().contains("call"));
    assert!(h.act(actor, json!({"game": {"move": "raise", "to": 3}})).unwrap_err().contains("smallest raise"));
    assert!(h.act(actor, json!({"game": {"move": "bet", "to": 3}})).is_err());
    h.act(actor, json!({"game": {"move": "raise", "to": 6}})).unwrap();
}

#[test]
fn the_clock_folds_an_absent_player() {
    let mut h = seated(&[1, 2]);
    let id = view(&h)["hand"]["id"].clone();
    h.wait(25_001);
    h.tick().unwrap();
    assert_ne!(view(&h)["hand"]["id"], id, "the hand ended on the clock");
}

#[test]
fn every_view_carries_seq_and_moves_bump_it() {
    let mut h = seated(&[1, 2]);
    assert_eq!(view(&h)["hand"]["game"]["seq"], 0);
    let actor = player_of(view(&h)["hand"]["actor"].as_str().unwrap());
    h.act(actor, json!({"game": {"move": "call"}})).unwrap();
    assert_eq!(view(&h)["hand"]["game"]["seq"], 1);
    for p in [1u8, 2] {
        assert_eq!(h.view_for(p).unwrap()["hand"]["game"]["seq"], 1);
    }
}

#[test]
fn the_room_keeps_each_hand_only_as_a_hash() {
    let h = seated(&[1, 2]);
    let manifest = serde_json::to_value(&h.manifest).unwrap();
    let room = makeo_runtime::redact::<makeo_series::table::Table<Game>>(&manifest, h.output.as_ref().unwrap()).unwrap();
    let game = &room.state["game"]["hand"]["game"];
    assert!(game.get("hidden").is_some() && game.get("hole").is_none(), "{game}");
}

#[test]
fn leaving_mid_hand_cashes_out_after_it() {
    let mut h = seated(&[1, 2, 3]);
    play_out(&mut h, passive);
    h.wait(SHOWDOWN_MS);
    h.tick().unwrap();
    h.act(3, json!({"table": "leave"})).unwrap();
    assert_eq!(h.paid_to(&wallet(3)), 0);
    play_out(&mut h, |p, o| if p == 3 { json!({"move": "fold"}) } else { passive(p, o) });
    assert!(h.paid_to(&wallet(3)) > 0);
    assert_eq!(view(&h)["seats"].as_object().unwrap().len(), 2);
}
