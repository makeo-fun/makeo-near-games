//! NEARWOLF as a hidden Match: the harness runs it as the keeper does (secret luck, sealed moves
//! opened) and checks every phase, both win conditions, the timers, and what each seat can see.
use makeo_runtime::testkit::{self, wallet, Harness};
use makeo_series::{Phase as SeriesPhase, SeriesState};
use nearwolf::{roles_for, Entry, Game, Phase, Role, State, Team};
use serde_json::{json, Value};

type P = makeo_series::Program<Game>;
const STAKE: u128 = 5_000_000;
const SECRET: &str = "0x2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a";
const NIGHT: u64 = 30_000;
const DAWN: u64 = 7_000;
const COUNCIL: u64 = 50_000;
const PYRE: u64 = 30_000;
const DUSK: u64 = 7_000;

fn config(players: u32, table: u8) -> Value {
    json!({
        "series": {"entry": STAKE.to_string(), "min_players": players, "max_players": players, "start": {"kind": "WhenFull"},
                   "late_entry_until_ms": null, "entry_deadline_ms": 600_000, "payout": {"kind": "WinnerTakesAll"},
                   "fees": {"platform_bps": 0, "creator_bps": 0, "platform": format!("0x{:040x}", 0xaa), "creator": format!("0x{:040x}", 0xbb)}},
        "rules": {"table": table, "night_ms": NIGHT, "dawn_ms": DAWN, "council_ms": COUNCIL, "pyre_ms": PYRE, "dusk_ms": DUSK}
    })
}

fn fire_with(players: u8, table: u8, secret: &str) -> Harness<P> {
    let mut h = Harness::new(testkit::manifest(<Game as makeo_runtime::Rules>::ID, config(players as u32, table), &[])).hidden(secret);
    for p in 1..=players {
        h.deposit(p, STAKE).unwrap();
    }
    h
}

/// A fire where every seat is an entrant (no house seats), so the test makes every choice.
fn fire(players: u8) -> Harness<P> {
    fire_with(players, 4, SECRET)
}

fn state(h: &Harness<P>) -> State {
    h.game::<SeriesState<State>>().rules.expect("in play")
}

fn seat(h: &Harness<P>, p: u8) -> usize {
    state(h).seat_of(&wallet(p)).expect("seated")
}

/// The entrant (player number) in each seat of a fully seated fire.
fn player_at(h: &Harness<P>, seat: usize, players: u8) -> u8 {
    (1..=players).find(|&p| self::seat(h, p) == seat).expect("an entrant")
}

fn with_role(h: &Harness<P>, players: u8, role: Role) -> Vec<u8> {
    let s = state(h);
    (1..=players).filter(|&p| s.seats[seat(h, p)].role == role && s.seats[seat(h, p)].alive).collect()
}

fn alive_players(h: &Harness<P>, players: u8) -> Vec<u8> {
    let s = state(h);
    (1..=players).filter(|&p| s.seats[seat(h, p)].alive).collect()
}

/// Everyone alive who still owes a night choice sleeps (or picks nothing).
fn sleep_rest(h: &mut Harness<P>, players: u8) {
    for p in alive_players(h, players) {
        if state(h).phase != Phase::Night {
            return;
        }
        if !state(h).night.contains_key(&seat(h, p)) {
            h.act(p, json!({"move": "night"})).unwrap();
        }
    }
}

/// Lets the clock run out on the phase in play.
fn run_out(h: &mut Harness<P>) {
    let s = state(h);
    let now = h.now_ms;
    h.wait(s.deadline_ms.saturating_sub(now) + 1);
    h.tick().unwrap();
}

fn silent_council(h: &mut Harness<P>, players: u8) {
    for p in alive_players(h, players) {
        if state(h).phase == Phase::Council {
            h.act(p, json!({"move": "council", "kind": "silent"})).unwrap();
        }
    }
}

fn vote_all(h: &mut Harness<P>, players: u8, target: Option<usize>) {
    for p in alive_players(h, players) {
        if state(h).phase != Phase::Pyre {
            return;
        }
        let me = seat(h, p);
        let t = if target == Some(me) { None } else { target };
        h.act(p, json!({"move": "vote", "target": t})).unwrap();
    }
}

