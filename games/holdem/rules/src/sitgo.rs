//! A sit-and-go: the paid contest NEAR Hold'em is played as. 2 to 6 players pay the same entry and
//! sit down with the same chips. Hands of Hold'em (the engine in lib.rs) are dealt one after
//! another, the button moving left and the blinds doubling every `hands_per_level` hands, until one
//! player holds every chip or `max_hands` have been played. The chip leader (or leaders, tied) wins
//! the pot; the result ranks everyone else by chips, then by how late they busted.
//!
//! Settlement on NEAR: once finished, the public view carries `winners` (lowercase seat wallets),
//! `shares` (their final chips, for a chip-weighted split) and `state`, the full final rules state
//! exactly as the keeper signed it, so the operator can check it against the signed hash.
use crate::{Holdem, Hand, Move, Street, SHOWDOWN_MS};
use makeo_runtime::table::{Seat, TableRules};
use makeo_runtime::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub struct Game;

/// How long a hand everyone folded to stays on screen before the next deal.
pub const FOLD_PAUSE_MS: u64 = 2_500;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SitGoConfig {
    /// Chips each player starts with.
    pub start_chips: u64,
    /// The first level's blinds; they double every `hands_per_level` hands.
    pub small_blind: u64,
    pub big_blind: u64,
    pub hands_per_level: u64,
    /// The game ends after this many hands at the latest.
    pub max_hands: u64,
    pub turn_ms: u64,
}

/// What everyone saw of a finished hand: the board, the hands shown down, each seat's chip change.
/// Folded and unshown cards are never in it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HandSummary {
    pub hand: u64,
    pub board: Vec<crate::Card>,
    /// (seat, the two cards, the hand's name) for each hand shown down.
    pub shown: Vec<(usize, [crate::Card; 2], String)>,
    /// Chip change per seat (0 for seats not in the hand).
    pub deltas: Vec<i64>,
    /// Seats that took chips from the pot.
    pub winners: Vec<usize>,
}

/// How many finished hands the state remembers.
pub const HISTORY: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SitGo {
    /// Wallets in seat order.
    pub players: Vec<String>,
    /// Chips each seat has outside the hand in play (their stack at its start).
    pub chips: Vec<u64>,
    /// Hands dealt so far; the one in play (or just ended) is number `hands`.
    pub hands: u64,
    /// The seat with the button in the hand in play.
    pub button: usize,
    /// The hand in play, or the one that just ended while it stays on screen.
    pub hand: Option<Hand>,
    /// `seats[i]` is the seat of the hand's player `i`.
    pub seats: Vec<usize>,
    /// While a finished hand stays on screen: when the next one is dealt.
    pub next_deal_ms: u64,
    /// The hand number each seat lost its last chip in.
    pub busted: Vec<Option<u64>>,
    /// The last few finished hands, oldest first.
    pub history: Vec<HandSummary>,
    pub finished: bool,
    /// Once finished: who won (lowercase wallets) and their final chips.
    pub winners: Vec<String>,
    pub shares: Vec<u64>,
    /// +1 for every change, so the page knows when its move landed.
    pub seq: u64,
}

impl SitGoConfig {
    fn blinds(&self, hand_no: u64) -> (u64, u64) {
        let level = ((hand_no.saturating_sub(1)) / self.hands_per_level.max(1)).min(20);
        let cap = self.start_chips.max(self.big_blind);
        ((self.small_blind << level).min(cap), (self.big_blind << level).min(cap))
    }
    fn hand_config(&self, hand_no: u64) -> crate::Config {
        let (small_blind, big_blind) = self.blinds(hand_no);
        crate::Config { small_blind, big_blind, turn_ms: self.turn_ms }
    }
}

impl SitGo {
    fn alive(&self) -> Vec<usize> {
        (0..self.players.len()).filter(|s| self.chips[*s] > 0).collect()
    }
    fn seat_of(&self, player: &str) -> Option<usize> {
        self.players.iter().position(|p| p.eq_ignore_ascii_case(player))
    }
    fn in_play(&self) -> bool {
        self.hand.as_ref().map(|h| h.betting()).unwrap_or(false)
    }

