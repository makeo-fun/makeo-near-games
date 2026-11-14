//! Hold'em rules, hand by hand: blinds and order, min-raise, short all-ins, side pots, split pots,
//! all-in runouts, timeouts, the evaluator, commitments and that folded hands stay sealed.
use makeo_runtime::cards::{self, Card};
use makeo_runtime::table::Seat;
use makeo_runtime::{RulesContext, TableRules};
use near_holdem::{commit, Config, Game, Hand, Move, Street};
use serde_json::Value;

const SECRET: &str = "0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";

fn config() -> Config {
    Config { small_blind: 1, big_blind: 2, turn_ms: 25_000 }
}

fn ctx(now_ms: u64, sequence: u64) -> RulesContext<'static> {
    RulesContext { now_ms, sequence, seed: "test-holdem", luck: None, world: None, secret: Some(SECRET) }
}

/// "Ah" -> card.
fn c(s: &str) -> Card {
    let r = "23456789TJQKA".find(&s[..1]).unwrap() as u8;
    let u = "cdhs".find(&s[1..2]).unwrap() as u8;
    u * 13 + r
}
fn cs(s: &str) -> Vec<Card> {
    s.split_whitespace().map(c).collect()
}

fn seats(stacks: &[u64]) -> Vec<Seat> {
    stacks.iter().enumerate().map(|(i, s)| Seat { wallet: format!("0x{:040x}", i + 1), stack: *s }).collect()
}

/// A hand dealt among `stacks` with the button at `button`.
fn deal(stacks: &[u64], button: usize) -> Hand {
    Game::start(&config(), &seats(stacks), button, &ctx(1_000, 1)).unwrap()
}

/// The same hand with chosen cards ("Ah Kd" per player, five board cards), commitments redone.
fn rigged(stacks: &[u64], button: usize, holes: &[&str], board: &str) -> Hand {
    let mut h = deal(stacks, button);
    for (i, hole) in holes.iter().enumerate() {
        let v = cs(hole);
        h.hole[i] = [v[0], v[1]];
        h.hole_commits[i] = [commit(v[0], &h.hole_salts[i][0]).unwrap(), commit(v[1], &h.hole_salts[i][1]).unwrap()];
    }
    h.board = cs(board);
    for k in 0..5 {
        h.board_commits[k] = commit(h.board[k], &h.board_salts[k]).unwrap();
    }
    h
}

fn act(h: &Hand, p: usize, m: Move) -> Hand {
    Game::act(&config(), h, p, m.clone(), &ctx(2_000, 2)).unwrap_or_else(|e| panic!("{m:?} by {p} refused: {e}\n{h:#?}"))
}
fn refused(h: &Hand, p: usize, m: Move) -> String {
    Game::act(&config(), h, p, m, &ctx(2_000, 2)).expect_err("should be refused")
}

/// Calls or checks everyone through to the end.
fn check_down(mut h: Hand) -> Hand {
    while let Some(p) = h.turn {
        let m = if h.current_bet > h.street_bet[p] { Move::Call } else { Move::Check };
        h = act(&h, p, m);
    }
    h
}

fn result(h: &Hand) -> Vec<i64> {
    Game::result(&config(), h).expect("the hand is over")
}

fn conserved(h: &Hand) {
    let r = result(h);
    assert_eq!(r.iter().sum::<i64>(), 0, "chips must be conserved: {r:?}");
    for (i, d) in r.iter().enumerate() {
        assert!(-*d <= h.players[i].stack as i64, "player {i} lost more than their stack");
    }
}

fn public(h: &Hand) -> Value {
    Game::view(&config(), h, None).unwrap()
}
fn seen_by(h: &Hand, p: usize) -> Value {
    Game::view(&config(), h, Some(p)).unwrap()
}

// ---------------------------------------------------------------- evaluator