#[test]
fn roles_scale_with_the_table() {
    assert_eq!(roles_for(4), (1, false, false));
    assert_eq!(roles_for(5), (1, true, false));
    assert_eq!(roles_for(6), (1, true, true));
    assert_eq!(roles_for(8), (2, true, true));
    assert_eq!(roles_for(12), (3, true, true));
    assert_eq!(roles_for(16), (4, true, true));
    for (players, table) in [(4u8, 4u8), (5, 5), (6, 6), (8, 8), (1, 7), (2, 12)] {
        let h = fire_with(players, table, SECRET);
        let s = state(&h);
        let n = s.seats.len();
        assert_eq!(n, table.max(players) as usize);
        let count = |r: Role| s.seats.iter().filter(|x| x.role == r).count();
        let (w, seer, healer) = roles_for(n);
        assert_eq!((count(Role::Wolf), count(Role::Seer) == 1, count(Role::Healer) == 1), (w, seer, healer));
        assert_eq!(count(Role::Seer) + count(Role::Healer) + count(Role::Wolf) + count(Role::Villager), n);
        // Entrants all seated once; the rest are house seats.
        assert_eq!(s.seats.iter().filter(|x| x.wallet.is_some()).count(), players as usize);
        assert_eq!((s.phase, s.round), (Phase::Night, 1));
    }
}

#[test]
fn the_deal_depends_on_the_keepers_secret() {
    let a = state(&fire_with(8, 8, SECRET));
    let b = state(&fire_with(8, 8, "0x1111111111111111111111111111111111111111111111111111111111111111"));
    let roles = |s: &State| s.seats.iter().map(|x| (x.wallet.clone(), x.role)).collect::<Vec<_>>();
    assert_ne!(roles(&a), roles(&b));
}

#[test]
fn no_seat_sees_another_seats_secret() {
    let mut h = fire_with(3, 8, SECRET);
    let s = state(&h);
    let public = h.output.as_ref().unwrap().journal.public_view["game"].clone();
    // Everyone else (the room, the log): no roles, no wallets, no choices, no visions.
    for x in public["seats"].as_array().unwrap() {
        assert!(x["role"].is_null() && x["wallet"].is_null() && x["house"].is_null());
    }
    assert!(public["state"].is_null() && public["winners"] == json!([]), "no full state before the end");
    assert!(public["you"].is_null() && public["role"].is_null() && public["looks"].is_null() && public["pack"].is_null());
    let text = public.to_string();
    for p in 1..=3 {
        assert!(!text.to_lowercase().contains(&wallet(p).to_lowercase()), "the public view names an entrant's seat");
    }
    // Each entrant: their own role; a wolf also its pack; nothing else.
    for p in 1..=3u8 {
        let v = h.view_for(p).unwrap()["game"].clone();
        let me = seat(&h, p);
        assert_eq!(v["you"], json!(me));
        let wolf = s.seats[me].role == Role::Wolf;
        for (i, x) in v["seats"].as_array().unwrap().iter().enumerate() {
            let may = i == me || (wolf && s.seats[i].role == Role::Wolf);
            if may {
                assert_eq!(x["role"], json!(s.seats[i].role));
            } else {
                assert!(x["role"].is_null(), "player {p} sees seat {i}'s role");
            }
            assert!(x["wallet"].is_null() && x["house"].is_null(), "player {p} can tell who sits in seat {i}");
        }
        if s.seats[me].role != Role::Seer {
            assert!(v["looks"].is_null());
        }
        if s.seats[me].role != Role::Healer {
            assert!(v["last_heal"].is_null());
        }
        if !wolf {
            assert!(v["pack"].is_null());
        }
    }
    // A sealed council move stays the speaker's own until the council closes.
    sleep_rest(&mut h, 3);
    if state(&h).phase == Phase::Night {
        run_out(&mut h);
    }
    if state(&h).phase == Phase::Dawn {
        run_out(&mut h);
    }
    if state(&h).phase == Phase::Council {
        let p = alive_players(&h, 3)[0];
        h.act_sealed(p, json!({"move": "council", "kind": "silent", "line": "secret words"})).unwrap();
        for q in 1..=3u8 {
            let v = h.view_for(q).unwrap()["game"].clone();
            let sees = v.to_string().contains("secret words");
            assert_eq!(sees, q == p, "player {q} sees player {p}'s sealed move");
        }
        assert!(!h.output.as_ref().unwrap().journal.public_view.to_string().contains("secret words"));
    }
}

