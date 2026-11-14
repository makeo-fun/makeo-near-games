//! makeo check: conformance of the sit-and-go and of the hand engine at a table.
#![cfg(feature = "check")]
use near_holdem::{Game, Holdem};

#[test]
fn passes_conformance() {
    let report = makeo_conformance::check::<Game>(&makeo_conformance::Options { hidden: true, ..Default::default() }).unwrap_or_else(|v| panic!("{v}"));
    println!("{report:?}");
}

#[test]
fn the_hand_engine_passes_table_conformance() {
    let report = makeo_conformance::table::check::<Holdem>(&makeo_conformance::Options::default()).unwrap_or_else(|v| panic!("{v}"));
    println!("{report:?}");
}