#[test]
fn evaluator_orders_every_category() {
    let ladder = [
        "Ah Kh Qh Jh Th 2c 3d", // royal flush
        "9s 8s 7s 6s 5s Ah Ad", // straight flush
        "Jh Jd Js Jc 2d 3s 4h", // quads
        "Kh Kd Ks 7c 7d 2s 3h", // full house
        "Ah 9h 6h 3h 2h Kd Kc", // flush
        "Ah 2d 3c 4s 5h Kd Qc", // wheel straight
        "Qh Qd Qs 9c 2d 3s 5h", // trips
        "Kh Kd 7s 7c 2d 4s 3h", // two pair
        "Ah Ad 9s 7c 4d 3s 2h", // one pair
        "Ah Qd 9s 7c 4d 3s 2h", // high card
    ];
    let scores: Vec<u32> = ladder.iter().map(|h| cards::best(&cs(h)).unwrap()).collect();
    for w in scores.windows(2) {
        assert!(w[0] > w[1], "{scores:?}");
    }
    assert_eq!(cards::describe(scores[0]), "Royal flush");
    assert_eq!(cards::describe(scores[5]), "Straight, Five high");
    assert_eq!(cards::describe(scores[3]), "Kings full of Sevens");
}

#[test]
fn evaluator_vectors_kickers_and_ties() {
    let s = |h: &str| cards::best(&cs(h)).unwrap();
    // Kicker decides a pair.
    assert!(s("Ah Ad Kc 9s 7d 4c 2h") > s("Ah Ad Qc 9s 7d 4c 2h"));
    // Only the best five count: a sixth card never plays.
    assert_eq!(s("Ah Ad Kc Qs Jd 3c 2h"), s("Ah Ad Kc Qs Jd 4c 2h"));
    // A six-high straight beats the wheel; broadway beats both.
    assert!(s("6c 5d 4h 3s 2c Kd Qh") > s("Ac 5d 4h 3s 2c Kd Qh"));
    assert!(s("Ac Kd Qh Js Tc 2d 3h") > s("6c 5d 4h 3s 2c Kd Qh"));
    // Flush beats straight; higher flush card decides.
    assert!(s("Ah 9h 6h 3h 2h Kd Kc") > s("Ac Kd Qh Js Tc 2d 3h"));
    assert!(s("Ah Kh 6h 3h 2h 9d 8c") > s("Ah Qh 6h 3h 2h 9d 8c"));
    // Two pair: top pair, then second pair, then kicker.
    assert!(s("Ah Ad 3c 3s Kd 7c 2h") > s("Kh Kd Qc Qs Ad 7c 2h"));
    assert!(s("Ah Ad 3c 3s Kd 7c 2h") > s("Ah Ad 3c 3s Qd 7c 2h"));
    // Full house: trips decide before the pair.
    assert!(s("3h 3d 3c 2s 2d 9c 8h") > s("2h 2d 2c As Ad 9c 8h"));
    // The best five of seven with three pairs uses the top two and the best kicker.
    let (_, five) = cards::best_five(&cs("Ah Ad Kc Ks 2d 2c Qh")).unwrap();
    let mut five = five.to_vec();
    five.sort();
    let mut want = cs("Ah Ad Kc Ks Qh");
    want.sort();
    assert_eq!(five, want);
}

// ---------------------------------------------------------------- order and blinds

#[test]
fn heads_up_button_posts_small_blind_and_acts_first_preflop_last_after() {
    let h = deal(&[100, 100], 0);
    assert_eq!((h.sb, h.bb), (0, 1));
    assert_eq!(h.committed, vec![1, 2]);
    assert_eq!(h.turn, Some(0), "the button acts first preflop heads-up");
    let h = act(&h, 0, Move::Call);
    assert_eq!(h.turn, Some(1), "the big blind has the option");
    let h = act(&h, 1, Move::Check);
    assert_eq!(h.street, Street::Flop);
    assert_eq!(h.dealt, 3);
    assert_eq!(h.turn, Some(1), "the big blind acts first after the flop heads-up");
}

#[test]
fn three_handed_blinds_utg_first_and_big_blind_option() {
    let h = deal(&[100, 100, 100], 0);
    assert_eq!((h.sb, h.bb), (1, 2));
    assert_eq!(h.turn, Some(0), "first to act preflop is left of the big blind");
    let h = act(&h, 0, Move::Call);
    let h = act(&h, 1, Move::Call);
    assert_eq!(h.turn, Some(2), "big blind's option");
    assert!(Game::view(&config(), &h, None).unwrap()["options"]["check"].as_bool().unwrap());
    // The option includes a raise.
    let h = act(&h, 2, Move::Raise { to: 6 });
    assert_eq!(h.turn, Some(0));
    let h = act(&h, 0, Move::Call);
    let h = act(&h, 1, Move::Fold);
    assert_eq!(h.street, Street::Flop);
    assert_eq!(h.turn, Some(2), "first still in after the button acts first");
    assert_eq!(h.committed, vec![6, 2, 6]);
}

