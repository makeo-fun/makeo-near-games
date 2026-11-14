//! NEARWOLF: werewolf at one fire, where people and AI actors share the table and every seat
//! looks the same.
//!
//! Makeo's keeper deals the roles from secret luck (`hidden = true`): wolves (a quarter of the
//! table, at least one), a Seer from five seats, a Healer from six, villagers for the rest. Each
//! round has four phases, all on the clock:
//!
//! - **Moonrise** (night): wolves pick a victim, the Seer looks at one seat (wolf or not wolf),
//!   the Healer protects one seat (never the same one two nights running). Everyone else sleeps.
//! - **Dawn**: the victim (if the Healer missed) dies and their role is shown to all.
//! - **Council**: everyone alive makes one structured move at the same time (claim a role,
//!   report a vision, accuse, vouch, stay silent) with one short line. Moves are sealed and shown
//!   together when the council closes.
//! - **Pyre**: everyone alive votes. The most votes burns (a tie burns nobody); the burned role is
//!   shown. Then the win check: no wolves left, the village wins; wolves as many as the rest, the
//!   wolves win.
//!
//! Seats the entrants don't fill (up to `table`) are house seats played by the rules themselves,
//! from their own role and the public record only. Seat order and names are dealt from secret luck,
//! so nobody can tell an entrant's seat from a house seat until the end.
use makeo_runtime::{ensure, Outcome, Result, Rng64, Rules, RulesContext};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub struct Game;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// Seats at the fire: entrants first, house seats fill the rest (4 to 16).
    pub table: u8,
    pub night_ms: u64,
    pub dawn_ms: u64,
    pub council_ms: u64,
    pub pyre_ms: u64,
    pub dusk_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Wolf,
    Seer,
    Healer,
    Villager,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Team {
    Village,
    Wolves,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Night,
    Dawn,
    Council,
    Pyre,
    Dusk,
    End,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Seat {
    /// Index into the name list (the client draws the name, the trade and the colour).
    pub persona: u8,
    /// The entrant in this seat; None for a house seat. Hidden until the end.
    pub wallet: Option<String>,
    pub role: Role,
    pub alive: bool,
}

/// One council move. `kind` decides which other fields count.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Speech {
    /// "claim" (role), "report" (target, wolf), "accuse" (target), "vouch" (target), "silent".
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<Role>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wolf: Option<bool>,
    #[serde(default)]
    pub line: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Look {
    pub round: u32,
    pub target: usize,
    pub wolf: bool,
}

/// One entry of the public record, in order.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Entry {
    /// Dawn of `round`: who died in the night (None: nobody, the Healer saved them) and their role.
    Dawn { round: u32, died: Option<usize>, role: Option<Role> },
    /// The council of `round`: every living seat's move, in seat order.
    Council { round: u32, moves: Vec<(usize, Speech)> },
    /// The pyre of `round`: every living seat's vote (None: abstained), who burned and their role.
    Pyre { round: u32, votes: Vec<(usize, Option<usize>)>, burned: Option<usize>, role: Option<Role> },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    /// Entrants' wallets, in entry order (not seat order).
    pub players: Vec<String>,
    pub seats: Vec<Seat>,
    pub phase: Phase,
    pub round: u32,
    pub deadline_ms: u64,
    pub seq: u64,
    /// This phase's sealed choices, by seat. Night: a target; council: a speech; pyre: a vote.
    pub night: BTreeMap<usize, Option<usize>>,
    pub council: BTreeMap<usize, Speech>,
    pub votes: BTreeMap<usize, Option<usize>>,
    /// The seat the Healer protected last night (they may not protect it again tonight).
    pub last_heal: Option<usize>,
    /// The Seer's visions so far (the Seer's own, until the end).
    pub looks: Vec<Look>,
    /// The public record.
    pub log: Vec<Entry>,
    pub winner: Option<Team>,
    /// Settlement (NEAR pot): the winning team's entrants, lowercase wallets, dead or alive, in
    /// seat order. House seats are never in it. Empty until the end.
    pub winners: Vec<String>,
    /// Secret luck for the house seats' choices.
    pub rng: Rng64,
}

