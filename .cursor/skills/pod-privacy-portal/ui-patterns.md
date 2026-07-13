# UI Patterns

## Action State

Track every source-chain action as a local request record. Persist this in local storage or backend storage; do not rely only on in-memory React state.

```ts
type PortalActionStatus =
  | "wallet-signing"
  | "source-submitted"
  | "source-mined"
  | "pod-pending"
  | "succeeded"
  | "failed"
  | "burn-debt";

type PortalRequest = {
  kind: "deposit" | "withdraw" | "direct-transfer" | "direct-approve" | "burn-cleanup";
  sourceTxHash: `0x${string}`;
  requestId?: `0x${string}`;
  withdrawalId?: `0x${string}`;
  user: `0x${string}`;
  recipient?: `0x${string}`;
  portal: `0x${string}`;
  pToken: `0x${string}`;
  amount: bigint;
  status: PortalActionStatus;
  createdAt: number;
};
```

## Fee Helper

Quote **portal** and **PoD** fees separately, then sum for `msg.value`. Do not use `pToken.estimateFee()` or the PoD legs of `estimateDepositFees` via plain `readContract` — `tx.gasprice` is 0 in eth_call and returns zeros.

```ts
const POD_FEE_REMOTE_CALL_SIZE = 512n;
const POD_FEE_CALLBACK_CALL_SIZE = 512n;
const POD_FEE_REMOTE_EXEC_GAS = 300_000n;
const POD_FEE_CALLBACK_EXEC_GAS = 300_000n;

const inboxFeeAbi = [
  {
    type: "function",
    name: "calculateTwoWayFeeRequiredInLocalToken",
    stateMutability: "view",
    inputs: [
      { name: "remoteMethodCallSize", type: "uint256" },
      { name: "callBackMethodCallSize", type: "uint256" },
      { name: "remoteMethodExecutionGas", type: "uint256" },
      { name: "callBackMethodExecutionGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
    ],
    outputs: [
      { name: "targetFeeLocalWei", type: "uint256" },
      { name: "callerFeeLocalWei", type: "uint256" },
    ],
  },
] as const;

async function quotePodInboxFee(publicClient: any, pToken: `0x${string}`, podPTokenAbi: any) {
  const inbox = await publicClient.readContract({
    address: pToken,
    abi: podPTokenAbi,
    functionName: "inbox",
  });
  const gasPrice = await publicClient.getGasPrice();
  const [targetFeeWei, callbackFeeWei] = await publicClient.readContract({
    address: inbox,
    abi: inboxFeeAbi,
    functionName: "calculateTwoWayFeeRequiredInLocalToken",
    args: [
      POD_FEE_REMOTE_CALL_SIZE,
      POD_FEE_CALLBACK_CALL_SIZE,
      POD_FEE_REMOTE_EXEC_GAS,
      POD_FEE_CALLBACK_EXEC_GAS,
      gasPrice,
    ],
  });
  return { totalFeeWei: targetFeeWei + callbackFeeWei, targetFeeWei, callbackFeeWei, gasPrice };
}

async function quotePortalFee(
  publicClient: any,
  portal: `0x${string}`,
  amount: bigint,
  privacyPortalAbi: any,
  isDeposit: boolean
) {
  const fn = isDeposit ? "estimateDepositFees" : "estimateWithdrawFees";
  const [portalFee, usedDynamicPricing] = await publicClient.readContract({
    address: portal,
    abi: privacyPortalAbi,
    functionName: fn,
    args: [amount],
  }).then(([pf, dyn]: [bigint, boolean]) => [pf, dyn] as const);
  return { portalFee, usedDynamicPricing };
}

async function quoteDepositFees(publicClient: any, portal: `0x${string}`, pToken: `0x${string}`, amount: bigint, privacyPortalAbi: any, podPTokenAbi: any) {
  const { portalFee, usedDynamicPricing } = await quotePortalFee(publicClient, portal, amount, privacyPortalAbi, true);
  const pod = await quotePodInboxFee(publicClient, pToken, podPTokenAbi);
  return {
    portalFee,
    usedDynamicPricing,
    mintTotalFee: pod.totalFeeWei,
    mintCallbackFee: pod.callbackFeeWei,
    msgValue: portalFee + pod.totalFeeWei,
  };
}

async function quoteWithdrawFees(publicClient: any, portal: `0x${string}`, pToken: `0x${string}`, amount: bigint, privacyPortalAbi: any, podPTokenAbi: any) {
  const { portalFee, usedDynamicPricing } = await quotePortalFee(publicClient, portal, amount, privacyPortalAbi, false);
  const pod = await quotePodInboxFee(publicClient, pToken, podPTokenAbi);
  return {
    portalFee,
    usedDynamicPricing,
    transferTotalFee: pod.totalFeeWei,
    transferCallbackFee: pod.callbackFeeWei,
    msgValue: portalFee + pod.totalFeeWei,
  };
}
```