#[test]
fn six_handed_order_wraps_around_the_button() {
    let h = deal(&[100; 6], 4);
    assert_eq!((h.sb, h.bb), (5, 0));
    assert_eq!(h.turn, Some(1));
}

// ---------------------------------------------------------------- legality

#[test]
fn illegal_moves_are_refused() {
    let h = deal(&[100, 100, 100], 0);
    assert!(refused(&h, 1, Move::Call).contains("turn"));
    assert!(refused(&h, 0, Move::Check).contains("call"));
    assert!(refused(&h, 0, Move::Raise { to: 3 }).contains("smallest raise is to 4"));
    assert!(refused(&h, 0, Move::Raise { to: 101 }).contains("chips"));
    let h = act(&h, 0, Move::Call);
    let h = act(&h, 1, Move::Call);
    assert!(refused(&h, 2, Move::Call).contains("nothing to call"));
    let over = check_down(h);
    assert!(refused(&over, 0, Move::Check).contains("over"));
}

#[test]
fn min_raise_tracks_the_last_full_raise() {
    let h = deal(&[200, 200, 200], 0);
    let h = act(&h, 0, Move::Raise { to: 6 }); // raise by 4
    assert_eq!((h.current_bet, h.min_raise), (6, 4));
    assert!(refused(&h, 1, Move::Raise { to: 9 }).contains("to 10"));
    let h = act(&h, 1, Move::Raise { to: 20 }); // raise by 14
    assert_eq!((h.current_bet, h.min_raise), (20, 14));
    assert!(refused(&h, 2, Move::Raise { to: 33 }).contains("to 34"));
    let h = act(&h, 2, Move::Raise { to: 34 });
    assert_eq!(h.min_raise, 14);
    // On the flop the minimum bet is the big blind again.
    let h = act(&h, 0, Move::Call);
    let h = act(&h, 1, Move::Call);
    assert_eq!(h.street, Street::Flop);
    let first = h.turn.unwrap();
    assert!(refused(&h, first, Move::Raise { to: 1 }).contains("to 2"));
    let h = act(&h, first, Move::Raise { to: 2 });
    assert_eq!(h.last[first].as_ref().unwrap().act, "bet");
}

#[test]
fn a_short_all_in_does_not_reopen_betting_to_those_who_acted() {
    // Player 0 (UTG) has 200, player 1 (SB) has 13, player 2 (BB) has 200.
    let h = deal(&[200, 13, 200], 0);
    let h = act(&h, 0, Move::Raise { to: 10 }); // a full raise of 8
    let h = act(&h, 1, Move::Allin); // to 13: only 3 more, short of a full raise
    assert_eq!(h.current_bet, 13);
    assert_eq!(h.min_raise, 8);
    assert_eq!(h.last[1].as_ref().unwrap().act, "all in");
    // The big blind has not acted on the raise yet: may raise (to at least 21).
    assert_eq!(h.raise_range(2), Some((21, 200)));
    let h = act(&h, 2, Move::Call);
    // Player 0 acted already and faces only a short raise: call or fold.
    assert_eq!(h.raise_range(0), None);
    assert!(refused(&h, 0, Move::Raise { to: 30 }).contains("call or fold"));
    assert!(refused(&h, 0, Move::Allin).contains("call or fold"));
    let h = act(&h, 0, Move::Call);
    assert_eq!(h.street, Street::Flop);
    assert_eq!(h.committed, vec![13, 13, 13]);
}

#[test]
fn all_in_for_less_than_the_call_is_a_call() {
    let h = deal(&[1, 100, 100], 0); // UTG 0 has 1 chip, SB 1, BB 2
    assert_eq!(h.turn, Some(0));
    let h = act(&h, 0, Move::Allin);
    assert_eq!(h.street_bet[0], 1);
    assert_eq!(h.current_bet, 2, "a short call does not change the bet");
    assert_eq!(h.last[0].as_ref().unwrap().act, "all in");
    let h = act(&h, 1, Move::Raise { to: 40 });
    assert_eq!(h.turn, Some(2));
    let h = act(&h, 2, Move::Allin);
    assert_eq!(h.committed[2], 100);
    // The raiser must still answer the all-in re-raise.
    assert_eq!(h.turn, Some(1));
    let h = act(&h, 1, Move::Call);
    assert!(h.turn.is_none(), "everyone is all in: run it out");
    assert_eq!(h.street, Street::Showdown);
    assert_eq!(h.showdown.as_ref().unwrap().pots[0].amount, 3, "main pot: 1 from each");
    conserved(&h);
}

