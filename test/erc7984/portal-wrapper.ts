import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { encodeEventTopics, getAddress, parseAbiItem } from "viem";
import {
  completePTokenTransferCallback,
  deployDirectPortalContext,
  fundUserAndApprovePortal,
  requestWithdraw,
  seedPortalVault,
  type PortalTestContext,
} from "../privacy/privacy-portal-utils.js";

const WRAP_REQUESTED = parseAbiItem(
  "event WrapRequested(address indexed from, address indexed to, uint256 amount, bytes32 indexed mintRequestId)"
);
const UNWRAP_REQUESTED = parseAbiItem(
  "event UnwrapRequested(address indexed receiver, bytes32 indexed unwrapRequestId, bytes32 amount)"
);
const UNWRAP_FINALIZED = parseAbiItem(
  "event UnwrapFinalized(address indexed receiver, bytes32 indexed unwrapRequestId, bytes32 encryptedAmount, uint64 cleartextAmount)"
);

describe("ERC-7984 portal wrapper events", { concurrency: 1 }, async function () {
  const { viem } = await network.connect({ network: "hardhat" });
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const owner = wallet.account.address as `0x${string}`;

  let ctx: PortalTestContext;

  before(async function () {
    ctx = await deployDirectPortalContext({ viem, publicClient, wallet, owner });
  });

  it("exposes underlying() and rate() wrapper views", async function () {
    assert.equal(getAddress(await ctx.portal.read.underlying()), getAddress(ctx.underlying.address));
    assert.equal(await ctx.portal.read.rate(), 1n);
  });

  it("emits WrapRequested on deposit and wrap alias", async function () {
    ctx = await deployDirectPortalContext({ viem, publicClient, wallet, owner });
    await fundUserAndApprovePortal(ctx, 100n);

    const depositHash = await ctx.portal.write.deposit([ctx.recipient, 50n, 77n], {
      account: owner,
      value: 1_000n,
    });
    const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });
    assert.ok(
      depositReceipt.logs.some(
        (entry) => entry.topics[0] === encodeEventTopics({ abi: [WRAP_REQUESTED], eventName: "WrapRequested" })[0]
      )
    );

    await fundUserAndApprovePortal(ctx, 100n);
    const wrapHash = await ctx.portal.write.wrap([ctx.recipient, 25n, 77n], {
      account: owner,
      value: 1_000n,
    });
    const wrapReceipt = await publicClient.waitForTransactionReceipt({ hash: wrapHash });
    assert.ok(
      wrapReceipt.logs.some(
        (entry) => entry.topics[0] === encodeEventTopics({ abi: [WRAP_REQUESTED], eventName: "WrapRequested" })[0]
      )
    );
  });

  it("emits UnwrapRequested on withdraw and UnwrapFinalized on release", async function () {
    ctx = await deployDirectPortalContext({ viem, publicClient, wallet, owner });
    await seedPortalVault(ctx, 500n);

    const fromBlock = await publicClient.getBlockNumber();
    const { withdrawalId } = await requestWithdraw(ctx, 200n);
    const requestedLogs = await publicClient.getLogs({
      address: ctx.portal.address,
      event: UNWRAP_REQUESTED,
      fromBlock,
      toBlock: "latest",
    });
    assert.equal(requestedLogs.length, 1);
    assert.equal(getAddress(requestedLogs[0]!.args.receiver!), getAddress(ctx.recipient));
    assert.equal(requestedLogs[0]!.args.unwrapRequestId, withdrawalId);

    const releaseFromBlock = await publicClient.getBlockNumber();
    await completePTokenTransferCallback(ctx);
    const finalizedLogs = await publicClient.getLogs({
      address: ctx.portal.address,
      event: UNWRAP_FINALIZED,
      fromBlock: releaseFromBlock,
      toBlock: "latest",
    });
    assert.equal(finalizedLogs.length, 1);
    assert.equal(getAddress(finalizedLogs[0]!.args.receiver!), getAddress(ctx.recipient));
    assert.equal(finalizedLogs[0]!.args.unwrapRequestId, withdrawalId);
    assert.equal(finalizedLogs[0]!.args.encryptedAmount, withdrawalId);
    assert.equal(finalizedLogs[0]!.args.cleartextAmount, 200n);
  });
});