## Deposit

Deposit has one normal ERC20 approval and one PoD request.

```ts
import { decodeEventLog } from "viem";

async function depositPrivateToken({
  publicClient,
  walletClient,
  underlying,
  portal,
  user,
  recipient,
  amount,
  erc20Abi,
  privacyPortalAbi,
  podPTokenAbi,
}: any) {
  const allowance = await publicClient.readContract({
    address: underlying,
    abi: erc20Abi,
    functionName: "allowance",
    args: [user, portal],
  });

  if (allowance < amount) {
    const approveHash = await walletClient.writeContract({
      address: underlying,
      abi: erc20Abi,
      functionName: "approve",
      args: [portal, amount],
      account: user,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
  }

  const pToken = await publicClient.readContract({
    address: portal,
    abi: privacyPortalAbi,
    functionName: "pToken",
  });

  const fees = await quoteDepositFees(publicClient, portal, pToken, amount, privacyPortalAbi, podPTokenAbi);

  const hash = await walletClient.writeContract({
    address: portal,
    abi: privacyPortalAbi,
    functionName: "deposit",
    args: [recipient, amount, fees.portalFee, fees.mintCallbackFee],
    value: fees.msgValue,
    account: user,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const event = findEvent(receipt, privacyPortalAbi, "DepositRequested");

  return {
    sourceTxHash: hash,
    pToken,
    requestId: event.args.mintRequestId,
  };
}
```

Deposit UI states:

- After source tx mined: show "Deposit submitted".
- After `Transfer(address(0), recipient, ...)` on pToken: show "Private tokens minted".
- If `failedRequests(mintRequestId)` is non-empty: show failure and retry guidance.

## Withdraw With Permit

Withdraw uses EIP-712 permit, then submits one PoD transfer request and escrows fee for the later burn request.

```ts
import { hexToSignature } from "viem";

async function signWithdrawPermit({
  walletClient,
  publicClient,
  pToken,
  portal,
  user,
  amount,
  deadline,
  sourceChainId,
  podPTokenAbi,
}: any) {
  const [name, nonce] = await Promise.all([
    publicClient.readContract({ address: pToken, abi: podPTokenAbi, functionName: "name" }),
    publicClient.readContract({ address: pToken, abi: podPTokenAbi, functionName: "nonces", args: [user] }),
  ]);

  const signature = await walletClient.signTypedData({
    account: user,
    domain: {
      name,
      version: "1",
      chainId: sourceChainId,
      verifyingContract: pToken,
    },
    types: {
      TransferPermit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "TransferPermit",
    message: {
      owner: user,
      spender: portal,
      to: portal,
      value: amount,
      nonce,
      deadline,
    },
  });

  return hexToSignature(signature);
}

async function withdrawPrivateToken({
  publicClient,
  walletClient,
  portal,
  user,
  recipient,
  amount,
  deadline,
  sourceChainId,
  privacyPortalAbi,
  podPTokenAbi,
}: any) {
  const pToken = await publicClient.readContract({
    address: portal,
    abi: privacyPortalAbi,
    functionName: "pToken",
  });

  const fees = await quoteWithdrawFees(publicClient, portal, pToken, amount, privacyPortalAbi, podPTokenAbi);
  const { v, r, s } = await signWithdrawPermit({
    walletClient,
    publicClient,
    pToken,
    portal,
    user,
    amount,
    deadline,
    sourceChainId,
    podPTokenAbi,
  });

  const hash = await walletClient.writeContract({
    address: portal,
    abi: privacyPortalAbi,
    functionName: "requestWithdrawWithPermit",
    args: [
      recipient,
      amount,
      fees.portalFee,
      fees.transferTotalFee,
      fees.transferCallbackFee,
      deadline,
      v,
      r,
      s,
    ],
    value: fees.msgValue,
    account: user,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const event = findEvent(receipt, privacyPortalAbi, "WithdrawalRequested");

  return {
    sourceTxHash: hash,
    pToken,
    withdrawalId: event.args.withdrawalId,
    requestId: event.args.transferRequestId,
  };
}
```