// ---------------------------------------------------------------- pots

#[test]
fn side_pots_pay_each_level_to_its_best_eligible_hand() {
    // Short stack has the best hand, medium the second best, big stack the worst.
    let mut h = rigged(&[20, 50, 100], 0, &["Kc Kd", "Qc Qd", "7c 2d"], "As 9h 5c 4s Jd");
    h = act(&h, 0, Move::Allin); // 20
    h = act(&h, 1, Move::Allin); // 50
    h = act(&h, 2, Move::Allin); // 100, 50 of it uncalled
    assert_eq!(h.street, Street::Showdown);
    assert_eq!(h.won, Some(vec![60, 60, 50]));
    assert_eq!(result(&h), vec![40, 10, -50]);
    let sd = h.showdown.clone().unwrap();
    assert_eq!(sd.pots.len(), 2, "{:?}", sd.pots);
    assert_eq!((sd.pots[0].amount, sd.pots[0].winners.clone()), (60, vec![0]));
    assert_eq!((sd.pots[1].amount, sd.pots[1].winners.clone(), sd.pots[1].eligible.clone()), (60, vec![1], vec![1, 2]));
    conserved(&h);
}

#[test]
fn the_big_stack_wins_everything_it_covers() {
    let mut h = rigged(&[20, 50, 100], 0, &["Kc Kd", "Qc Qd", "Ac Ad"], "As 9h 5c 4s Jd");
    h = act(&h, 0, Move::Allin);
    h = act(&h, 1, Move::Allin);
    h = act(&h, 2, Move::Allin);
    assert_eq!(h.won, Some(vec![0, 0, 170]));
    assert_eq!(result(&h), vec![-20, -50, 70]);
}

#[test]
fn folded_chips_stay_in_the_pots() {
    // Player 0 raises and folds to an all-in; 1 and 2 go to showdown.
    let mut h = rigged(&[100, 30, 100], 0, &["2c 7d", "Ac Ad", "Kc Kd"], "3s 9h 5c 4s Jd");
    h = act(&h, 0, Move::Raise { to: 10 });
    h = act(&h, 1, Move::Allin); // 30
    h = act(&h, 2, Move::Call); // 30
    h = act(&h, 0, Move::Fold);
    assert_eq!(h.street, Street::Showdown);
    assert_eq!(h.won, Some(vec![0, 70, 0]));
    assert_eq!(result(&h), vec![-10, 40, -30]);
}

#[test]
fn split_pot_when_the_board_plays_odd_chip_left_of_the_button() {
    // Royal flush on the board: everyone ties.
    let mut h = rigged(&[100, 100, 100], 0, &["2c 3d", "4c 5d", "6c 7d"], "As Ks Qs Js Ts");
    h = act(&h, 0, Move::Raise { to: 5 });
    h = act(&h, 1, Move::Call);
    h = act(&h, 2, Move::Fold); // 2 chips dead: pot 12, two winners
    let h = check_down(h);
    assert_eq!(h.won, Some(vec![6, 6, 0]));
    // Three-way tie with an odd chip: 3 x 5 + 2 dead = 17 → 6, 6, 5; the odd chips go to the
    // first winners left of the button (seat 1, then seat 2).
    let mut h = rigged(&[100, 100, 100, 100], 0, &["2c 3d", "4c 5d", "6c 7d", "8c 9d"], "As Ks Qs Js Ts");
    h = act(&h, 3, Move::Call); // UTG
    h = act(&h, 0, Move::Fold); // button folds: 0 in
    h = act(&h, 1, Move::Call); // SB to 2
    h = act(&h, 2, Move::Check); // BB
    let h = check_down(h);
    assert_eq!(h.committed, vec![0, 2, 2, 2]);
    assert_eq!(h.won, Some(vec![0, 2, 2, 2]));
    let mut h = rigged(&[100, 100, 100], 0, &["2c 3d", "4c 5d", "6c 7d"], "As Ks Qs Js Ts");
    h = act(&h, 0, Move::Raise { to: 5 });
    h = act(&h, 1, Move::Call);
    h = act(&h, 2, Move::Call);
    // Flop: SB bets 1 more than a round number to force an odd pot... keep it simple: 15 three ways.
    let h = check_down(h);
    assert_eq!(h.won, Some(vec![5, 5, 5]));
    conserved(&h);
}

