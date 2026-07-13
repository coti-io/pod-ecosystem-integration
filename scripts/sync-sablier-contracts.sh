#!/usr/bin/env bash
# Sync sablier-payroll/contracts → contracts/sablier-payroll for Hardhat compile.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/sablier-payroll/contracts"
DST="$ROOT/contracts/sablier-payroll"
rm -rf "$DST"
mkdir -p "$DST/mocks"
cp "$SRC/SablierMerkleInstantHarness.sol" "$DST/"
cp "$SRC/mocks/"*.sol "$DST/mocks/"
echo "Synced sablier contracts to $DST"