    /// Deals the next hand among the seats with chips, the button on the next of them.
    fn deal(&mut self, config: &SitGoConfig, ctx: &RulesContext) -> Result<()> {
        let alive = self.alive();
        ensure(alive.len() >= 2, "nobody left to play")?;
        let n = self.players.len();
        self.button = if self.hands == 0 {
            alive[0]
        } else {
            (1..=n).map(|k| (self.button + k) % n).find(|s| self.chips[*s] > 0).ok_or("no button")?
        };
        // Hand players in seat order starting from seat 0; the button is an index into them.
        self.seats = alive.clone();
        let players: Vec<Seat> = alive.iter().map(|s| Seat { wallet: self.players[*s].to_lowercase(), stack: self.chips[*s] }).collect();
        let button = self.seats.iter().position(|s| *s == self.button).ok_or("no button")?;
        self.hands += 1;
        let hand = Holdem::start(&config.hand_config(self.hands), &players, button, ctx)?;
        self.hand = Some(hand);
        self.next_deal_ms = 0;
        self.after_hand_change(config, ctx)
    }

    /// When the hand in play has ended (possibly at the deal: everyone all in from the blinds):
    /// move the chips, mark the busted, end the game or schedule the next deal.
    fn after_hand_change(&mut self, config: &SitGoConfig, ctx: &RulesContext) -> Result<()> {
        let Some(hand) = &self.hand else { return Ok(()) };
        let Some(result) = Holdem::result(&config.hand_config(self.hands), hand) else { return Ok(()) };
        let pause = if hand.street == Street::Showdown { SHOWDOWN_MS } else { FOLD_PAUSE_MS };
        let mut deltas = vec![0i64; self.players.len()];
        let mut shown = Vec::new();
        for (i, d) in result.iter().enumerate() {
            deltas[self.seats[i]] = *d;
            if hand.showdown.as_ref().map(|s| s.shown[i]).unwrap_or(false) {
                let name = hand.showdown.as_ref().and_then(|s| s.names[i].clone()).unwrap_or_default();
                shown.push((self.seats[i], hand.hole[i], name));
            }
        }
        let summary = HandSummary {
            hand: self.hands,
            board: hand.board[..hand.dealt].to_vec(),
            shown,
            winners: (0..result.len()).filter(|i| result[*i] > 0).map(|i| self.seats[i]).collect(),
            deltas,
        };
        self.history.push(summary);
        if self.history.len() > HISTORY {
            self.history.remove(0);
        }
        for (i, delta) in result.iter().enumerate() {
            let s = self.seats[i];
            let chips = self.chips[s] as i64 + delta;
            ensure(chips >= 0, "a stack went below zero")?;
            self.chips[s] = chips as u64;
            if chips == 0 && self.busted[s].is_none() {
                self.busted[s] = Some(self.hands);
            }
        }
        if self.alive().len() <= 1 || self.hands >= config.max_hands {
            self.finish();
        } else {
            self.next_deal_ms = ctx.now_ms + pause;
        }
        Ok(())
    }

    fn finish(&mut self) {
        self.finished = true;
        self.next_deal_ms = 0;
        let top = self.chips.iter().copied().max().unwrap_or(0);
        let leaders: Vec<usize> = (0..self.players.len()).filter(|s| self.chips[*s] == top && top > 0).collect();
        self.winners = leaders.iter().map(|s| self.players[*s].to_lowercase()).collect();
        self.shares = leaders.iter().map(|s| self.chips[*s]).collect();
    }

    /// Everyone ranked: chips first, then the later bust above the earlier.
    fn tiers(&self) -> Vec<Vec<String>> {
        let mut order: Vec<usize> = (0..self.players.len()).collect();
        let key = |s: &usize| (self.chips[*s], self.busted[*s].unwrap_or(u64::MAX));
        order.sort_by(|a, b| key(b).cmp(&key(a)));
        let mut tiers: Vec<Vec<String>> = Vec::new();
        let mut last = None;
        for s in order {
            if Some(key(&s)) == last {
                tiers.last_mut().expect("a tier").push(self.players[s].clone());
            } else {
                tiers.push(vec![self.players[s].clone()]);
                last = Some(key(&s));
            }
        }
        tiers
    }
}

impl Rules for Game {
    const ID: &'static str = "makeo.near-holdem.v1";
    type Config = SitGoConfig;
    type State = SitGo;
    type Action = Move;

    fn setup(config: &SitGoConfig, players: &[String], ctx: &RulesContext) -> Result<SitGo> {
        ensure((2..=6).contains(&players.len()), "two to six players")?;
        ensure(config.start_chips >= config.big_blind && config.small_blind > 0 && config.big_blind >= config.small_blind, "invalid config")?;
        ensure(config.max_hands > 0 && config.turn_ms > 0, "invalid config")?;
        let n = players.len();
        let mut state = SitGo {
            players: players.to_vec(),
            chips: vec![config.start_chips; n],
            hands: 0,
            button: 0,
            hand: None,
            seats: vec![],
            next_deal_ms: 0,
            busted: vec![None; n],
            history: vec![],
            finished: false,
            winners: vec![],
            shares: vec![],
            seq: 0,
        };
        state.deal(config, ctx)?;
        Ok(state)
    }