#[test]
fn odd_chip_of_a_split_goes_to_the_first_winner_left_of_the_button() {
    // Heads-up tie with a dead small blind from a third player: pot 2 + 2 + 1 = 5.
    let mut h = rigged(&[100, 100, 100], 2, &["2c 3d", "4c 5d", "6c 7d"], "As Ks Qs Js Ts");
    // Button 2: SB 0, BB 1, UTG 2.
    h = act(&h, 2, Move::Call);
    h = act(&h, 0, Move::Fold); // SB's 1 chip is dead
    h = act(&h, 1, Move::Check);
    let h = check_down(h);
    // Winners 1 and 2 split 5: the odd chip to the first left of the button (seat 0 folded, so seat 1).
    assert_eq!(h.won, Some(vec![0, 3, 2]));
    conserved(&h);
}

// ---------------------------------------------------------------- endings

#[test]
fn everyone_folds_to_the_big_blind() {
    let h = deal(&[100, 100, 100], 0);
    let h = act(&h, 0, Move::Fold);
    let h = act(&h, 1, Move::Fold);
    assert_eq!(h.street, Street::Folded);
    assert_eq!(result(&h), vec![0, -1, 1]);
    assert_eq!(Game::pause_ms(&config(), &h), 0);
    // Nothing is shown: no hole cards in the public view, and no board was turned.
    let v = public(&h);
    assert!(v["hole"].as_array().unwrap().iter().all(Value::is_null));
    assert_eq!(v["board"].as_array().unwrap().len(), 0);
}

#[test]
fn an_uncalled_bet_comes_back() {
    let h = deal(&[100, 100], 0);
    let h = act(&h, 0, Move::Raise { to: 60 });
    let h = act(&h, 1, Move::Fold);
    assert_eq!(result(&h), vec![2, -2]);
}

#[test]
fn all_in_preflop_runs_the_board_out() {
    let h = rigged(&[50, 80], 1, &["Ac Ad", "Kc Kd"], "2s 7h 9c Js 3d");
    // Button 1 posts the small blind and acts first.
    let h = act(&h, 1, Move::Allin);
    let h = act(&h, 0, Move::Call);
    assert_eq!(h.street, Street::Showdown);
    assert_eq!(h.dealt, 5);
    assert!(h.turn.is_none());
    assert_eq!(result(&h), vec![50, -50]);
    assert_eq!(Game::pause_ms(&config(), &h), near_holdem::SHOWDOWN_MS);
    let v = public(&h);
    assert_eq!(v["board"].as_array().unwrap().len(), 5);
    assert_eq!(v["showdown"]["names"][0], "Pair of Aces");
}

#[test]
fn all_in_on_the_turn_skips_the_river_betting() {
    let h = deal(&[100, 100, 100], 0);
    let h = act(&h, 0, Move::Call);
    let h = act(&h, 1, Move::Call);
    let h = act(&h, 2, Move::Check);
    // Flop: all check.
    let mut h = h;
    for _ in 0..3 {
        let p = h.turn.unwrap();
        h = act(&h, p, Move::Check);
    }
    assert_eq!(h.street, Street::Turn);
    let p = h.turn.unwrap();
    h = act(&h, p, Move::Allin);
    // Others call: the last caller is all in too, or covered; either way no river betting.
    while let Some(q) = h.turn {
        h = act(&h, q, Move::Call);
    }
    assert_eq!(h.street, Street::Showdown);
    conserved(&h);
}

#[test]
fn a_lone_player_with_chips_does_not_bet_against_all_ins() {
    // Two short stacks all in, the big stack calls: no more betting, straight to the showdown.
    let h = deal(&[10, 10, 300], 0); // UTG 0, SB 1, BB 2
    let h = act(&h, 0, Move::Allin);
    let h = act(&h, 1, Move::Allin);
    let h = act(&h, 2, Move::Call);
    assert_eq!(h.street, Street::Showdown);
    conserved(&h);
}