#[test]
fn moonrise_wolves_kill_and_dawn_reveals_the_role() {
    let mut h = fire(6);
    let wolf = with_role(&h, 6, Role::Wolf)[0];
    let healer = with_role(&h, 6, Role::Healer)[0];
    let victim = with_role(&h, 6, Role::Villager)[0];
    let v = seat(&h, victim);
    // A wolf can't hunt a wolf, a villager can't act at night.
    assert!(h.act(wolf, json!({"move": "night", "target": seat(&h, wolf)})).is_err());
    assert!(h.act(victim, json!({"move": "night", "target": v})).is_err());
    h.act(wolf, json!({"move": "night", "target": v})).unwrap();
    assert!(h.act(wolf, json!({"move": "night", "target": v})).is_err(), "one choice a night");
    // The Healer protects someone else.
    h.act(healer, json!({"move": "night", "target": seat(&h, wolf)})).unwrap();
    sleep_rest(&mut h, 6);
    let s = state(&h);
    assert_eq!(s.phase, Phase::Dawn);
    assert!(!s.seats[v].alive);
    match s.log.last() {
        Some(Entry::Dawn { round: 1, died: Some(d), role: Some(Role::Villager) }) => assert_eq!(*d, v),
        other => panic!("expected a dawn death, got {other:?}"),
    }
    // Everyone now sees the dead seat's role.
    for p in 1..=6u8 {
        assert_eq!(h.view_for(p).unwrap()["game"]["seats"][v]["role"], json!("villager"));
    }
    // The dead don't act.
    run_out(&mut h);
    assert_eq!(state(&h).phase, Phase::Council);
    assert!(h.act(victim, json!({"move": "council", "kind": "silent"})).is_err());
}

#[test]
fn the_healer_saves_and_never_twice_in_a_row() {
    let mut h = fire(6);
    let wolf = with_role(&h, 6, Role::Wolf)[0];
    let healer = with_role(&h, 6, Role::Healer)[0];
    let target = with_role(&h, 6, Role::Villager)[0];
    let t = seat(&h, target);
    h.act(wolf, json!({"move": "night", "target": t})).unwrap();
    h.act(healer, json!({"move": "night", "target": t})).unwrap();
    sleep_rest(&mut h, 6);
    let s = state(&h);
    assert!(s.seats[t].alive, "the Healer saved them");
    assert!(matches!(s.log.last(), Some(Entry::Dawn { died: None, role: None, .. })));
    assert_eq!(s.last_heal, Some(t));
    assert_eq!(h.view_for(healer).unwrap()["game"]["last_heal"], json!(t));
    // Through the day with nobody burned.
    run_out(&mut h);
    silent_council(&mut h, 6);
    vote_all(&mut h, 6, None);
    assert_eq!(state(&h).phase, Phase::Dusk);
    run_out(&mut h);
    assert_eq!((state(&h).phase, state(&h).round), (Phase::Night, 2));
    assert!(h.act(healer, json!({"move": "night", "target": t})).is_err(), "not the same seat two nights running");
    h.act(healer, json!({"move": "night", "target": seat(&h, healer)})).unwrap();
}

#[test]
fn the_seer_learns_wolf_or_not_wolf_alone() {
    let mut h = fire(6);
    let seer = with_role(&h, 6, Role::Seer)[0];
    let wolf = with_role(&h, 6, Role::Wolf)[0];
    assert!(h.act(seer, json!({"move": "night", "target": seat(&h, seer)})).is_err(), "not yourself");
    h.act(seer, json!({"move": "night", "target": seat(&h, wolf)})).unwrap();
    sleep_rest(&mut h, 6);
    let looks = h.view_for(seer).unwrap()["game"]["looks"].clone();
    assert_eq!(looks, json!([{"round": 1, "target": seat(&h, wolf), "wolf": true}]));
    for p in (1..=6u8).filter(|&p| p != seer) {
        assert!(h.view_for(p).unwrap()["game"]["looks"].is_null());
    }
}

#[test]
fn council_moves_are_revealed_together() {
    let mut h = fire(6);
    run_out(&mut h); // a night where nobody chose: nobody dies
    assert!(matches!(state(&h).log.last(), Some(Entry::Dawn { died: None, .. })));
    run_out(&mut h);
    assert_eq!(state(&h).phase, Phase::Council);
    let [a, b, c] = [1u8, 2, 3];
    let (sa, sb) = (seat(&h, a), seat(&h, b));
    h.act(a, json!({"move": "council", "kind": "accuse", "target": sb, "line": "You were at the ferry."})).unwrap();
    h.act(b, json!({"move": "council", "kind": "report", "target": sa, "wolf": true, "line": "The moon named them."})).unwrap();
    h.act(c, json!({"move": "council", "kind": "claim", "role": "healer", "line": "I kept watch."})).unwrap();
    assert!(h.act(4, json!({"move": "council", "kind": "accuse", "target": seat(&h, 4)})).is_err(), "not yourself");
    assert!(h.act(4, json!({"move": "council", "kind": "sing"})).is_err());
    assert!(h.act(4, json!({"move": "council", "kind": "silent", "line": "x".repeat(200)})).is_err(), "one short line");
    assert!(h.act(4, json!({"move": "vote", "target": sa})).is_err(), "the pyre is not lit");
    // Nothing is public until the council closes.
    assert!(!state(&h).log.iter().any(|e| matches!(e, Entry::Council { .. })));
    run_out(&mut h); // seats 4..6 stay silent
    let s = state(&h);
    assert_eq!(s.phase, Phase::Pyre);
    let Some(Entry::Council { round: 1, moves }) = s.log.last() else { panic!("no council entry") };
    assert_eq!(moves.len(), 6);
    let by = |seat: usize| moves.iter().find(|(i, _)| *i == seat).unwrap().1.clone();
    assert_eq!((by(sa).kind.as_str(), by(sa).target), ("accuse", Some(sb)));
    assert_eq!((by(sb).kind.as_str(), by(sb).wolf), ("report", Some(true)));
    assert_eq!(by(seat(&h, c)).role, Some(Role::Healer));
    assert_eq!(by(seat(&h, 5)).kind, "silent");
}

