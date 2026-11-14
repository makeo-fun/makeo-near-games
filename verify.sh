#!/usr/bin/env bash
# Check everything yourself, from a fresh clone: no keys, no secrets, no accounts. Needs bun (and cargo for the
# contract tests; SKIP_RUST=1 skips them). Reads NEAR testnet and the live AWS Nitro enclave; changes nothing.
#
#   ./verify.sh
#
# It runs the contract and verifier tests, checks each settled game on NEAR against the keeper's signed result and
# the enclave's live attestation, rechecks every NEAR AI receipt's TEE signature and its Merkle root anchored on
# chain, and confirms each attack in contracts/makeo-pot/ATTACKS.md was refused on chain.
set -uo pipefail
cd "$(dirname "$0")"
export NEAR_NETWORK=testnet NEAR_POT_CONTRACT=${NEAR_POT_CONTRACT:-pot.makeo-near.testnet}
KEEPER=${KEEPER_URL:-https://keeper.makeo.fun}
GAMES=(
  "89411bc3-10c6-42ae-b17d-06442dec8b8d:live:faa2f7de6968ba0132a95e19909d9b99befe26f194bfde88d8ba44798b78efff:free|NEARWOLF paid match"
  "795650a8-2999-4971-b388-469c19b9c362:live:09f847d247323028fcd88c79114071af76879b6573e9de07ac97753f8473f4b1:free|Hold'em paid match"
  "795650a8-2999-4971-b388-469c19b9c362:live:d382e6d7fec4d6d16d87f8d4326328dca923b18edaf9e1d9688ad1eb27905e30:free|Hold'em (attacked on chain)"
)
LOG=$(mktemp -d)
RESULTS=()
started=$(date +%s)

check() { # check "<name>" <command...>: runs it, records PASS/FAIL, keeps its output in $LOG
  local name=$1; shift
  local t0=$(date +%s) out="$LOG/$(echo "$name" | tr -c 'a-zA-Z0-9' '_').log"
  if "$@" >"$out" 2>&1; then RESULTS+=("PASS|$name|$(( $(date +%s) - t0 ))s")
  else RESULTS+=("FAIL|$name|$(( $(date +%s) - t0 ))s  (see $out)"); fi
  printf '  %-4s %s\n' "${RESULTS[-1]%%|*}" "$name"
}

echo "== installing (bun)"
command -v bun >/dev/null || { echo "bun is required: https://bun.sh"; exit 2; }
check "install verifier deps" bash -c "cd verify && bun install --frozen-lockfile || bun install"
[ -f actors/package.json ] && check "install actor deps (receipt checks)" bash -c "cd actors && bun install --frozen-lockfile || bun install"

echo "== tests"
check "verifier tests (keeper step, EIP-712 entry, receipts root, NEAR AI)" bash -c "cd verify && bun test"
if [ "${SKIP_RUST:-}" = 1 ] || ! command -v cargo >/dev/null; then RESULTS+=("SKIP|contract unit tests (cargo)|-"); echo "  SKIP contract unit tests (no cargo, or SKIP_RUST=1)"
else check "contract unit tests (cargo test: forged entries, tampering, refunds, badges)" bash -c "cd contracts/makeo-pot && cargo test --quiet"; fi

echo "== on chain (NEAR testnet) and the live enclave"
for g in "${GAMES[@]}"; do
  id=${g%%|*}; label=${g#*|}
  receipts="actors/receipts/$(echo "$id" | tr ':' '_').receipts.json"
  args=("$id" --keeper-url "$KEEPER")
  [ -f "$receipts" ] && args+=(--receipts "$receipts")
  check "$label: settled on the keeper's signed result, live Nitro attestation, AI receipts root" bun verify/near.ts "${args[@]}"
done
if [ -f verify/receipts.ts ] && ls actors/receipts/*.receipts.json >/dev/null 2>&1; then
  check "every NEAR AI receipt's TEE signature rechecked" bun verify/receipts.ts actors/receipts/*.receipts.json
fi
check "every attack in ATTACKS.md refused on chain" bun -e '
  const md = await Bun.file("contracts/makeo-pot/ATTACKS.md").text();
  const rows = md.split("\n").filter((l) => l.startsWith("| (")).map((l) => [l.split("|")[1].trim().slice(0, 3), l.match(/`([1-9A-HJ-NP-Za-km-z]{43,44})`/)?.[1]]);
  if (rows.length < 5) throw new Error("no attacks listed");
  for (const [name, hash] of rows) {
    const r = await (await fetch("https://rpc.testnet.fastnear.com", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tx", params: { tx_hash: hash, sender_account_id: "makeo-near.testnet", wait_until: "FINAL" } }) })).json();
    const failed = JSON.stringify(r.result?.status ?? {}).includes("Failure");
    console.log(name, hash, failed ? "refused" : "NOT refused");
    if (!failed) process.exit(1);
  }'

echo
echo "== result ($(( $(date +%s) - started ))s)"
fail=0
for r in "${RESULTS[@]}"; do IFS='|' read -r s n t <<<"$r"; printf '%-4s  %-100s %s\n' "$s" "$n" "$t"; [ "$s" = FAIL ] && fail=1; done
[ $fail = 0 ] && echo "ALL PASS" || echo "SOME CHECKS FAILED (logs in $LOG)"
exit $fail
