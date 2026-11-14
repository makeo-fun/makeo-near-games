//! No-Limit Texas Hold'em at a Makeo table, 2 to 6 seats.
//!
//! One hand at a time (the table format owns buy-ins, stacks and cash-outs): blinds, then
//! preflop, flop, turn and river betting rounds with fold / check / call / raise / all-in,
//! no-limit raises with the minimum raise rule (a short all-in does not reopen betting to players
//! who already acted), side pots, and a showdown judged by the runtime's poker evaluator and pot
//! settler (`makeo_runtime::cards`). A player out of time checks if they can, else folds.
//!
//! The table is hidden: Makeo's keeper shuffles with secret luck and holds the deck. At the deal
//! every hole card and every board card gets a salted SHA-256 commitment, shown to everyone.
//! Board cards are opened (card + salt) as they are turned, a player sees the opening of their own
//! two cards, and hands that reach a showdown are opened to all. Folded hands are never opened.
//! Anyone can check an opening against the commitment made before the first bet, so the keeper
//! cannot change a card mid-hand.
use makeo_runtime::cards::{self, Card, Score};
use makeo_runtime::table::{Seat, TableRules};
use makeo_runtime::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// One hand of Hold'em (the hand engine), as a table game. `Game` (sitgo.rs) plays a whole sit-and-go of these.
pub struct Holdem;

/// How long a showdown stays on screen before the next deal.
pub const SHOWDOWN_MS: u64 = 8_000;
/// The domain of each card's commitment: `auth::hash(CARD_DOMAIN, {"card": c, "salt": s})`, that
/// is SHA-256 of the canonical JSON `{"domain":"makeo:holdem:card:v1","value":{"card":c,"salt":"s"}}`.
pub const CARD_DOMAIN: &str = "makeo:holdem:card:v1";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub small_blind: u64,
    pub big_blind: u64,
    /// How long each player has to act.
    pub turn_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Street {
    Preflop,
    Flop,
    Turn,
    River,
    /// Two or more hands were shown and the pots paid.
    Showdown,
    /// Everyone else folded: the last hand in took the pot unshown.
    Folded,
}

/// What a player did last, for the table to show ("Raise to 12").
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Did {
    /// "small blind", "big blind", "fold", "check", "call", "bet", "raise", "all in".
    pub act: String,
    /// Their bet on this street after it.
    pub to: u64,
}

