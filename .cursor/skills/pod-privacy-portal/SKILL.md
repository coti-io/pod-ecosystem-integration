---
name: pod-privacy-portal
description: Build UI integrations for the ETH/PoD PrivacyPortal and pERC20 contracts. Use when implementing deposits, withdrawals, pToken balances, permit withdrawals, PoD request tracking, fee calculation, or when the user mentions PrivacyPortal, pERC20, pToken, PoD async requests, or private ERC20 UI flows.
---

# PoD Privacy Portal UI Integration

## When To Use

Use this skill when building a frontend for:

- `PrivacyPortal` deposit and withdraw flows.
- PoD-side private token (`pERC20` / `PodERC20`) balance, status, mint, burn, transfer, approve, or permit flows.
- Tracking async PoD requests from the ETH/source-chain UI.
- Determining whether a submitted action succeeded, failed, is still pending, or needs inbox retry.

## Core Model

PoD pToken operations are not normal synchronous ERC20 actions. The UI sends transactions only on the ETH/source side. A successful source-chain transaction usually means "PoD request submitted", not "private balance changed".

Always model actions as:

1. Submit source-chain transaction.
2. Extract the PoD request id from source-chain events.
3. Track source-chain callback/error events.
4. Read pToken request status (`pending`, `failedRequests`, portal withdrawal state).
5. Update UI state from pToken status/events, not from source transaction success alone.

The UI does not need to call or understand the COTI-side contracts for normal user flows.

## Read First

For details, read these files in this skill folder:

- `reference.md`: contract roles, addresses, ABI fragments, request lifecycle, and UI state machine.
- `ui-patterns.md`: concrete viem-style UI helpers and polling patterns.

## Current Deployment Snapshot

**Source of truth:** repo-root [`deployConfig.json`](../../../deployConfig.json)
(`chains.11155111` / `chains.43113` → `privacyPortalFactory`, `privacyPortalTokens`).
Do not treat this skill snapshot as authoritative if SoT differs.

Sepolia (`11155111`) example keys use dotted `p.*` symbols:

- Shared inbox: `0x3b8B70819f27e0438cBcE7f31894f799da52648F` (`pod.inbox.v2.2`)
- `PrivacyPortalFactory`: `0x11a27bdf2b2c251609d78d5c9b53b3c2d71d663c`

Token `p.MTT`:

- Underlying ERC20: `0xd3f5c63f4D87D2235b295FbA83351d31d0eD1BeE`
- `PrivacyPortal`: `0x7e1fecDBC7393A7165Ae7f5F1c56baA4D12c6fc0`
- PoD pToken: `0x0510F0b32828D5fB472dE5A5bE30b370c5D1a056`
- Decimals: `18`

Token `p.WETH` (native wrap via `depositNative`):

- Underlying WETH: `0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9`
- `PrivacyPortal`: `0x2C8B9bBeC8604143863c90D02FdF626a7D5a51C5`
- PoD pToken: `0xd33A363459c6Ee0C4F8504E380E8D3Aa4F209116`

If a UI project has a newer config, prefer the app-local / SoT config over this snapshot.

## UX Rules

- Show deposit as complete only when the mint callback updates pToken state, not when the deposit transaction is mined.
- For native ETH/AVAX portals (`nativeWrappedUnderlying == true`), use `depositNative` in one tx — do not ask users to wrap WETH/WAVAX first.
- Show withdrawal as requested after `requestWithdrawWithPermit` is mined.
- Show withdrawal as released only after the pToken transfer callback calls the portal and underlying is transferred (ERC20 transfer or native unwrap for WETH/WAVAX portals).
- If a burn submission fails after release, the user is already paid; show it as an admin/keeper cleanup issue, not a user failure.
- If no callback arrives for withdrawal, keep it pending until a pToken failure signal appears or backend/indexer marks the request stale/failed.

## Do Not Assume

- Do not assume the portal can read private pToken balances.
- Do not treat pToken transfers like normal ERC20 `transfer` results.
- Do not infer success from source transaction status alone.
- Do not require users to do async `approve` before withdrawal if the permit path is available.
- Do not build normal UI flows around COTI-side contracts; use the ETH/PoD portal and pToken ABIs.
