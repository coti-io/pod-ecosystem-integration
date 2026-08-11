# Ecosystem Hardhat CI/CD setup

Hardhat gates for the PoD stack live in **coti-pod-inbox-contracts** (unit/in-mem) and **pod-ecosystem-integration** (in-mem + sim with sibling `file:` deps). Contract pushes to `main` can wake PEI via `repository_dispatch`.

Live COTI RPC / full E2E (PIT dry-run) is **out of scope** for these workflows.

## Architecture

```text
coti-pod-inbox-contracts ──push main──► repository_dispatch ──┐
coti-contracts ───────────push main──► repository_dispatch ──┤
                                                             ▼
                                              pod-ecosystem-integration CI
                                              ├── in-mem Hardhat
                                              └── sim inbox gas
```

| Repo | Workflow | What it runs |
|------|----------|--------------|
| [coti-pod-inbox-contracts](https://github.com/coti-io/coti-pod-inbox-contracts) | `.github/workflows/ci.yml` | `compile` → `check:bytecode-size` → batched `npm test` (8GB heap). On `push` to `main`, optionally dispatches PEI. |
| [pod-ecosystem-integration](https://github.com/coti-io/pod-ecosystem-integration) | `.github/workflows/ci.yml` | Checkout PEI + siblings → **in-mem** + **sim** (`test:ci:in-mem`, `test:ci:sim`). |
| [coti-contracts](https://github.com/coti-io/coti-contracts) | `.github/workflows/dispatch-pei.yml` | On `push` to `main` (or manual), optionally dispatches PEI only (no Hardhat suite here). |

PEI CI triggers:

| Event | Sibling refs used |
|-------|-------------------|
| `pull_request` / `push` to `main` on PEI | `main` for inbox, contracts, sim |
| `workflow_dispatch` | inputs `inbox_ref` / `contracts_ref` / `sim_ref` (default `main`) |
| `repository_dispatch` type `pod-contracts-changed` | `client_payload.repo` + `client_payload.sha` for the changed sibling; others stay `main` |

Payload shape from senders:

```json
{
  "event_type": "pod-contracts-changed",
  "client_payload": {
    "repo": "coti-io/coti-pod-inbox-contracts",
    "sha": "<commit sha>"
  }
}
```

## Secrets checklist

Configure these under each repo: **Settings → Secrets and variables → Actions**.

| Secret | Where to add | Required for | Purpose |
|--------|--------------|--------------|---------|
| `PEI_DISPATCH_PAT` | `coti-pod-inbox-contracts`, `coti-contracts` | Cross-repo wake of PEI after `main` push | Authenticate `POST /repos/coti-io/pod-ecosystem-integration/dispatches`. Default `GITHUB_TOKEN` cannot dispatch to another repo. |
| `CROSS_REPO_PAT` | `pod-ecosystem-integration` | PEI **in-mem** and **sim** jobs | Checkout sibling repos, especially private `cotitech-io/sim-coti-node`. |

If `PEI_DISPATCH_PAT` is missing, sender workflows **skip** dispatch (exit 0) and still run their own jobs. If `CROSS_REPO_PAT` is missing, PEI CI fails at sibling / sim checkout.

### Create `PEI_DISPATCH_PAT`

Token must be allowed to create `repository_dispatch` on **`coti-io/pod-ecosystem-integration`**. Prefer a bot/machine user.

**Fine-grained PAT**

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens**.
2. Resource owner: **`coti-io`** (org must allow the creator to make org tokens).
3. Repository access: only **`coti-io/pod-ecosystem-integration`**.
4. Permissions:
   - **Contents:** Read
   - **Metadata:** Read
   - **Actions:** Read and write (needed to trigger workflows via dispatch)
5. Generate, copy once. Authorize SSO for `coti-io` if the org requires it.
6. Add as repo secret `PEI_DISPATCH_PAT` on **inbox** and **coti-contracts**.

**Classic PAT (fallback)**

- Scope: **`repo`** (sufficient for private PEI + dispatch API).
- Same secret name on both sender repos (same token is fine).

**Smoke test**

```bash
curl -fsS -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer YOUR_PAT_HERE" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/coti-io/pod-ecosystem-integration/dispatches \
  -d '{"event_type":"pod-contracts-changed","client_payload":{"repo":"coti-io/coti-pod-inbox-contracts","sha":"main"}}'
```

Expect HTTP **204**, then a PEI Actions run with event `repository_dispatch`.

### Create `CROSS_REPO_PAT`

Token must **clone**:

| Repository | Notes |
|------------|--------|
| `coti-io/coti-pod-inbox-contracts` | Same org as PEI |
| `coti-io/coti-contracts` | Same org as PEI |
| `cotitech-io/sim-coti-node` | **Private, different org** — this is why a PAT is required |

**Fine-grained**

1. Prefer a user/bot that is a member of both **`coti-io`** and **`cotitech-io`** (or has read access to `sim-coti-node`).
2. Resource owner / repos: grant read on the three repos above (org tokens are per-owner; you may need two fine-grained tokens combined is not supported — use a classic `repo` token that can see both orgs, or a fine-grained token under an account with access to all three).
3. Permissions per repo: **Contents: Read**, **Metadata: Read**.
4. Add as `CROSS_REPO_PAT` on **`coti-io/pod-ecosystem-integration`**.

**Classic PAT (often simpler across two orgs)**

- Scope: **`repo`**
- Account must have read access to `cotitech-io/sim-coti-node` and the `coti-io` siblings.
- Authorize SSO for both orgs if required.

## Local parity

| Package | Command | Notes |
|---------|---------|--------|
| inbox | `npm test` | Batched Hardhat; `NODE_OPTIONS=--max-old-space-size=8192` |
| PEI | `npm run test:ci:in-mem` | Default in-mem; system/live suites gated |
| PEI | `npm run test:ci:sim` | `COTI_BACKEND=sim` estimate + mine gas |

Sibling layout for local `file:` deps (same as CI checkout paths):

```text
workspaces/
  coti-pod-inbox-contracts/
  coti-contracts/
  sim-coti-node/
  pod-ecosystem-integration/
```

## Ops notes

- **Heap:** CI and npm scripts use 8GB (`NODE_OPTIONS=--max-old-space-size=8192`). Raise to `16384` in the workflow if runners still OOM.
- **Inbox batching:** default `npm test` is `test:batched` (sequential Hardhat processes). Do not run two Hardhat compiles against the same `cache/` concurrently.
- **No live COTI secrets** in these workflows; gated system tests stay skipped unless env flags + credentials are set outside this CI.
- **Abandoned:** do not merge `naiem/inbox-views-fallback` experiment branches into this gate.