/// One action of the hand, in order: public, so every seat (and an AI seat's prompt) can replay
/// the betting street by street.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Logged {
    /// The hand player who acted.
    pub p: usize,
    pub street: Street,
    pub act: String,
    /// Their bet on this street after it.
    pub to: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pot {
    pub amount: u64,
    /// Players who could win it.
    pub eligible: Vec<usize>,
    /// Who did (several on a split).
    pub winners: Vec<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Showdown {
    /// Whose cards were turned up.
    pub shown: Vec<bool>,
    /// Each shown hand's name ("Kings full of Sevens").
    pub names: Vec<Option<String>>,
    /// Each shown hand's best five, the cards a showdown lights up.
    pub best: Vec<Option<[Card; 5]>>,
    /// The main pot first, then each side pot.
    pub pots: Vec<Pot>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hand {
    pub players: Vec<Seat>,
    pub button: usize,
    pub sb: usize,
    pub bb: usize,
    pub big_blind: u64,
    /// Secret: each player's two cards.
    pub hole: Vec<[Card; 2]>,
    /// Secret until turned: the five board cards, fixed at the deal.
    pub board: Vec<Card>,
    /// Secret: the salts of each commitment.
    pub hole_salts: Vec<[String; 2]>,
    pub board_salts: Vec<String>,
    /// Public from the deal: a commitment to every card.
    pub hole_commits: Vec<[String; 2]>,
    pub board_commits: Vec<String>,
    pub street: Street,
    /// Board cards turned up: 0, 3, 4 or 5.
    pub dealt: usize,
    /// Chips each player has put in this hand, and on this street.
    pub committed: Vec<u64>,
    pub street_bet: Vec<u64>,
    pub folded: Vec<bool>,
    /// Who still has to act on this street.
    pub to_act: Vec<bool>,
    /// Who may still raise (a short all-in does not reopen betting to those who acted).
    pub raise_open: Vec<bool>,
    /// The bet to match on this street, and the smallest raise on top of it.
    pub current_bet: u64,
    pub min_raise: u64,
    pub last: Vec<Option<Did>>,
    /// Every action of the hand in order, blinds included.
    pub actions: Vec<Logged>,
    pub turn: Option<usize>,
    pub deadline_ms: u64,
    /// +1 for every change, so the page knows when its move landed.
    pub seq: u64,
    pub showdown: Option<Showdown>,
    /// What each player takes back from the pots (set at the end).
    pub won: Option<Vec<u64>>,
    pub result: Option<Vec<i64>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "move", rename_all = "lowercase", deny_unknown_fields)]
pub enum Move {
    Fold,
    Check,
    Call,
    /// Raise (or bet, when nothing is bet yet) to a total of `to` on this street.
    Raise { to: u64 },
    /// Everything left: a call, a bet or a raise as the chips fall.
    Allin,
}

/// A card's commitment.
pub fn commit(card: Card, salt: &str) -> Result<String> {
    auth::hash(CARD_DOMAIN, &json!({"card": card, "salt": salt}))
}

fn salt(luck: &mut Entropy) -> String {
    format!("{:016x}{:016x}", luck.next_u64(), luck.next_u64())
}

impl Hand {
    fn n(&self) -> usize {
        self.players.len()
    }
    pub fn left(&self, i: usize) -> u64 {
        self.players[i].stack.saturating_sub(self.committed[i])
    }
    fn can_act(&self, i: usize) -> bool {
        !self.folded[i] && self.left(i) > 0
    }
    fn in_hand(&self) -> Vec<usize> {
        (0..self.n()).filter(|i| !self.folded[*i]).collect()
    }
    pub fn betting(&self) -> bool {
        matches!(self.street, Street::Preflop | Street::Flop | Street::Turn | Street::River)
    }
    /// Whether `i` has a decision to make on this street.
    fn needs(&self, i: usize) -> bool {
        if !self.can_act(i) || !self.to_act[i] {
            return false;
        }
        // Alone with chips against all-in players and nothing to call: nobody left to bet against.
        let others = (0..self.n()).filter(|j| *j != i && self.can_act(*j)).count();
        others > 0 || self.street_bet[i] < self.current_bet
    }
    fn next_needing(&self, after: usize) -> Option<usize> {
        let n = self.n();
        (1..=n).map(|k| (after + k) % n).find(|i| self.needs(*i))
    }
    fn put(&mut self, i: usize, amount: u64) {
        let amount = amount.min(self.left(i));
        self.committed[i] += amount;
        self.street_bet[i] += amount;
    }
    pub fn to_call(&self, i: usize) -> u64 {
        self.current_bet.saturating_sub(self.street_bet[i]).min(self.left(i))
    }
    /// The raise open to `i` now, as (smallest, largest) total street bet, if any.
    pub fn raise_range(&self, i: usize) -> Option<(u64, u64)> {
        let left = self.left(i);
        let owed = self.current_bet.saturating_sub(self.street_bet[i]);
        if !self.raise_open[i] || left <= owed {
            return None;
        }
        let max_to = self.street_bet[i] + left;
        let min_to = (self.current_bet + self.min_raise).min(max_to);
        Some((min_to, max_to))
    }

    /// Moves the hand on after `after` acted (or after the deal): the next player, the next
    /// street, a runout or the end.
    fn progress(&mut self, after: usize, config: &Config, ctx: &RulesContext) -> Result<()> {
        if self.in_hand().len() == 1 {
            return self.end_folded();
        }
        loop {
            if let Some(next) = self.next_needing(after) {
                self.turn = Some(next);
                self.deadline_ms = ctx.now_ms + config.turn_ms;
                return Ok(());
            }
            // The street is over.
            let acting = (0..self.n()).filter(|i| self.can_act(*i)).count();
            if acting <= 1 || self.street == Street::River {
                return self.end_showdown();
            }
            self.street = match self.street {
                Street::Preflop => Street::Flop,
                Street::Flop => Street::Turn,
                _ => Street::River,
            };
            self.dealt = match self.street {
                Street::Flop => 3,
                Street::Turn => 4,
                _ => 5,
            };
            self.street_bet = vec![0; self.n()];
            self.current_bet = 0;
            self.min_raise = self.big_blind;
            self.to_act = (0..self.n()).map(|i| self.can_act(i)).collect();
            self.raise_open = vec![true; self.n()];
            for i in 0..self.n() {
                if self.can_act(i) {
                    self.last[i] = None;
                }
            }
            // Postflop the first to act is the first still in after the button.
            return self.progress_from_button(config, ctx);
        }
    }
    fn progress_from_button(&mut self, config: &Config, ctx: &RulesContext) -> Result<()> {
        let button = self.button;
        self.progress(button, config, ctx)
    }

    fn end_folded(&mut self) -> Result<()> {
        let scores: Vec<Option<Score>> = (0..self.n()).map(|i| (!self.folded[i]).then_some(0)).collect();
        let won = cards::settle(&self.committed, &scores, self.button)?;
        self.finish(won, Street::Folded)
    }

    fn end_showdown(&mut self) -> Result<()> {
        self.dealt = 5;
        let n = self.n();
        let mut scores: Vec<Option<Score>> = vec![None; n];
        let mut names = vec![None; n];
        let mut best = vec![None; n];
        for i in self.in_hand() {
            let seven: Vec<Card> = self.hole[i].iter().chain(self.board.iter()).copied().collect();
            let (score, five) = cards::best_five(&seven)?;
            scores[i] = Some(score);
            names[i] = Some(cards::describe(score));
            best[i] = Some(five);
        }
        let won = cards::settle(&self.committed, &scores, self.button)?;
        let pots = pots(&self.committed, &scores);
        self.showdown = Some(Showdown { shown: (0..n).map(|i| !self.folded[i]).collect(), names, best, pots });
        self.finish(won, Street::Showdown)
    }

    fn finish(&mut self, won: Vec<u64>, street: Street) -> Result<()> {
        self.result = Some((0..self.n()).map(|i| won[i] as i64 - self.committed[i] as i64).collect());
        self.won = Some(won);
        self.street = street;
        self.turn = None;
        self.deadline_ms = 0;
        Ok(())
    }

    fn shown(&self, i: usize) -> bool {
        self.showdown.as_ref().map(|s| s.shown[i]).unwrap_or(false)
    }
}

/// The pots as a showdown splits them: one per all-in level of the hands still in, each to the
/// best hand eligible for it (for display; `cards::settle` decides the chips).
pub fn pots(committed: &[u64], scores: &[Option<Score>]) -> Vec<Pot> {
    let n = committed.len();
    let mut levels: Vec<u64> = (0..n).filter(|i| scores[*i].is_some()).map(|i| committed[i]).collect();
    levels.sort_unstable();
    levels.dedup();
    let mut out = Vec::new();
    let mut previous = 0;
    for level in levels {
        let amount: u64 = committed.iter().map(|c| (*c).min(level) - (*c).min(previous)).sum();
        let eligible: Vec<usize> = (0..n).filter(|i| scores[*i].is_some() && committed[*i] >= level).collect();
        let top = eligible.iter().filter_map(|i| scores[*i]).max();
        let winners: Vec<usize> = eligible.iter().copied().filter(|i| scores[*i] == top).collect();
        if amount > 0 {
            // A level only one hand reached is chips nobody called: they go back, not a pot.
            if eligible.len() > 1 || out.is_empty() {
                out.push(Pot { amount, eligible, winners });
            }
        }
        previous = level;
    }
    out
}

impl TableRules for Holdem {
    const ID: &'static str = "makeo.near-holdem.hand.v1";
    type Config = Config;
    type Hand = Hand;
    type Action = Move;

    fn start(config: &Config, players: &[Seat], button: usize, ctx: &RulesContext) -> Result<Hand> {
        ensure(config.small_blind > 0 && config.big_blind >= config.small_blind && config.turn_ms > 0, "invalid config")?;
        let n = players.len();
        ensure((2..=10).contains(&n) && button < n, "need two to ten players")?;
        ensure(players.iter().all(|p| p.stack > 0), "every player needs chips")?;
        // Secret luck: only the keeper knows the deck. Deal one card around, then the second.
        let mut luck = ctx.secret()?;
        let deck = cards::shuffled(&mut luck);
        let hole: Vec<[Card; 2]> = (0..n).map(|i| [deck[i], deck[n + i]]).collect();
        let board: Vec<Card> = deck[2 * n..2 * n + 5].to_vec();
        let hole_salts: Vec<[String; 2]> = (0..n).map(|_| [salt(&mut luck), salt(&mut luck)]).collect();
        let board_salts: Vec<String> = (0..5).map(|_| salt(&mut luck)).collect();
        let mut hole_commits = Vec::with_capacity(n);
        for i in 0..n {
            hole_commits.push([commit(hole[i][0], &hole_salts[i][0])?, commit(hole[i][1], &hole_salts[i][1])?]);
        }
        let mut board_commits = Vec::with_capacity(5);
        for k in 0..5 {
            board_commits.push(commit(board[k], &board_salts[k])?);
        }
        // Heads-up the button posts the small blind and acts first preflop.
        let (sb, bb) = if n == 2 { (button, (button + 1) % n) } else { ((button + 1) % n, (button + 2) % n) };
        let mut hand = Hand {
            players: players.to_vec(),
            button,
            sb,
            bb,
            big_blind: config.big_blind,
            hole,
            board,
            hole_salts,
            board_salts,
            hole_commits,
            board_commits,
            street: Street::Preflop,
            dealt: 0,
            committed: vec![0; n],
            street_bet: vec![0; n],
            folded: vec![false; n],
            to_act: vec![false; n],
            raise_open: vec![true; n],
            current_bet: config.big_blind,
            min_raise: config.big_blind,
            last: vec![None; n],
            actions: Vec::new(),
            turn: None,
            deadline_ms: 0,
            seq: 0,
            showdown: None,
            won: None,
            result: None,
        };
        hand.put(sb, config.small_blind);
        hand.last[sb] = Some(Did { act: "small blind".into(), to: hand.street_bet[sb] });
        hand.actions.push(Logged { p: sb, street: Street::Preflop, act: "small blind".into(), to: hand.street_bet[sb] });
        hand.put(bb, config.big_blind);
        hand.last[bb] = Some(Did { act: "big blind".into(), to: hand.street_bet[bb] });
        hand.actions.push(Logged { p: bb, street: Street::Preflop, act: "big blind".into(), to: hand.street_bet[bb] });
        hand.to_act = (0..n).map(|i| hand.can_act(i)).collect();
        hand.progress(bb, config, ctx)?;
        Ok(hand)
    }

    fn act(config: &Config, hand: &Hand, player: usize, action: Move, ctx: &RulesContext) -> Result<Hand> {
        ensure(hand.betting(), "the hand is over")?;
        ensure(hand.turn == Some(player), "not your turn")?;
        let mut next = hand.clone();
        let p = player;
        let owed = hand.current_bet.saturating_sub(hand.street_bet[p]);
        let left = hand.left(p);
        let max_to = hand.street_bet[p] + left;
        // An all-in is a call when it cannot top the bet, else a raise to everything.
        let action = match action {
            Move::Allin if max_to <= hand.current_bet => Move::Call,
            Move::Allin => Move::Raise { to: max_to },
            other => other,
        };
        let act = match action {
            Move::Fold => {
                next.folded[p] = true;
                "fold"
            }
            Move::Check => {
                ensure(owed == 0, "there is a bet to call: call, raise or fold")?;
                "check"
            }
            Move::Call => {
                ensure(owed > 0, "nothing to call: check instead")?;
                next.put(p, owed);
                if next.left(p) == 0 { "all in" } else { "call" }
            }
            Move::Raise { to } => {
                let (min_to, max_to) = hand.raise_range(p).ok_or("you can only call or fold: the betting was not reopened to you")?;
                ensure(to <= max_to, "you don't have that many chips")?;
                ensure(to >= min_to, &format!("the smallest raise is to {min_to}"))?;
                next.put(p, to - hand.street_bet[p]);
                let size = to - hand.current_bet;
                if size >= hand.min_raise {
                    // A full raise reopens the betting to everyone else.
                    next.min_raise = size;
                    for i in 0..next.n() {
                        if i != p {
                            next.raise_open[i] = true;
                        }
                    }
                }
                next.current_bet = to;
                for i in 0..next.n() {
                    if i != p && next.can_act(i) {
                        next.to_act[i] = true;
                    }
                }
                if next.left(p) == 0 {
                    "all in"
                } else if hand.current_bet == 0 {
                    "bet"
                } else {
                    "raise"
                }
            }
            Move::Allin => unreachable_allin()?,
        };
        next.to_act[p] = false;
        next.raise_open[p] = false;
        next.last[p] = Some(Did { act: act.into(), to: next.street_bet[p] });
        next.actions.push(Logged { p, street: hand.street, act: act.into(), to: next.street_bet[p] });
        next.seq += 1;
        next.progress(p, config, ctx)?;
        Ok(next)
    }

    fn actor(_: &Config, hand: &Hand) -> Option<usize> {
        hand.turn
    }

    fn deadline(_: &Config, hand: &Hand) -> Option<u64> {
        hand.turn.map(|_| hand.deadline_ms)
    }

    /// Out of time: check if nothing is owed, else fold.
    fn timeout(config: &Config, hand: &Hand, ctx: &RulesContext) -> Result<Hand> {
        let player = hand.turn.ok_or("nobody to time out")?;
        let action = if hand.current_bet <= hand.street_bet[player] { Move::Check } else { Move::Fold };
        Self::act(config, hand, player, action, ctx)
    }

    fn result(_: &Config, hand: &Hand) -> Option<Vec<i64>> {
        hand.result.clone()
    }

    /// Everyone sees the board as it is turned, every bet, the commitments and the shown hands; a
    /// player also sees their own two cards with their openings. Folded hands are never opened.
    fn view(_: &Config, hand: &Hand, viewer: Option<usize>) -> Result<Value> {
        let n = hand.n();
        let visible = |i: usize| viewer == Some(i) || hand.shown(i);
        let hole: Vec<Option<[Card; 2]>> = (0..n).map(|i| visible(i).then_some(hand.hole[i])).collect();
        let hole_openings: Vec<Option<Value>> = (0..n)
            .map(|i| {
                visible(i).then(|| {
                    json!([
                        {"card": hand.hole[i][0], "salt": hand.hole_salts[i][0]},
                        {"card": hand.hole[i][1], "salt": hand.hole_salts[i][1]},
                    ])
                })
            })
            .collect();
        let board: Vec<Card> = hand.board[..hand.dealt].to_vec();
        let board_openings: Vec<Value> = (0..hand.dealt).map(|k| json!({"card": hand.board[k], "salt": hand.board_salts[k]})).collect();
        let options = hand.turn.filter(|_| hand.betting()).map(|t| {
            let raise = hand.raise_range(t).map(|(min, max)| json!({"min_to": min, "max_to": max}));
            json!({
                "player": t,
                "check": hand.current_bet <= hand.street_bet[t],
                "call": hand.to_call(t),
                "raise": raise,
                "allin": hand.left(t),
            })
        });
        Ok(json!({
            "players": hand.players,
            "button": hand.button,
            "sb": hand.sb,
            "bb": hand.bb,
            "big_blind": hand.big_blind,
            "street": hand.street,
            "board": board,
            "board_names": board.iter().map(|c| cards::name(*c)).collect::<Vec<_>>(),
            "hole": hole,
            "hole_names": hole.iter().map(|h| h.map(|[a, b]| [cards::name(a), cards::name(b)])).collect::<Vec<_>>(),
            "commitments": {"domain": CARD_DOMAIN, "hole": hand.hole_commits, "board": hand.board_commits},
            "openings": {"hole": hole_openings, "board": board_openings},
            "committed": hand.committed,
            "street_bet": hand.street_bet,
            "left": (0..n).map(|i| hand.left(i)).collect::<Vec<_>>(),
            "folded": hand.folded,
            "all_in": (0..n).map(|i| !hand.folded[i] && hand.left(i) == 0).collect::<Vec<_>>(),
            "last": hand.last,
            "actions": hand.actions,
            "pot": hand.committed.iter().sum::<u64>(),
            "current_bet": hand.current_bet,
            "min_raise": hand.min_raise,
            "turn": hand.turn,
            "deadline_ms": hand.deadline_ms,
            "options": options,
            "showdown": hand.showdown,
            "won": hand.won,
            "result": hand.result,
            "seq": hand.seq,
        }))
    }

    fn pause_ms(_: &Config, hand: &Hand) -> u64 {
        if hand.street == Street::Showdown { SHOWDOWN_MS } else { 0 }
    }
}

fn unreachable_allin() -> Result<&'static str> {
    Err("all in is resolved to a call or a raise".into())
}

#[cfg(target_arch = "wasm32")]
makeo_wasm_abi::export_rules!(Game);

/// How `makeo check` plays this game at random: mostly legal moves, some illegal ones.
#[cfg(feature = "check")]
impl makeo_conformance::table::TableFuzz for Holdem {
    fn config() -> Config {
        Config { small_blind: 1, big_blind: 2, turn_ms: 25_000 }
    }
    fn actions(_: &Config, hand: &Hand, player: usize, rng: &mut makeo_conformance::Rng) -> Vec<Value> {
        let owed = hand.current_bet.saturating_sub(hand.street_bet.get(player).copied().unwrap_or(0));
        let pick = rng.below(12);
        let m = match pick {
            0 => json!({"move": "fold"}),
            1 => json!({"move": "allin"}),
            2..=4 => json!({"move": "raise", "to": hand.current_bet + hand.min_raise + rng.below(3) * hand.big_blind}),
            5 => json!({"move": "raise", "to": hand.current_bet + 1}),
            _ if owed == 0 => json!({"move": "check"}),
            _ => json!({"move": "call"}),
        };
        vec![m]
    }
}

mod sitgo;
pub use sitgo::{Game, HandSummary, SitGo, SitGoConfig, FOLD_PAUSE_MS, HISTORY};