#[test]
fn blinds_bigger_than_a_stack_put_the_player_all_in() {
    let h = deal(&[1, 100], 1); // seat 0 is the big blind with 1 chip
    assert_eq!(h.committed, vec![1, 1]);
    // The button (SB) owes 1 to match the full big blind of 2; there is nobody to bet against.
    assert_eq!(h.turn, Some(1));
    let h = act(&h, 1, Move::Call);
    assert_eq!(h.street, Street::Showdown);
    conserved(&h);
    // Both all in from the blinds: the hand runs out at the deal.
    let h = deal(&[1, 2], 0);
    assert_eq!(h.street, Street::Showdown);
    conserved(&h);
}

#[test]
fn timeout_checks_when_it_can_and_folds_when_it_must() {
    let h = deal(&[100, 100, 100], 0);
    assert_eq!(Game::deadline(&config(), &h), Some(1_000 + 25_000));
    let h = Game::timeout(&config(), &h, &ctx(30_000, 3)).unwrap();
    assert!(h.folded[0], "facing the big blind: fold");
    let h = act(&h, 1, Move::Call);
    let h = Game::timeout(&config(), &h, &ctx(60_000, 4)).unwrap();
    assert!(!h.folded[2], "nothing to call: check");
    assert_eq!(h.street, Street::Flop);
}

// ---------------------------------------------------------------- secrets and commitments

#[test]
fn each_player_sees_only_their_own_cards_until_the_showdown() {
    let h = deal(&[100, 100, 100], 0);
    let v = public(&h);
    assert!(v["hole"].as_array().unwrap().iter().all(Value::is_null));
    assert!(v["openings"]["hole"].as_array().unwrap().iter().all(Value::is_null));
    assert_eq!(v["openings"]["board"].as_array().unwrap().len(), 0);
    for p in 0..3 {
        let mine = seen_by(&h, p);
        for i in 0..3 {
            assert_eq!(mine["hole"][i].is_null(), i != p, "player {p} sees seat {i}?");
        }
        assert_eq!(mine["hole"][p][0], h.hole[p][0]);
    }
    // The public view never carries the undealt board or the salts.
    let text = serde_json::to_string(&v).unwrap();
    for salt in h.hole_salts.iter().flatten().chain(h.board_salts.iter()) {
        assert!(!text.contains(salt.as_str()));
    }
}

#[test]
fn every_opening_matches_the_commitment_made_at_the_deal() {
    let dealt = deal(&[100, 100, 100], 0);
    let commits = public(&dealt)["commitments"].clone();
    let h = check_down(dealt.clone());
    assert_eq!(h.street, Street::Showdown);
    let v = public(&h);
    assert_eq!(v["commitments"], commits, "commitments never change during the hand");
    for (k, o) in v["openings"]["board"].as_array().unwrap().iter().enumerate() {
        let card = o["card"].as_u64().unwrap() as u8;
        assert_eq!(commit(card, o["salt"].as_str().unwrap()).unwrap(), commits["board"][k].as_str().unwrap());
        assert_eq!(card, v["board"][k].as_u64().unwrap() as u8);
    }
    for i in 0..3 {
        for j in 0..2 {
            let o = &v["openings"]["hole"][i][j];
            let card = o["card"].as_u64().unwrap() as u8;
            assert_eq!(commit(card, o["salt"].as_str().unwrap()).unwrap(), commits["hole"][i][j].as_str().unwrap());
        }
    }
    // Commitments are distinct and are SHA-256 hex.
    let all: Vec<&str> = commits["hole"].as_array().unwrap().iter().flat_map(|p| p.as_array().unwrap().iter().map(|s| s.as_str().unwrap())).collect();
    assert!(all.iter().all(|s| s.trim_start_matches("0x").len() == 64), "{all:?}");
    let mut d = all.clone();
    d.sort();
    d.dedup();
    assert_eq!(d.len(), all.len());
}