Withdraw UI states:

- After permit signature: show "Permission signed".
- After source tx mined: show "Withdraw requested".
- After `WithdrawalReleased(withdrawalId, recipient, amount)`: show "Withdraw complete".
- If `failedRequests(transferRequestId)` is non-empty or `TransferFailed(user, portal, ...)` appears: show "Private transfer failed".
- If `BurnDebtRecorded` appears after release: still show user withdrawal as complete; flag admin cleanup separately.

## Event Parsing Helper

```ts
function findEvent(receipt: any, abi: any, eventName: string) {
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (decoded.eventName === eventName) {
        return decoded;
      }
    } catch {
      // Ignore logs from other contracts.
    }
  }

  throw new Error(`Missing ${eventName} event`);
}
```

## Polling

Poll source-chain events and pToken request status. The UI does not need to poll COTI contracts.

```ts
async function refreshPortalRequest({
  publicClient,
  request,
  privacyPortalAbi,
  podPTokenAbi,
}: any) {
  if (request.kind === "withdraw" && request.withdrawalId) {
    const logs = await publicClient.getLogs({
      address: request.portal,
      event: privacyPortalAbi.find((item: any) => item.type === "event" && item.name === "WithdrawalReleased"),
      args: { withdrawalId: request.withdrawalId },
      fromBlock: request.fromBlock,
      toBlock: "latest",
    });

    if (logs.length > 0) return { ...request, status: "succeeded" };
  }

  if (request.requestId) {
    const error = await publicClient.readContract({
      address: request.pToken,
      abi: podPTokenAbi,
      functionName: "failedRequests",
      args: [request.requestId],
    });

    if (error !== "0x") return { ...request, status: "failed", error };
  }

  return { ...request, status: "pod-pending" };
}
```

## ABI Selection

Use these ABIs by action:

- Deposit: `erc20Abi` for `allowance`/`approve`, `privacyPortalAbi` for `pToken`/`deposit`/`DepositRequested`, `podPTokenAbi` for `inbox`, inbox fee ABI for PoD quote.
- Withdraw: `privacyPortalAbi` for `pToken`/`requestWithdrawWithPermit`/events, `podPTokenAbi` for `name`/`nonces`/`inbox`/`failedRequests`.
- Private balance status: `podPTokenAbi` for `balanceOfWithStatus`.
- Direct pToken transfer/approve/burn: `podPTokenAbi` only.
- Admin burn debt: `privacyPortalAbi` for `burnDebtAmount`; admin tooling also needs the full portal ABI for `burnAccumulatedDebt`.

## Display Copy

Good labels:

- "Submitted on ETH"
- "PoD request pending"
- "Waiting for private token callback"
- "Private transfer failed"
- "Withdraw released"
- "Burn cleanup pending"

Avoid:

- "Confirmed" immediately after source tx mining.
- "COTI transaction pending" in normal user UI.
- Showing ciphertext balances as readable amounts unless the app has a supported decrypt/display path.
