//! makeo check: conformance. The build service adds native-versus-WASM parity.
#![cfg(feature = "check")]
use near_holdem::Game;

#[test]
fn passes_conformance() {
    let report = makeo_conformance::table::check::<Game>(&makeo_conformance::Options::default()).unwrap_or_else(|v| panic!("{v}"));
    println!("{report:?}");
}