#[test]
fn the_pyre_burns_the_most_voted_and_a_tie_burns_nobody() {
    let mut h = fire(8);
    run_out(&mut h);
    run_out(&mut h);
    run_out(&mut h);
    assert_eq!(state(&h).phase, Phase::Pyre);
    // A 4-4 tie between two seats: nobody burns.
    let alive = alive_players(&h, 8);
    let (x, y) = (seat(&h, alive[0]), seat(&h, alive[1]));
    for (k, p) in alive.iter().enumerate() {
        let t = if k % 2 == 0 { y } else { x };
        h.act(*p, json!({"move": "vote", "target": t})).unwrap();
    }
    let s = state(&h);
    assert!(matches!(s.log.last(), Some(Entry::Pyre { burned: None, role: None, .. })));
    assert_eq!(s.alive_count(), 8);
    // Next day: a majority burns, and the role is shown.
    run_out(&mut h); // dusk
    run_out(&mut h); // night: nobody chose
    run_out(&mut h); // dawn
    run_out(&mut h); // council
    let target = seat(&h, alive_players(&h, 8)[2]);
    let role = state(&h).seats[target].role;
    vote_all(&mut h, 8, Some(target));
    let s = state(&h);
    match s.log.last() {
        Some(Entry::Pyre { round: 2, burned: Some(b), role: Some(r), votes }) => {
            assert_eq!((*b, *r), (target, role));
            assert_eq!(votes.len(), 8);
        }
        other => panic!("expected a burning, got {other:?}"),
    }
    assert!(!s.seats[target].alive);
}

#[test]
fn the_village_wins_when_the_last_wolf_burns() {
    let mut h = fire(6);
    let wolf = with_role(&h, 6, Role::Wolf)[0];
    run_out(&mut h);
    run_out(&mut h);
    run_out(&mut h);
    let t = seat(&h, wolf);
    vote_all(&mut h, 6, Some(t));
    let s = state(&h);
    assert_eq!((s.phase, s.winner), (Phase::End, Some(Team::Village)));
    let series = h.game::<SeriesState<State>>();
    assert_eq!(series.phase, SeriesPhase::Settled);
    // The pot goes to the village's entrants; the wolf gets nothing.
    assert_eq!(h.paid_to(&wallet(wolf)), 0);
    let village: u128 = (1..=6u8).filter(|&p| p != wolf).map(|p| h.paid_to(&wallet(p))).sum();
    assert_eq!(village, 6 * STAKE);
    // The settlement field: every village entrant, lowercase, the wolf left out.
    let expect: Vec<String> = s.seats.iter().filter(|x| x.role != Role::Wolf).filter_map(|x| x.wallet.clone()).map(|w| w.to_lowercase()).collect();
    assert_eq!(s.winners, expect);
    assert_eq!(s.winners.len(), 5);
    assert!(!s.winners.contains(&wallet(wolf).to_lowercase()));
    // At the end every seat, role and wallet is shown to everyone.
    let public = h.output.as_ref().unwrap().journal.public_view["game"].clone();
    // Settlement: the finished public view carries the full rules state, unredacted, winners included.
    assert_eq!(public["state"], serde_json::to_value(&s).unwrap());
    assert_eq!(public["winners"], json!(s.winners));
    assert!(public["state"].to_string().len() < 50_000);
    for p in 1..=6u8 {
        assert_eq!(h.view_for(p).unwrap()["game"]["state"], public["state"]);
    }
    for (i, x) in public["seats"].as_array().unwrap().iter().enumerate() {
        assert_eq!(x["role"], json!(s.seats[i].role));
        assert_eq!(x["house"], json!(false));
        assert_eq!(x["wallet"], json!(s.seats[i].wallet));
    }
}

