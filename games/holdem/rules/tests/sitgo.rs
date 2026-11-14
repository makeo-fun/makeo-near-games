//! The sit-and-go: hands one after another, rising blinds, busting, the end, the ranking, and the
//! settlement data (winners, shares and the full final state in the public view).
use makeo_runtime::testkit::{self, wallet, Harness};
use makeo_runtime::{Outcome, Rules, RulesContext};
use makeo_series::{Phase, SeriesState};
use near_holdem::{Game, SitGo as State, SitGoConfig as Config, Street, FOLD_PAUSE_MS, SHOWDOWN_MS};
use serde_json::{json, Value};

const SECRET: &str = "0x3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c";
const STAKE: u128 = 1_000_000;

fn config(max_hands: u64) -> Config {
    Config { start_chips: 100, small_blind: 1, big_blind: 2, hands_per_level: 4, max_hands, turn_ms: 20_000 }
}
fn ctx(now_ms: u64, sequence: u64) -> RulesContext<'static> {
    RulesContext { now_ms, sequence, seed: "sitgo", luck: None, world: None, secret: Some(SECRET) }
}
fn players(n: usize) -> Vec<String> {
    (1..=n).map(|i| format!("0x{i:040x}")).collect()
}

/// Plays the state on with `choose(options)` for whoever is on turn, dealing on the clock.
fn play(c: &Config, mut s: State, choose: impl Fn(&Value) -> Value) -> State {
    let mut now = 1_000;
    let mut seq = 10;
    for _ in 0..5_000 {
        if s.finished {
            return s;
        }
        let in_play = s.hand.as_ref().map(|h| h.turn.is_some()).unwrap_or(false);
        now += 100;
        seq += 1;
        if in_play {
            let h = s.hand.as_ref().unwrap();
            let p = s.players[s.seats[h.turn.unwrap()]].clone();
            let view = Game::view(c, &s, Some(&p)).unwrap();
            let m = choose(&view["hand"]["options"]);
            s = Game::act(c, &s, &p, serde_json::from_value(m).unwrap(), &ctx(now, seq)).unwrap();
        } else {
            now = Game::deadline(c, &s).unwrap().max(now);
            s = Game::timeout(c, &s, &ctx(now, seq)).unwrap();
        }
    }
    panic!("the game never finished");
}

fn shove(o: &Value) -> Value {
    if o["raise"].is_null() && o["call"].as_u64().unwrap() == 0 { json!({"move": "check"}) } else { json!({"move": "allin"}) }
}
fn passive(o: &Value) -> Value {
    if o["check"].as_bool().unwrap() { json!({"move": "check"}) } else { json!({"move": "call"}) }
}

#[test]
fn everyone_starts_equal_and_the_first_hand_is_dealt() {
    let c = config(40);
    let s = Game::setup(&c, &players(4), &ctx(0, 0)).unwrap();
    assert_eq!(s.chips, vec![100; 4]);
    assert_eq!(s.hands, 1);
    let h = s.hand.as_ref().unwrap();
    assert_eq!(h.street, Street::Preflop);
    assert_eq!(h.players.len(), 4);
    // Nobody but the owner sees hole cards; the public view has none.
    let v = Game::view(&c, &s, None).unwrap();
    assert!(v["hand"]["hole"].as_array().unwrap().iter().all(Value::is_null));
    assert!(v.get("state").is_none(), "the full state stays private until the end");
    let mine = Game::view(&c, &s, Some(&players(4)[2])).unwrap();
    assert!(mine["hand"]["hole"][2].is_array());
    assert!(mine["hand"]["hole"][1].is_null());
}

#[test]
fn shoving_every_hand_ends_with_one_player_holding_every_chip() {
    let c = config(200);
    let s = play(&c, Game::setup(&c, &players(3), &ctx(0, 0)).unwrap(), shove);
    assert!(s.finished);
    assert_eq!(s.chips.iter().sum::<u64>(), 300, "chips are conserved across hands");
    assert_eq!(s.chips.iter().filter(|c| **c > 0).count(), 1);
    assert_eq!(s.winners.len(), 1);
    assert_eq!(s.shares, vec![300]);
    // The ranking: the winner first, then the later bust above the earlier one.
    let Some(Outcome::Ranking { tiers }) = Game::outcome(&c, &s) else { panic!("no ranking") };
    assert_eq!(tiers[0], vec![s.winners[0].clone()]);
    let flat: Vec<&String> = tiers.iter().flatten().collect();
    assert_eq!(flat.len(), 3);
    assert_eq!(Game::deadline(&c, &s), None);
    assert!(Game::act(&c, &s, &players(3)[0], serde_json::from_value(json!({"move": "check"})).unwrap(), &ctx(0, 0)).is_err());
}