    fn act(config: &SitGoConfig, state: &SitGo, player: &str, action: Move, ctx: &RulesContext) -> Result<SitGo> {
        ensure(!state.finished, "the game is over")?;
        ensure(state.in_play(), "the next hand is being dealt")?;
        let seat = state.seat_of(player).ok_or("you are not at this table")?;
        let i = state.seats.iter().position(|s| *s == seat).ok_or("you are out of chips")?;
        let hand = state.hand.as_ref().ok_or("no hand in play")?;
        let mut next = state.clone();
        next.hand = Some(Holdem::act(&config.hand_config(state.hands), hand, i, action, ctx)?);
        next.seq += 1;
        next.after_hand_change(config, ctx)?;
        Ok(next)
    }

    fn deadline(config: &SitGoConfig, state: &SitGo) -> Option<u64> {
        if state.finished {
            return None;
        }
        match &state.hand {
            Some(h) if h.betting() => Holdem::deadline(&config.hand_config(state.hands), h),
            _ => Some(state.next_deal_ms),
        }
    }

    /// Out of time: the player on turn checks or folds; between hands, the next hand is dealt.
    fn timeout(config: &SitGoConfig, state: &SitGo, ctx: &RulesContext) -> Result<SitGo> {
        ensure(!state.finished, "the game is over")?;
        let mut next = state.clone();
        next.seq += 1;
        match &state.hand {
            Some(h) if h.betting() => {
                next.hand = Some(Holdem::timeout(&config.hand_config(state.hands), h, ctx)?);
                next.after_hand_change(config, ctx)?;
            }
            _ => next.deal(config, ctx)?,
        }
        Ok(next)
    }

    fn outcome(_: &SitGoConfig, state: &SitGo) -> Option<Outcome> {
        state.finished.then(|| Outcome::Ranking { tiers: state.tiers() })
    }

    /// A player sees their own cards in the hand in play; everyone sees the board, the bets, the
    /// chips and the shown hands. Once finished, the whole state is public (it settles on NEAR).
    fn view(config: &SitGoConfig, state: &SitGo, viewer: Option<&str>) -> Result<Value> {
        let me = viewer.and_then(|v| state.seat_of(v)).and_then(|s| state.seats.iter().position(|x| *x == s));
        let hand = match &state.hand {
            Some(h) => Some(Holdem::view(&config.hand_config(state.hands), h, me)?),
            None => None,
        };
        let (small_blind, big_blind) = config.blinds(state.hands.max(1));
        let (next_small, next_big) = config.blinds(state.hands + 1);
        let mut v = json!({
            "players": state.players,
            "chips": state.chips,
            "hands": state.hands,
            "max_hands": config.max_hands,
            "button": state.button,
            "seats": state.seats,
            "hand": hand,
            "next_deal_ms": state.next_deal_ms,
            "busted": state.busted,
            "history": state.history,
            "blinds": [small_blind, big_blind],
            "next_blinds": [next_small, next_big],
            "hands_per_level": config.hands_per_level,
            "finished": state.finished,
            "winners": state.winners,
            "shares": state.shares,
            "seq": state.seq,
        });
        if state.finished {
            v["state"] = to_value(state)?;
        }
        Ok(v)
    }
}

/// How `makeo check` plays this game at random.
#[cfg(feature = "check")]
impl makeo_conformance::Fuzz for Game {
    fn config() -> SitGoConfig {
        SitGoConfig { start_chips: 100, small_blind: 1, big_blind: 2, hands_per_level: 5, max_hands: 60, turn_ms: 25_000 }
    }
    fn players() -> Vec<String> {
        (1..=4).map(|n| format!("0x{n:040x}")).collect()
    }
    fn moves(_: &SitGoConfig, state: &SitGo, _: &str, rng: &mut makeo_conformance::Rng) -> Vec<Value> {
        let Some(h) = &state.hand else { return vec![json!({"move": "check"})] };
        let pick = rng.below(12);
        let m = match pick {
            0 => json!({"move": "fold"}),
            1 | 2 => json!({"move": "allin"}),
            3 | 4 => json!({"move": "raise", "to": h.current_bet + h.min_raise + rng.below(3) * h.big_blind}),
            5 => json!({"move": "raise", "to": h.current_bet + 1}),
            6 => json!({"move": "check"}),
            _ => json!({"move": "call"}),
        };
        vec![m, json!({"move": "check"}), json!({"move": "call"})]
    }
}