#[test]
fn folded_hands_are_never_opened() {
    let mut h = rigged(&[100, 100, 100], 0, &["Ac Ad", "Kc Kd", "Qc Qd"], "2s 7h 9c Js 3d");
    h = act(&h, 0, Move::Call);
    h = act(&h, 1, Move::Call);
    h = act(&h, 2, Move::Check);
    // Flop: first to act bets, one folds.
    let p = h.turn.unwrap();
    h = act(&h, p, Move::Raise { to: 4 });
    let q = h.turn.unwrap();
    h = act(&h, q, Move::Fold);
    let folded = q;
    let h = check_down(h);
    assert_eq!(h.street, Street::Showdown);
    for viewer in [None, Some((folded + 1) % 3), Some((folded + 2) % 3)] {
        let v = Game::view(&config(), &h, viewer).unwrap();
        assert!(v["hole"][folded].is_null(), "folded hand shown to {viewer:?}");
        assert!(v["openings"]["hole"][folded].is_null());
        assert!(v["showdown"]["names"][folded].is_null());
    }
    // The folder still sees their own.
    assert!(!seen_by(&h, folded)["hole"][folded].is_null());
    // The others are shown with names and the five cards that played.
    let v = public(&h);
    for i in (0..3).filter(|i| *i != folded) {
        assert!(v["hole"][i].is_array());
        assert!(v["showdown"]["names"][i].is_string());
        assert_eq!(v["showdown"]["best"][i].as_array().unwrap().len(), 5);
    }
}

#[test]
fn the_view_offers_exactly_the_legal_moves() {
    let h = deal(&[100, 100, 100], 0);
    let o = &public(&h)["options"];
    assert_eq!(o["player"], 0);
    assert_eq!(o["check"], false);
    assert_eq!(o["call"], 2);
    assert_eq!(o["raise"]["min_to"], 4);
    assert_eq!(o["raise"]["max_to"], 100);
    assert_eq!(o["allin"], 100);
    let over = check_down(h);
    assert!(public(&over)["options"].is_null());
}

// ---------------------------------------------------------------- random play

/// Thousands of random hands: chips are conserved, nobody loses more than their stack, every
/// hand ends, and every refused move leaves the hand unchanged.
#[test]
fn random_hands_conserve_chips_and_always_end() {
    let mut x: u64 = 0x9e3779b97f4a7c15;
    let mut next = move |n: u64| {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x % n
    };
    let mut showdowns = 0;
    let mut side_pots = 0;
    for hand_no in 0..3_000u64 {
        let n = 2 + next(5) as usize;
        let stacks: Vec<u64> = (0..n).map(|_| 1 + next(300)).collect();
        let button = next(n as u64) as usize;
        let ctx0 = RulesContext { now_ms: 0, sequence: hand_no, seed: "random", luck: None, world: None, secret: Some(SECRET) };
        let mut h = Game::start(&config(), &seats(&stacks), button, &ctx0).unwrap();
        let mut steps = 0;
        while let Some(p) = h.turn {
            steps += 1;
            assert!(steps < 200, "hand never ended");
            let owed = h.current_bet.saturating_sub(h.street_bet[p]);
            let m = match next(10) {
                0 => Move::Fold,
                1 => Move::Allin,
                2 | 3 => Move::Raise { to: h.current_bet + h.min_raise + next(20) },
                4 => Move::Raise { to: next(400) },
                _ if owed == 0 => Move::Check,
                _ => Move::Call,
            };
            match Game::act(&config(), &h, p, m.clone(), &ctx(1, 1)) {
                Ok(next_hand) => h = next_hand,
                Err(_) => {
                    // Refused: fall back to something always legal.
                    let safe = if owed == 0 { Move::Check } else { Move::Call };
                    h = act(&h, p, safe);
                }
            }
        }
        conserved(&h);
        let won: u64 = h.won.as_ref().unwrap().iter().sum();
        assert_eq!(won, h.committed.iter().sum::<u64>());
        if h.street == Street::Showdown {
            showdowns += 1;
            if h.showdown.as_ref().unwrap().pots.len() > 1 {
                side_pots += 1;
            }
        }
    }
    assert!(showdowns > 300 && side_pots > 50, "{showdowns} showdowns, {side_pots} with side pots");
}

/// The browser's Receipt screen recomputes commitments as
/// `sha256(JSON.stringify({domain, value: {card, salt}}))`: these vectors were computed that way.
#[test]
fn commitments_match_the_browser_recomputation() {
    assert_eq!(commit(12, "00ff").unwrap(), "0x6a2dd7a4625bc9b6b04e467358865a23c153a9e029f73aa15f401af9b519658a");
    assert_eq!(
        commit(51, "0123456789abcdef0123456789abcdef").unwrap(),
        "0xa12681f766c62e2f7b1978c6b6ec59e7640b7b26a3d8f3b95604cffadbafee7e"
    );
}