#[test]
fn the_hand_limit_ends_it_and_the_chip_leader_wins() {
    let c = config(3);
    let s = play(&c, Game::setup(&c, &players(4), &ctx(0, 0)).unwrap(), passive);
    assert!(s.finished);
    assert_eq!(s.hands, 3);
    assert_eq!(s.chips.iter().sum::<u64>(), 400);
    let top = *s.chips.iter().max().unwrap();
    let leaders: Vec<String> = (0..4).filter(|i| s.chips[*i] == top).map(|i| s.players[i].to_lowercase()).collect();
    assert_eq!(s.winners, leaders);
    assert!(s.shares.iter().all(|x| *x == top));
}

#[test]
fn blinds_double_every_level() {
    let c = config(40);
    let mut s = Game::setup(&c, &players(2), &ctx(0, 0)).unwrap();
    assert_eq!(s.hand.as_ref().unwrap().big_blind, 2);
    // Fold hands away until hand 5 (level 2).
    let mut now = 10;
    while s.hands < 5 {
        if let Some(t) = s.hand.as_ref().and_then(|h| h.turn) {
            let p = s.players[s.seats[t]].clone();
            s = Game::act(&c, &s, &p, serde_json::from_value(json!({"move": "fold"})).unwrap(), &ctx(now, now)).unwrap();
        } else {
            now = Game::deadline(&c, &s).unwrap();
            s = Game::timeout(&c, &s, &ctx(now, now)).unwrap();
        }
        now += 1;
    }
    assert_eq!(s.hand.as_ref().unwrap().big_blind, 4);
    let v = Game::view(&c, &s, None).unwrap();
    assert_eq!(v["blinds"], json!([2, 4]));
}

#[test]
fn a_finished_hand_stays_up_then_the_clock_deals_the_next() {
    let c = config(40);
    let s = Game::setup(&c, &players(3), &ctx(0, 0)).unwrap();
    // Everyone folds to the big blind.
    let mut s = s;
    let mut now = 100;
    while s.hands == 1 && s.hand.as_ref().unwrap().turn.is_some() {
        let t = s.hand.as_ref().unwrap().turn.unwrap();
        let p = s.players[s.seats[t]].clone();
        s = Game::act(&c, &s, &p, serde_json::from_value(json!({"move": "fold"})).unwrap(), &ctx(now, now)).unwrap();
        now += 1;
    }
    assert_eq!(s.hand.as_ref().unwrap().street, Street::Folded);
    assert_eq!(Game::deadline(&c, &s), Some(now - 1 + FOLD_PAUSE_MS));
    assert!(Game::act(&c, &s, &players(3)[0], serde_json::from_value(json!({"move": "check"})).unwrap(), &ctx(now, now)).unwrap_err().contains("dealt"));
    let button = s.button;
    let seq = s.seq;
    let s = Game::timeout(&c, &s, &ctx(now + FOLD_PAUSE_MS, now + 1)).unwrap();
    assert_eq!(s.hands, 2);
    assert_ne!(s.button, button, "the button moved");
    assert!(s.seq > seq);
    assert!(SHOWDOWN_MS > FOLD_PAUSE_MS);
}

#[test]
fn an_absent_player_is_folded_by_the_clock() {
    let c = config(40);
    let s = Game::setup(&c, &players(2), &ctx(0, 0)).unwrap();
    let d = Game::deadline(&c, &s).unwrap();
    let s = Game::timeout(&c, &s, &ctx(d, 5)).unwrap();
    assert_eq!(s.hand.as_ref().unwrap().street, Street::Folded);
}

// ------------------------------------------------------------------ settlement in a paid room

fn room(n: u8) -> Harness<makeo_series::Program<Game>> {
    let cfg = json!({
        "series": {"entry": STAKE.to_string(), "min_players": n, "max_players": n, "start": {"kind": "WhenFull"},
                   "late_entry_until_ms": null, "entry_deadline_ms": 600_000, "payout": {"kind": "WinnerTakesAll"},
                   "fees": {"platform_bps": 0, "creator_bps": 0, "platform": format!("0x{:040x}", 0xaa), "creator": format!("0x{:040x}", 0xbb)}},
        "rules": {"start_chips": 100, "small_blind": 1, "big_blind": 2, "hands_per_level": 4, "max_hands": 200, "turn_ms": 20_000}
    });
    let mut h = Harness::new(testkit::manifest(<Game as Rules>::ID, cfg, &[])).hidden(SECRET);
    for p in 1..=n {
        h.deposit(p, STAKE).unwrap();
    }
    h
}

fn player_of(w: &str) -> u8 {
    (1..=9).find(|n| wallet(*n).eq_ignore_ascii_case(w)).unwrap()
}

