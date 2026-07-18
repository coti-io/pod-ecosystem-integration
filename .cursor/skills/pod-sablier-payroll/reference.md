# PoD Sablier Payroll — UI reference

## Contracts (source chain)

| Contract | Role |
|----------|------|
| `PayrollCampaignFactory` | UI create entrypoint |
| `PayrollCampaignFacade` | Campaign surface (claim, clawback, admin) |
| `PayrollVault` | Async payout → COTI |
| `PodClaimStore` | Claimant payload before `claim` |
| pToken (`PodERC20`) | Encrypted payroll token |
| Comptroller | `convertUSDFeeToWei(minFeeUSD)` |

COTI: `PrivatePayrollCoti` — `registerRun` / `registerLeaf` / verify (ops or backend; not normal UI wallet).

## Factory ABI (create)

```solidity
event CampaignCreated(
  address indexed facade,
  uint256 indexed runId,
  address indexed admin,
  address creator,
  address token,
  bytes32 merkleRoot
);

function createCampaign(
  address admin,
  bytes32 merkleRoot,
  address token,
  uint40 campaignStartTime,
  uint40 expiration,
  string calldata campaignName,
  uint256 minFeeUSD
) external returns (address facade, uint256 runId);

function campaignCount() external view returns (uint256);
function campaigns(uint256 i) external view returns (address);
```

## Facade reads for UI

- `admin()`, `DEPLOYER()`, `campaignName()`, `TOKEN()`, `MERKLE_ROOT()`
- `CAMPAIGN_START_TIME()`, `EXPIRATION()`, `hasExpired()`, `firstClaimTime()`
- `hasClaimed(index)`, `calculateMinFeeWei()`, `runId()`, `payrollVault()`, `claimStore()`
- `registeredRecipient(index)`, `amountCommitment(index)` (PoD)

## Create wizard sequence

```ts
// 1. Build merkle off-chain (PoD leaf uses amountCommitment = keccak256(abi.encode(ct)))
const { root, packages } = buildPodMerkle(roster);

// 2. Deploy campaign
const count = await factory.read.campaignCount();
const hash = await factory.write.createCampaign([
  admin,
  root,
  pToken,
  startTime,
  expiration, // 0 = never
  name,
  minFeeUSD,
]);
await publicClient.waitForTransactionReceipt({ hash });
const facade = await factory.read.campaigns([count]);

// 3. Post-create (backend / ops with COTI owner)
// cotiPayroll.registerRun(runId, root)
// for each leaf: cotiPayroll.registerLeaf(...) + facade.registerLeaf(...)

// 4. Fund (employer)
// pToken.transfer(facade, itAmount, callbackFee) + round-trip
// facade.ackPoolCredit(ackIt)
// send native to facade for inbox fees
```

## Claim sequence (employee)

```ts
await claimStore.write.submitPayload([facade, index, verifyIt, proofHandle, payoutIt]);
await facade.write.claim([index, recipient, itAmount, proof], { value: minFeeWei });
// poll hasClaimed(index) + decrypt balance after COTI/pToken mines
```

## Role gating snippet

```ts
const admin = await facade.read.admin();
const isAdmin = connected.toLowerCase() === admin.toLowerCase();
const pkg = rosterPackages.find((p) => p.recipient.toLowerCase() === connected.toLowerCase());
const isEmployee = Boolean(pkg);
```

## Deployment config keys

From `production-payroll-avalancheFuji.json` / Sepolia twin / PEI `deployConfig.json` chain entry:

- `payrollCampaignFactory`
- `payrollVault`
- `payrollClaimStore`
- `payrollCampaignFacade` (template/demo campaign)
- `privatePayrollCoti`
- `comptroller`
- `pToken` / `pTokenKey`
- `inboxSource`, `mpcExecutor`

## Fuji snapshot (2026-07-17)

From `deployments/production-payroll-avalancheFuji.json`:

| Key | Address |
|-----|---------|
| `payrollCampaignFactory` | `0xb9029c2eb84666a0c6434795467184660a85d268` |
| `payrollVault` | `0x4b74b2ddeb21565b18292cf42ec950f44e99be87` |
| `payrollClaimStore` | `0xe0f315496d70a9f041c04d977b7b730b6b431c94` |
| `payrollCampaignFacade` (template) | `0x127A179E4E69125c3dc46c7a8fc46BC0D8403E9C` |
| `privatePayrollCoti` | `0xcdf4d94b3f2ff46e5468fde76d0282be718122dc` |
| `comptroller` | `0x70b48b95ab180906c1e0a8901a658f6f098e00c1` |
| `pToken` (pMTT) | `0x8F34570CEAD49273D5DA8A0E25e728eCC28af267` |
| `inboxSource` / `inboxCoti` | `0xAb625bE229F603f6BBF964474AFf6d5487e364De` |
| `mpcExecutor` | `0x68e151b78d51cea01eef6ee354579e044606a739` |
| `privacyPortal` | `0x64D99D761aC68D1a495B4f7E5bE7277586EDFE78` |
| `owner` | `0xdf9f8fca4591227c092fcbab45a846c19fb6d1ae` |

Prefer the latest manifest after each redeploy. Update this section when addresses change.