#[derive(Deserialize)]
#[serde(tag = "move", rename_all = "lowercase", deny_unknown_fields)]
pub enum Action {
    /// Moonrise: a wolf's victim, the Seer's look, the Healer's protection. Villagers send
    /// `{"move":"night"}` (no target) to sleep, so every seat acts the same way.
    Night {
        #[serde(default)]
        target: Option<usize>,
    },
    /// Council: one structured move.
    Council {
        kind: String,
        #[serde(default)]
        role: Option<Role>,
        #[serde(default)]
        target: Option<usize>,
        #[serde(default)]
        wolf: Option<bool>,
        #[serde(default)]
        line: String,
    },
    /// Pyre: who to burn, or None to abstain.
    Vote {
        #[serde(default)]
        target: Option<usize>,
    },
}

/// The cast: the nine painted characters of the client (ids ash, wren, corin, bram, juno, hale,
/// maud, tobias, pell). Larger tables reuse them.
pub const PERSONAS: u8 = 9;
pub const LINE_MAX: usize = 120;

/// How many of each role a table of `n` gets: (wolves, seer, healer).
pub fn roles_for(n: usize) -> (usize, bool, bool) {
    ((n / 4).max(1), n >= 5, n >= 6)
}

impl State {
    pub fn seat_of(&self, player: &str) -> Option<usize> {
        self.seats.iter().position(|s| s.wallet.as_deref().is_some_and(|w| w.eq_ignore_ascii_case(player)))
    }
    pub fn alive_count(&self) -> usize {
        self.seats.iter().filter(|s| s.alive).count()
    }
    fn alive(&self) -> Vec<usize> {
        (0..self.seats.len()).filter(|&i| self.seats[i].alive).collect()
    }
    fn wolves_alive(&self) -> usize {
        self.seats.iter().filter(|s| s.alive && s.role == Role::Wolf).count()
    }
    fn valid(&self, target: usize) -> bool {
        target < self.seats.len() && self.seats[target].alive
    }
    /// Every living entrant has chosen this phase.
    fn all_in(&self) -> bool {
        self.alive().into_iter().filter(|&i| self.seats[i].wallet.is_some()).all(|i| match self.phase {
            Phase::Night => self.night.contains_key(&i),
            Phase::Council => self.council.contains_key(&i),
            Phase::Pyre => self.votes.contains_key(&i),
            _ => true,
        })
    }
    fn check_win(&self) -> Option<Team> {
        let wolves = self.wolves_alive();
        let rest = self.alive().len() - wolves;
        if wolves == 0 {
            Some(Team::Village)
        } else if wolves >= rest {
            Some(Team::Wolves)
        } else {
            None
        }
    }
    fn team(&self, seat: usize) -> Team {
        if self.seats[seat].role == Role::Wolf { Team::Wolves } else { Team::Village }
    }
    /// Seats revealed to everyone (dead seats, and all of them once the game is over).
    fn revealed(&self, seat: usize) -> bool {
        self.phase == Phase::End || !self.seats[seat].alive
    }
}

fn phase_ms(config: &Config, phase: Phase) -> u64 {
    match phase {
        Phase::Night => config.night_ms,
        Phase::Dawn => config.dawn_ms,
        Phase::Council => config.council_ms,
        Phase::Pyre => config.pyre_ms,
        Phase::Dusk => config.dusk_ms,
        Phase::End => 0,
    }
}