#[test]
fn a_paid_sit_and_go_settles_and_publishes_its_final_state() {
    let mut h = room(3);
    let public = |h: &Harness<makeo_series::Program<Game>>| h.output.as_ref().unwrap().journal.public_view.clone();
    // During play the public view has no hole cards and no state.
    assert!(public(&h)["game"]["hand"]["hole"].as_array().unwrap().iter().all(Value::is_null));
    assert!(public(&h)["game"].get("state").is_none());
    for _ in 0..3_000 {
        let s: SeriesState<State> = h.game();
        if s.phase != Phase::Running {
            break;
        }
        let rules = s.rules.expect("in play");
        match rules.hand.as_ref().and_then(|x| x.turn) {
            Some(t) => {
                let p = player_of(&rules.players[rules.seats[t]]);
                let o = h.view_for(p).unwrap()["game"]["hand"]["options"].clone();
                h.act(p, json!(shove(&o))).unwrap();
            }
            None => {
                h.wait(SHOWDOWN_MS + 1);
                h.tick().unwrap();
            }
        }
    }
    let s: SeriesState<State> = h.game();
    assert_eq!(s.phase, Phase::Settled);
    let state = s.rules.expect("the final state");
    assert!(state.finished);
    let v = public(&h);
    // The settlement data: the full final rules state, exactly, and the winners with their shares.
    assert_eq!(v["game"]["state"], serde_json::to_value(&state).unwrap());
    assert_eq!(v["game"]["winners"], json!(state.winners));
    assert_eq!(v["game"]["shares"], json!(state.shares));
    assert!(state.winners.iter().all(|w| w.len() == 42 && w.starts_with("0x") && *w == w.to_lowercase()));
    let bytes = serde_json::to_vec(&v["game"]).unwrap().len();
    assert!(bytes < 50_000, "the settled view is {bytes} bytes");
    // The pot went to the winner.
    let winner = player_of(&state.winners[0]);
    assert_eq!(h.paid_to(&wallet(winner)), 3 * STAKE);
}

#[test]
fn every_action_is_logged_and_history_keeps_only_what_was_shown() {
    let c = config(40);
    let mut s = Game::setup(&c, &players(3), &ctx(0, 0)).unwrap();
    let mut now = 10;
    let mut acted = 2; // the blinds
    // Hand 1: the first player folds, the rest check it down to a showdown.
    let first = s.hand.as_ref().unwrap().turn.unwrap();
    while s.hands == 1 && s.hand.as_ref().unwrap().turn.is_some() {
        let h = s.hand.as_ref().unwrap();
        let t = h.turn.unwrap();
        let m = if t == first && !h.folded[t] && h.actions.len() == 2 { "fold" } else if h.current_bet > h.street_bet[t] { "call" } else { "check" };
        let p = s.players[s.seats[t]].clone();
        s = Game::act(&c, &s, &p, serde_json::from_value(json!({"move": m})).unwrap(), &ctx(now, now)).unwrap();
        acted += 1;
        now += 1;
    }
    let h = s.hand.as_ref().unwrap();
    assert_eq!(h.street, Street::Showdown);
    assert_eq!(h.actions.len(), acted, "every action, blinds included: {:?}", h.actions);
    assert_eq!(h.actions[0].act, "small blind");
    assert_eq!(h.actions[2].act, "fold");
    assert!(h.actions.windows(2).all(|w| (w[0].street as u8) <= (w[1].street as u8)), "in street order");
    // The public view carries the full action log.
    let v = Game::view(&c, &s, None).unwrap();
    assert_eq!(v["hand"]["actions"].as_array().unwrap().len(), acted);
    // History: the shown hands only, never the folded one; deltas add up to zero.
    assert_eq!(s.history.len(), 1);
    let sum = &s.history[0];
    let folded_seat = s.seats[first];
    assert_eq!(sum.shown.len(), 2);
    assert!(sum.shown.iter().all(|(seat, _, name)| *seat != folded_seat && !name.is_empty()));
    assert_eq!(sum.deltas.iter().sum::<i64>(), 0);
    assert_eq!(sum.board.len(), 5);
    let folded_cards = h.hole[first];
    let text = serde_json::to_string(&v["history"]).unwrap();
    assert!(!text.contains(&format!("[{},{}]", folded_cards[0], folded_cards[1])), "a folded hand leaked into history");
}

#[test]
fn history_is_bounded() {
    let c = config(200);
    let s = play(&c, Game::setup(&c, &players(4), &ctx(0, 0)).unwrap(), passive);
    assert!(s.history.len() <= near_holdem::HISTORY);
    assert_eq!(s.history.last().unwrap().hand, s.hands);
}
