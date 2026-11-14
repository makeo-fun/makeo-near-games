#!/usr/bin/env bash
# One command, no keys, no funds: re-check everything this repo claims.
#   ./verify.sh            all checks (needs bun; cargo optional for the contract tests)
#   ./verify.sh --offline  skip the checks that read NEAR testnet and the live enclave
set -uo pipefail
cd "$(dirname "$0")"

NEAR_POT_CONTRACT="${NEAR_POT_CONTRACT:-pot.makeo-near.testnet}"
KEEPER_URL="${KEEPER_URL:-https://keeper.makeo.fun}"
OFFLINE=0; [ "${1:-}" = "--offline" ] && OFFLINE=1
GAMES=(
  "89411bc3-10c6-42ae-b17d-06442dec8b8d:live:faa2f7de6968ba0132a95e19909d9b99befe26f194bfde88d8ba44798b78efff:free"  # NEARWOLF paid match
  "795650a8-2999-4971-b388-469c19b9c362:live:09f847d247323028fcd88c79114071af76879b6573e9de07ac97753f8473f4b1:free"  # Hold'em paid match
)

declare -a ROWS; FAIL=0
row() { ROWS+=("$(printf '%-6s %s' "$1" "$2")"); [ "$1" = "FAIL" ] && FAIL=1; return 0; }
run() { # run <label> <command...>: PASS if it exits 0
  local label="$1"; shift
  if out=$("$@" 2>&1); then row PASS "$label"; else row FAIL "$label"; printf '\n--- %s ---\n%s\n' "$label" "$(printf '%s' "$out" | tail -20)"; fi
}

command -v bun >/dev/null || { echo "verify.sh needs bun (https://bun.sh)"; exit 2; }
(cd verify && bun install --silent >/dev/null 2>&1)
(cd actors && bun install --silent >/dev/null 2>&1)

run "AI receipts: every NEAR AI move re-verified offline (hashes, signed text, signer, attestation)" \
  bun verify/receipts.ts actors/receipts/*.receipts.json
run "Verifier unit tests (golden vectors from the keeper and viem, a real NEAR AI signature)" \
  bash -c "cd verify && bun test"
if command -v cargo >/dev/null; then
  run "Contract tests (forged entries, wrong signer, tampered state, refunds, AI counted out)" \
    bash -c "cd contracts/makeo-pot && cargo test --quiet"
else
  row SKIP "Contract tests (install Rust to run: cd contracts/makeo-pot && cargo test)"
fi
if [ "$OFFLINE" = 0 ]; then
  for g in "${GAMES[@]}"; do
    run "On chain: ${g%%:*}… settled by the registered Nitro keeper (state hash, signature, live attestation)" \
      env NEAR_POT_CONTRACT="$NEAR_POT_CONTRACT" bun verify/near.ts "$g" --keeper-url "$KEEPER_URL"
  done
else
  row SKIP "On-chain checks (run without --offline)"
fi

echo; printf '%s\n' "${ROWS[@]}"
if [ "$FAIL" = 0 ]; then echo; echo "Everything checks out."; exit 0; else echo; echo "Some checks failed (details above)."; exit 1; fi