/// Enters `phase` at `now`: clears the choices and lets the house seats choose, from what they may know.
fn enter(config: &Config, s: &mut State, phase: Phase, now: u64) {
    s.phase = phase;
    s.deadline_ms = now + phase_ms(config, phase);
    s.night.clear();
    s.council.clear();
    s.votes.clear();
    let house: Vec<usize> = s.alive().into_iter().filter(|&i| s.seats[i].wallet.is_none()).collect();
    match phase {
        Phase::Night => {
            for i in house {
                let t = house_night(s, i);
                s.night.insert(i, t);
            }
        }
        Phase::Council => {
            for i in house {
                let m = house_speech(s, i);
                s.council.insert(i, m);
            }
        }
        Phase::Pyre => {
            for i in house {
                let v = house_vote(s, i);
                s.votes.insert(i, v);
            }
        }
        _ => {}
    }
}

fn pick(rng: &mut Rng64, from: &[usize]) -> Option<usize> {
    if from.is_empty() { None } else { Some(from[rng.below(from.len() as u64) as usize]) }
}

/// Suspicion of each living seat from the public record (and, for a house wolf, nothing more).
fn suspicion(s: &State) -> BTreeMap<usize, i64> {
    let mut score: BTreeMap<usize, i64> = s.alive().into_iter().map(|i| (i, 0)).collect();
    // Seats whose claims the reveals proved false.
    let mut liars: Vec<usize> = vec![];
    let revealed: BTreeMap<usize, Role> = s.seats.iter().enumerate().filter(|(i, _)| s.revealed(*i)).map(|(i, x)| (i, x.role)).collect();
    for e in &s.log {
        if let Entry::Council { moves, .. } = e {
            for (who, m) in moves {
                let weight = if s.seats[*who].alive { 1 } else { 2 };
                match (m.kind.as_str(), m.target) {
                    ("accuse", Some(t)) => *score.entry(t).or_default() += 2 * weight,
                    ("report", Some(t)) if m.wolf == Some(true) => {
                        *score.entry(t).or_default() += 3 * weight;
                        if revealed.get(&t).is_some_and(|r| *r != Role::Wolf) {
                            liars.push(*who);
                        }
                    }
                    ("report", Some(t)) if m.wolf == Some(false) => {
                        *score.entry(t).or_default() -= 2;
                        if revealed.get(&t) == Some(&Role::Wolf) {
                            liars.push(*who);
                        }
                    }
                    ("vouch", Some(t)) => {
                        *score.entry(t).or_default() -= 1;
                        if revealed.get(&t) == Some(&Role::Wolf) {
                            liars.push(*who);
                        }
                    }
                    ("claim", _) => {
                        if let Some(r) = m.role {
                            if revealed.get(who).is_some_and(|x| *x != r) {
                                liars.push(*who);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    for l in liars {
        *score.entry(l).or_default() += 6;
    }
    score.retain(|i, _| s.seats[*i].alive);
    score
}

fn most_suspect(s: &State, me: usize, skip: impl Fn(usize) -> bool) -> Option<usize> {
    let score = suspicion(s);
    let best = score.iter().filter(|(i, _)| **i != me && !skip(**i)).map(|(_, v)| *v).max()?;
    if best <= 0 {
        return None;
    }
    score.iter().find(|(i, v)| **i != me && !skip(**i) && **v == best).map(|(i, _)| *i)
}

fn house_night(s: &mut State, me: usize) -> Option<usize> {
    let alive = s.alive();
    match s.seats[me].role {
        Role::Wolf => {
            // The pack agrees on one victim: the first living wolf's choice stands for all.
            let others: Vec<usize> = alive.iter().copied().filter(|&i| s.seats[i].role != Role::Wolf).collect();
            // Prefer whoever claimed a power or accused a wolf in the open.
            let mut loud: Vec<usize> = vec![];
            if let Some(Entry::Council { moves, .. }) = s.log.iter().rev().find(|e| matches!(e, Entry::Council { .. })) {
                for (who, m) in moves {
                    let hit = m.kind == "claim" && matches!(m.role, Some(Role::Seer | Role::Healer))
                        || m.kind == "report"
                        || (m.kind == "accuse" && m.target.is_some_and(|t| s.seats.get(t).is_some_and(|x| x.role == Role::Wolf)));
                    if hit && others.contains(who) {
                        loud.push(*who);
                    }
                }
            }
            let lead = alive.iter().copied().find(|&i| s.seats[i].role == Role::Wolf);
            if let Some(lead) = lead.filter(|&l| l != me) {
                if let Some(t) = s.night.get(&lead).copied().flatten() {
                    return Some(t);
                }
            }
            let pool = if !loud.is_empty() && s.rng.chance(2, 3) { loud } else { others };
            pick(&mut s.rng, &pool)
        }
        Role::Seer => {
            let seen: Vec<usize> = s.looks.iter().map(|l| l.target).collect();
            let pool: Vec<usize> = alive.iter().copied().filter(|&i| i != me && !seen.contains(&i)).collect();
            pick(&mut s.rng, &pool)
        }
        Role::Healer => {
            let pool: Vec<usize> = alive.iter().copied().filter(|&i| Some(i) != s.last_heal).collect();
            pick(&mut s.rng, &pool)
        }
        Role::Villager => None,
    }
}

const LINES_ACCUSE: [&str; 6] = [
    "I don't trust the way they watch the fire.",
    "Too quiet, too careful. That's a wolf's habit.",
    "Their story changes every time I hear it.",
    "They were out past the treeline last night.",
    "Every vote they cast lands where the wolves want it.",
    "Ask them where they were when the howling started.",
];
const LINES_VOUCH: [&str; 4] = [
    "I've known them all winter. Not a wolf.",
    "They spoke true yesterday. Leave them be.",
    "Burn them and you burn one of us.",
    "Their hands are clean. Look elsewhere.",
];
const LINES_SILENT: [&str; 4] = ["I'll listen today.", "Words are cheap at this fire.", "Let the record speak.", "Not yet."];

fn line(rng: &mut Rng64, lines: &[&str]) -> String {
    lines[rng.below(lines.len() as u64) as usize].to_string()
}

fn speech(kind: &str, role: Option<Role>, target: Option<usize>, wolf: Option<bool>, line: String) -> Speech {
    Speech { kind: kind.into(), role, target, wolf, line }
}

fn house_speech(s: &mut State, me: usize) -> Speech {
    let alive = s.alive();
    let role = s.seats[me].role;
    match role {
        Role::Seer => {
            // Report the newest vision of someone still alive.
            if let Some(l) = s.looks.iter().rev().find(|l| s.seats[l.target].alive).cloned() {
                let text = if l.wolf { "The moon showed me the truth. Wolf." } else { "The moon showed me a clean soul." };
                return speech("report", None, Some(l.target), Some(l.wolf), text.into());
            }
        }
        Role::Wolf => {
            let others: Vec<usize> = alive.iter().copied().filter(|&i| s.seats[i].role != Role::Wolf).collect();
            // Sometimes a wolf poses as the Seer and names an innocent.
            if s.rng.chance(1, 4) {
                if let Some(t) = pick(&mut s.rng, &others) {
                    return speech("report", None, Some(t), Some(true), "I am the Seer. The moon named them. Wolf.".into());
                }
            }
            // Pile on whoever the village already suspects, if it isn't a wolf.
            let t = most_suspect(s, me, |i| s.seats[i].role == Role::Wolf).or_else(|| pick(&mut s.rng, &others));
            if let Some(t) = t {
                let text = line(&mut s.rng, &LINES_ACCUSE);
                return speech("accuse", None, Some(t), None, text);
            }
        }
        Role::Healer | Role::Villager => {}
    }
    // Villagers (and a Seer with nothing to say): accuse the most suspect, vouch, or keep quiet.
    let roll = s.rng.below(10);
    if let Some(t) = most_suspect(s, me, |_| false).filter(|_| roll < 7) {
        let text = line(&mut s.rng, &LINES_ACCUSE);
        return speech("accuse", None, Some(t), None, text);
    }
    let others: Vec<usize> = alive.iter().copied().filter(|&i| i != me).collect();
    if roll < 5 {
        if let Some(t) = pick(&mut s.rng, &others) {
            let text = line(&mut s.rng, &LINES_ACCUSE);
            return speech("accuse", None, Some(t), None, text);
        }
    }
    if roll < 7 {
        if let Some(t) = pick(&mut s.rng, &others) {
            let text = line(&mut s.rng, &LINES_VOUCH);
            return speech("vouch", None, Some(t), None, text);
        }
    }
    let text = line(&mut s.rng, &LINES_SILENT);
    speech("silent", None, None, None, text)
}

fn house_vote(s: &mut State, me: usize) -> Option<usize> {
    let wolf = s.seats[me].role == Role::Wolf;
    // The Seer burns a wolf it has seen.
    if s.seats[me].role == Role::Seer {
        if let Some(l) = s.looks.iter().find(|l| l.wolf && s.seats[l.target].alive) {
            return Some(l.target);
        }
    }
    // Include this round's council, which is public by now.
    let t = most_suspect(s, me, |i| wolf && s.seats[i].role == Role::Wolf);
    if t.is_some() {
        return t;
    }
    let pool: Vec<usize> = s.alive().into_iter().filter(|&i| i != me && !(wolf && s.seats[i].role == Role::Wolf)).collect();
    if s.rng.chance(1, 3) { None } else { pick(&mut s.rng, &pool) }
}

/// Closes the phase in play: missing choices count as none, then the phase resolves.
fn resolve(config: &Config, s: &mut State, now: u64) {
    match s.phase {
        Phase::Night => {
            let alive = s.alive();
            // Wolves: the most-picked victim; a tie goes to the pick of the first wolf among them.
            let mut tally: BTreeMap<usize, u32> = BTreeMap::new();
            let mut order: Vec<usize> = vec![];
            for &i in &alive {
                if s.seats[i].role == Role::Wolf {
                    if let Some(t) = s.night.get(&i).copied().flatten() {
                        *tally.entry(t).or_default() += 1;
                        order.push(t);
                    }
                }
            }
            let best = tally.values().copied().max().unwrap_or(0);
            let victim = order.into_iter().find(|t| tally[t] == best && best > 0);
            let mut healed = None;
            for &i in &alive {
                match s.seats[i].role {
                    Role::Seer => {
                        if let Some(t) = s.night.get(&i).copied().flatten() {
                            let wolf = s.seats[t].role == Role::Wolf;
                            s.looks.push(Look { round: s.round, target: t, wolf });
                        }
                    }
                    Role::Healer => healed = s.night.get(&i).copied().flatten(),
                    _ => {}
                }
            }
            s.last_heal = healed;
            let died = victim.filter(|v| Some(*v) != healed);
            if let Some(d) = died {
                s.seats[d].alive = false;
            }
            let role = died.map(|d| s.seats[d].role);
            s.log.push(Entry::Dawn { round: s.round, died, role });
            enter(config, s, Phase::Dawn, now);
            if let Some(w) = s.check_win() {
                finish(s, w, now);
            }
        }
        Phase::Dawn => enter(config, s, Phase::Council, now),
        Phase::Council => {
            let moves: Vec<(usize, Speech)> = s
                .alive()
                .into_iter()
                .map(|i| (i, s.council.get(&i).cloned().unwrap_or_else(|| speech("silent", None, None, None, String::new()))))
                .collect();
            s.log.push(Entry::Council { round: s.round, moves });
            enter(config, s, Phase::Pyre, now);
        }
        Phase::Pyre => {
            let votes: Vec<(usize, Option<usize>)> = s.alive().into_iter().map(|i| (i, s.votes.get(&i).copied().flatten())).collect();
            let mut tally: BTreeMap<usize, u32> = BTreeMap::new();
            for (_, v) in &votes {
                if let Some(t) = v {
                    *tally.entry(*t).or_default() += 1;
                }
            }
            let best = tally.values().copied().max().unwrap_or(0);
            let top: Vec<usize> = tally.iter().filter(|(_, n)| **n == best).map(|(t, _)| *t).collect();
            let burned = if best > 0 && top.len() == 1 { Some(top[0]) } else { None };
            if let Some(b) = burned {
                s.seats[b].alive = false;
            }
            let role = burned.map(|b| s.seats[b].role);
            s.log.push(Entry::Pyre { round: s.round, votes, burned, role });
            enter(config, s, Phase::Dusk, now);
            if let Some(w) = s.check_win() {
                finish(s, w, now);
            }
        }
        Phase::Dusk => {
            s.round += 1;
            enter(config, s, Phase::Night, now);
        }
        Phase::End => {}
    }
}

fn finish(s: &mut State, w: Team, now: u64) {
    s.winner = Some(w);
    s.winners = (0..s.seats.len())
        .filter(|&i| s.team(i) == w)
        .filter_map(|i| s.seats[i].wallet.as_ref().map(|x| x.to_ascii_lowercase()))
        .collect();
    s.phase = Phase::End;
    s.deadline_ms = now;
    s.night.clear();
    s.council.clear();
    s.votes.clear();
}

impl Rules for Game {
    const ID: &'static str = "makeo.nearwolf.v1";
    type Config = Config;
    type State = State;
    type Action = Action;

    fn setup(config: &Config, players: &[String], ctx: &RulesContext) -> Result<State> {
        ensure((4..=16).contains(&config.table), "a table of 4 to 16 seats")?;
        ensure(!players.is_empty() && players.len() <= 16, "1 to 16 entrants")?;
        ensure(config.night_ms > 0 && config.dawn_ms > 0 && config.council_ms > 0 && config.pyre_ms > 0 && config.dusk_ms > 0, "every phase needs a clock")?;
        let n = (config.table as usize).max(players.len());
        let mut luck = ctx.secret()?;
        // Who sits where: entrants and house seats shuffled together.
        let mut sitters: Vec<Option<String>> = players.iter().cloned().map(Some).collect();
        sitters.resize(n, None);
        shuffle(&mut sitters, &mut luck);
        // The roles, shuffled over the seats.
        let (wolves, seer, healer) = roles_for(n);
        let mut roles = vec![Role::Wolf; wolves];
        if seer {
            roles.push(Role::Seer);
        }
        if healer {
            roles.push(Role::Healer);
        }
        roles.resize(n, Role::Villager);
        shuffle(&mut roles, &mut luck);
        // Names: n distinct personas.
        let mut personas: Vec<u8> = (0..PERSONAS).collect();
        shuffle(&mut personas, &mut luck);
        let seats = (0..n).map(|i| Seat { persona: personas[i % PERSONAS as usize], wallet: sitters[i].clone(), role: roles[i], alive: true }).collect();
        let mut s = State {
            players: players.to_vec(),
            seats,
            phase: Phase::Night,
            round: 1,
            deadline_ms: 0,
            seq: 0,
            night: BTreeMap::new(),
            council: BTreeMap::new(),
            votes: BTreeMap::new(),
            last_heal: None,
            looks: vec![],
            log: vec![],
            winner: None,
            winners: vec![],
            rng: luck.rng64(),
        };
        enter(config, &mut s, Phase::Night, ctx.now_ms);
        Ok(s)
    }

    fn act(config: &Config, state: &State, player: &str, action: Action, ctx: &RulesContext) -> Result<State> {
        let me = state.seat_of(player).ok_or("not at this fire")?;
        ensure(state.seats[me].alive, "the dead don't speak")?;
        let mut s = state.clone();
        match action {
            Action::Night { target } => {
                ensure(s.phase == Phase::Night, "it is not night")?;
                ensure(!s.night.contains_key(&me), "you already chose tonight")?;
                let role = s.seats[me].role;
                match (role, target) {
                    (Role::Villager, None) => {}
                    (Role::Villager, Some(_)) => return Err("villagers sleep at night".into()),
                    (_, None) => {}
                    (Role::Wolf, Some(t)) => {
                        ensure(s.valid(t), "pick someone alive")?;
                        ensure(s.seats[t].role != Role::Wolf, "wolves don't hunt wolves")?;
                    }
                    (Role::Seer, Some(t)) => {
                        ensure(s.valid(t) && t != me, "look at someone else alive")?;
                    }
                    (Role::Healer, Some(t)) => {
                        ensure(s.valid(t), "protect someone alive")?;
                        ensure(Some(t) != s.last_heal, "not the same seat two nights running")?;
                    }
                }
                s.night.insert(me, target);
            }
            Action::Council { kind, role, target, wolf, line } => {
                ensure(s.phase == Phase::Council, "the council is not sitting")?;
                ensure(!s.council.contains_key(&me), "you already spoke")?;
                ensure(line.chars().count() <= LINE_MAX, "keep it to one short line")?;
                let line = line.trim().to_string();
                let m = match kind.as_str() {
                    "claim" => {
                        let r = role.ok_or("claim which role?")?;
                        speech("claim", Some(r), None, None, line)
                    }
                    "report" => {
                        let t = target.ok_or("report a vision of whom?")?;
                        ensure(t < s.seats.len(), "no such seat")?;
                        ensure(t != me, "not a vision of yourself")?;
                        speech("report", None, Some(t), Some(wolf.ok_or("wolf or not wolf?")?), line)
                    }
                    "accuse" | "vouch" => {
                        let t = target.ok_or("whom?")?;
                        ensure(s.valid(t) && t != me, "pick someone else alive")?;
                        speech(&kind, None, Some(t), None, line)
                    }
                    "silent" => speech("silent", None, None, None, line),
                    _ => return Err("claim, report, accuse, vouch or silent".into()),
                };
                s.council.insert(me, m);
            }
            Action::Vote { target } => {
                ensure(s.phase == Phase::Pyre, "the pyre is not lit")?;
                ensure(!s.votes.contains_key(&me), "you already voted")?;
                if let Some(t) = target {
                    ensure(s.valid(t) && t != me, "vote for someone else alive")?;
                }
                s.votes.insert(me, target);
            }
        }
        s.seq += 1;
        if s.all_in() {
            resolve(config, &mut s, ctx.now_ms);
        }
        Ok(s)
    }

    fn deadline(_config: &Config, state: &State) -> Option<u64> {
        (state.phase != Phase::End).then_some(state.deadline_ms)
    }

    /// The phase's clock ran out: whoever hasn't chosen has chosen nothing.
    fn timeout(config: &Config, state: &State, ctx: &RulesContext) -> Result<State> {
        let mut s = state.clone();
        resolve(config, &mut s, ctx.now_ms.max(state.deadline_ms));
        s.seq += 1;
        Ok(s)
    }

    fn outcome(_config: &Config, state: &State) -> Option<Outcome> {
        let w = state.winner?;
        let mut won = vec![];
        let mut lost = vec![];
        for (i, seat) in state.seats.iter().enumerate() {
            if let Some(wallet) = &seat.wallet {
                if state.team(i) == w { won.push(wallet.clone()) } else { lost.push(wallet.clone()) }
            }
        }
        let tiers: Vec<Vec<String>> = [won, lost].into_iter().filter(|t| !t.is_empty()).collect();
        Some(Outcome::Ranking { tiers })
    }

    /// What `viewer` may know: their own role (and, for a wolf, the pack and its picks; for the
    /// Seer, their visions; for the Healer, last night's protection), their own choice this
    /// phase, the roles of the dead, and the public record. At the end, everything.
    fn view(_config: &Config, state: &State, viewer: Option<&str>) -> Result<Value> {
        let me = viewer.and_then(|v| state.seat_of(v));
        let my_role = me.map(|m| state.seats[m].role);
        let over = state.phase == Phase::End;
        let wolf = my_role == Some(Role::Wolf);
        let seats: Vec<Value> = state
            .seats
            .iter()
            .enumerate()
            .map(|(i, seat)| {
                let known = over || !seat.alive || Some(i) == me || (wolf && seat.role == Role::Wolf);
                json!({
                    "seat": i,
                    "persona": seat.persona,
                    "alive": seat.alive,
                    "role": if known { json!(seat.role) } else { Value::Null },
                    // Who sat where is the end's reveal.
                    "house": if over { json!(seat.wallet.is_none()) } else { Value::Null },
                    "wallet": if over { json!(seat.wallet) } else { Value::Null },
                })
            })
            .collect();
        let mine = |m: usize| -> Value {
            match state.phase {
                Phase::Night => state.night.get(&m).map_or(Value::Null, |t| json!({ "target": t })),
                Phase::Council => state.council.get(&m).map_or(Value::Null, |x| json!(x)),
                Phase::Pyre => state.votes.get(&m).map_or(Value::Null, |t| json!({ "target": t })),
                _ => Value::Null,
            }
        };
        let pack: Value = if wolf && state.phase == Phase::Night {
            json!(state
                .seats
                .iter()
                .enumerate()
                .filter(|(i, x)| x.alive && x.role == Role::Wolf && Some(*i) != me)
                .map(|(i, _)| json!({ "seat": i, "target": state.night.get(&i).copied().flatten() }))
                .collect::<Vec<_>>())
        } else {
            Value::Null
        };
        let looks = if over || my_role == Some(Role::Seer) { json!(state.looks) } else { Value::Null };
        let last_heal = if over || my_role == Some(Role::Healer) { json!(state.last_heal) } else { Value::Null };
        let (wolves, seer, healer) = roles_for(state.seats.len());
        // Once the game is over nothing is secret: everyone (the room's public view, which the
        // keeper signs into its journal) gets the full rules state, for settlement on NEAR.
        let full = if over { serde_json::to_value(state).map_err(|e| e.to_string())? } else { Value::Null };
        Ok(json!({
            "seats": seats,
            "you": me,
            "role": my_role,
            "phase": state.phase,
            "round": state.round,
            "deadline_ms": state.deadline_ms,
            "seq": state.seq,
            "mine": me.map_or(Value::Null, mine),
            "pack": pack,
            "looks": looks,
            "last_heal": last_heal,
            "log": state.log,
            "winner": state.winner,
            "winners": state.winners,
            "state": full,
            "deal": { "wolves": wolves, "seer": seer, "healer": healer, "seats": state.seats.len() },
        }))
    }
}

fn shuffle<T>(v: &mut [T], luck: &mut makeo_runtime::Entropy) {
    for i in (1..v.len()).rev() {
        let j = luck.below(i as u64 + 1) as usize;
        v.swap(i, j);
    }
}

#[cfg(target_arch = "wasm32")]
makeo_wasm_abi::export_rules!(Game);

#[cfg(feature = "check")]
impl makeo_conformance::Fuzz for Game {
    fn config() -> Config {
        Config { table: 7, night_ms: 30_000, dawn_ms: 6_000, council_ms: 45_000, pyre_ms: 30_000, dusk_ms: 6_000 }
    }
    fn moves(_: &Config, state: &State, player: &str, rng: &mut makeo_conformance::Rng) -> Vec<Value> {
        let n = state.seats.len();
        let t = rng.below(n as u64 + 1) as usize;
        let me = state.seat_of(player).unwrap_or(0);
        vec![
            json!({"move": "night", "target": t}),
            json!({"move": "night"}),
            json!({"move": "council", "kind": "accuse", "target": t, "line": "You."}),
            json!({"move": "council", "kind": "report", "target": t, "wolf": rng.below(2) == 0, "line": ""}),
            json!({"move": "council", "kind": "claim", "role": "seer"}),
            json!({"move": "council", "kind": "silent"}),
            json!({"move": "council", "kind": "dance"}),
            json!({"move": "vote", "target": t}),
            json!({"move": "vote", "target": me}),
            json!({"move": "vote"}),
        ]
    }
}
