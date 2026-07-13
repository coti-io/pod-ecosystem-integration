#!/usr/bin/env bash
# Sync pod-payroll-port/contracts → contracts/pod-payroll-port for Hardhat compile.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/pod-payroll-port/contracts"
DST="$ROOT/contracts/pod-payroll-port"
rm -rf "$DST"
mkdir -p "$DST"/{avax,coti,mocks}
cp "$SRC/avax/"*.sol "$DST/avax/"
cp "$SRC/coti/"*.sol "$DST/coti/"
cp "$SRC/mocks/"*.sol "$DST/mocks/"
echo "Synced pod-payroll-port contracts to $DST"
