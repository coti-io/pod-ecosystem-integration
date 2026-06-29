#!/usr/bin/env bash
# Mirror sibling repos into contracts/ for Hardhat (single source root; imports use .. across pod/inbox).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="${ROOT}/contracts"
INBOX="${ROOT}/../coti-pod-inbox-contracts/contracts"
POD="${ROOT}/../coti-contracts/contracts/pod"
MPC_SRC="${ROOT}/../pod-mpc-lib/contracts/utils/mpc"

if [[ ! -d "$INBOX" || ! -d "$POD" ]]; then
  echo "error: clone coti-pod-inbox-contracts and coti-contracts as siblings" >&2
  exit 1
fi

rm -rf "$CONTRACTS"
mkdir -p "$CONTRACTS"

# Inbox implementation at contracts/ root
rsync -a \
  --exclude 'utils/' \
  "$INBOX/" "$CONTRACTS/"

# Pod dApps under contracts/pod/
rsync -a "$POD/" "$CONTRACTS/pod/"

# MpcCore (shared; prefer pod-mpc-lib vendored copy for ^0.8.20)
mkdir -p "$CONTRACTS/utils/mpc"
if [[ -d "$MPC_SRC" ]]; then
  rsync -a "$MPC_SRC/" "$CONTRACTS/utils/mpc/"
else
  rsync -a "${ROOT}/../coti-contracts/contracts/utils/mpc/" "$CONTRACTS/utils/mpc/"
fi

echo "Mirrored contracts -> ${CONTRACTS}/"
echo "  inbox: ${INBOX}"
echo "  pod:   ${POD}"
