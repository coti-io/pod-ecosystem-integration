#!/usr/bin/env bash
# Mirror sibling repos into contracts/ for Hardhat (single source root; imports use .. across pod/inbox).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="${ROOT}/contracts"
INBOX="${ROOT}/../coti-pod-inbox-contracts/contracts"
POD="${ROOT}/../coti-contracts/contracts/pod"
MPC_SRC="${ROOT}/../pod-mpc-lib/contracts/utils/mpc"
MPC_EXECUTOR_SRC="${ROOT}/../pod-mpc-lib/contracts/mpc/coti-side/MpcExecutor.sol"

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

# COTI-side MpcExecutor (required by mpc-test-utils / payroll E2E)
if [[ -f "$MPC_EXECUTOR_SRC" ]]; then
  mkdir -p "$CONTRACTS/pod/mpc/coti-side"
  sed \
    's|import "../../utils/mpc/MpcCore.sol"|import "../../../utils/mpc/MpcCore.sol"|' \
    "$MPC_EXECUTOR_SRC" > "$CONTRACTS/pod/mpc/coti-side/MpcExecutor.sol"
  echo "  mpc:   ${MPC_EXECUTOR_SRC} -> pod/mpc/coti-side/MpcExecutor.sol"

  MPC_COTI_SIDE="${ROOT}/../pod-mpc-lib/contracts/mpc/coti-side"
  for f in MpcExecutorCotiProxyInbox.sol MpcExecutorCotiTest.sol; do
    if [[ -f "${MPC_COTI_SIDE}/${f}" ]]; then
      sed \
        -e 's|import "../../utils/mpc/MpcCore.sol"|import "../../../utils/mpc/MpcCore.sol"|' \
        "${MPC_COTI_SIDE}/${f}" > "$CONTRACTS/pod/mpc/coti-side/${f}"
      echo "  mpc:   ${MPC_COTI_SIDE}/${f} -> pod/mpc/coti-side/${f}"
    fi
  done
fi

# simCOTI contracts (local MPC precompile simulator)
SIM="${ROOT}/simCOTI/contracts"
if [[ -d "$SIM" ]]; then
  mkdir -p "$CONTRACTS/simCOTI"
  rsync -a \
    --exclude 'test/' \
    "$SIM/" "$CONTRACTS/simCOTI/"
  mkdir -p "$CONTRACTS/simCOTI/test"
  for f in SimAccountOnboard.sol; do
    if [[ -f "$SIM/$f" ]]; then
      sed 's|import "../../utils/mpc/MpcCore.sol"|import "../utils/mpc/MpcCore.sol"|' \
        "$SIM/$f" > "$CONTRACTS/simCOTI/$f"
    fi
  done
  if [[ -f "$SIM/test/SimSmokeHarness.sol" ]]; then
    sed 's|import "../../utils/mpc/MpcCore.sol"|import "../../utils/mpc/MpcCore.sol"|' \
      "$SIM/test/SimSmokeHarness.sol" > "$CONTRACTS/simCOTI/test/SimSmokeHarness.sol"
  fi
  echo "  sim:   ${SIM} -> contracts/simCOTI/"
fi

echo "Mirrored contracts -> ${CONTRACTS}/"
echo "  inbox: ${INBOX}"
echo "  pod:   ${POD}"