#[test]
fn the_wolves_win_at_parity() {
    // Four seats, one wolf: kill one villager at night, burn another by day → 1 wolf v 1.
    let mut h = fire(4);
    let wolf = with_role(&h, 4, Role::Wolf)[0];
    let villagers = with_role(&h, 4, Role::Villager);
    h.act(wolf, json!({"move": "night", "target": seat(&h, villagers[0])})).unwrap();
    sleep_rest(&mut h, 4);
    assert_eq!(state(&h).phase, Phase::Dawn);
    run_out(&mut h);
    run_out(&mut h);
    let t = seat(&h, villagers[1]);
    vote_all(&mut h, 4, Some(t));
    let s = state(&h);
    assert_eq!((s.phase, s.winner), (Phase::End, Some(Team::Wolves)));
    assert_eq!(h.paid_to(&wallet(wolf)), 4 * STAKE);
    assert_eq!(s.winners, vec![wallet(wolf).to_lowercase()]);
    let _ = player_at(&h, seat(&h, wolf), 4);
}

#[test]
fn the_wolves_can_win_at_dawn() {
    // Four seats: burn a villager by day, then the wolf's kill at night brings parity at dawn.
    let mut h = fire(4);
    let wolf = with_role(&h, 4, Role::Wolf)[0];
    let villagers = with_role(&h, 4, Role::Villager);
    run_out(&mut h); // night 1: nobody dies
    run_out(&mut h);
    run_out(&mut h);
    let t = seat(&h, villagers[0]);
    vote_all(&mut h, 4, Some(t));
    assert_eq!(state(&h).phase, Phase::Dusk);
    run_out(&mut h);
    h.act(wolf, json!({"move": "night", "target": seat(&h, villagers[1])})).unwrap();
    sleep_rest(&mut h, 4);
    let s = state(&h);
    assert_eq!((s.phase, s.winner), (Phase::End, Some(Team::Wolves)));
    assert!(matches!(s.log.last(), Some(Entry::Dawn { died: Some(_), .. })));
}

#[test]
fn house_seats_fill_the_fire_and_the_clock_always_ends_it() {
    // One entrant at a fire of seven: six house seats play from their own views. Let every
    // clock run out; the game must end with a winner, in a bounded number of phases.
    for secret in [SECRET, "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"] {
        let mut h = fire_with(1, 7, secret);
        let s = state(&h);
        assert_eq!(s.seats.len(), 7);
        assert_eq!(s.seats.iter().filter(|x| x.wallet.is_none()).count(), 6);
        let mut phases = 0;
        while state(&h).phase != Phase::End {
            run_out(&mut h);
            phases += 1;
            assert!(phases < 200, "the game never ends");
        }
        let s = state(&h);
        assert!(s.winner.is_some());
        // Only entrants can be paid: the winners list never names a house seat.
        assert!(s.winners.len() <= 1);
        assert!(s.winners.iter().all(|w| *w == wallet(1).to_lowercase()));
        let state_bytes = serde_json::to_string(&s).unwrap().len();
        assert!(state_bytes < 50_000, "final state is {state_bytes} bytes");
        assert_eq!(h.game::<SeriesState<State>>().phase, SeriesPhase::Settled);
        // House seats spoke in the record.
        assert!(s.log.iter().any(|e| matches!(e, Entry::Council { moves, .. } if moves.iter().any(|(_, m)| m.kind != "silent"))));
        // The end reveals which seats were the house's.
        let public = h.output.as_ref().unwrap().journal.public_view["game"].clone();
        assert_eq!(public["seats"].as_array().unwrap().iter().filter(|x| x["house"] == json!(true)).count(), 6);
    }
}

#[test]
fn a_sealed_move_is_opened_by_the_keeper() {
    let mut h = fire(6);
    let wolf = with_role(&h, 6, Role::Wolf)[0];
    let t = seat(&h, with_role(&h, 6, Role::Villager)[0]);
    h.act_sealed(wolf, json!({"move": "night", "target": t})).unwrap();
    assert_eq!(state(&h).night.get(&seat(&h, wolf)), Some(&Some(t)));
}

#[test]
fn without_the_secret_nobody_can_deal() {
    let mut h = Harness::<P>::new(testkit::manifest(<Game as makeo_runtime::Rules>::ID, config(4, 4), &[]));
    for p in 1..=4 {
        h.deposit(p, STAKE).unwrap();
    }
    assert_eq!(h.game::<SeriesState<State>>().phase, SeriesPhase::Voided);
}
