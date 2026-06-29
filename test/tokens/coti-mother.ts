import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeFunctionData, parseAbi } from "viem";
import { deployInboxWithInit } from "../system/mpc-test-utils.js";

const CONSTANT_FEE = {
  constantFee: 1n,
  gasPerByte: 0n,
  callbackExecutionGas: 0n,
  errorLength: 0n,
  bufferRatioX10000: 0n,
} as const;

const ONLY_INBOX_SELECTOR = "0xc4b7686e";

const deployInboxWithFees = async (
  viem: any,
  chainId: bigint,
  client: { public: any; wallet: any },
  owner: `0x${string}`
) => {
  const inbox = await deployInboxWithInit(viem, chainId, { client });
  const oracle = await viem.deployContract("PriceOracle", [owner], { client });
  await oracle.write.setLocalTokenPriceUSD([10n ** 18n], { account: owner });
  await oracle.write.setRemoteTokenPriceUSD([10n ** 18n], { account: owner });
  await inbox.write.setPriceOracle([oracle.address], { account: owner });
  await inbox.write.updateMinFeeConfigs([{ ...CONSTANT_FEE }, { ...CONSTANT_FEE }], { account: owner });
  return inbox;
};

const expectCustomError = async (run: () => Promise<unknown>, selector: string) => {
  await assert.rejects(run, (err: unknown) => {
    const text = err instanceof Error ? `${err.message} ${String((err as any).cause ?? "")}` : String(err);
    return text.includes(selector);
  });
};

describe("PodErc20CotiMother", { concurrency: 1 }, async function () {
  const { viem } = await network.connect({ network: "hardhat" });
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const owner = wallet.account.address as `0x${string}`;
  const client = { public: publicClient, wallet };

  it("rejects direct registerToken calls", async function () {
    const inbox = await deployInboxWithFees(viem, 31337n, client, owner);
    const mother = await viem.deployContract("PodErc20CotiMother", [inbox.address, owner], { client });

    await expectCustomError(
      () => mother.write.registerToken([owner, "Token", "TKN", 18], { account: owner }),
      ONLY_INBOX_SELECTOR
    );
  });

  it("ownerMint reverts on the unified mother ledger", async function () {
    const inbox = await deployInboxWithFees(viem, 31337n, client, owner);
    const mother = await viem.deployContract("PodErc20CotiMother", [inbox.address, owner], { client });

    await assert.rejects(() => mother.write.ownerMint([owner, 1n], { account: owner }));
  });

  it("tokenId packs sourceChainId and remotePToken without keccak", async function () {
    const inbox = await deployInboxWithFees(viem, 31337n, client, owner);
    const mother = await viem.deployContract("PodErc20CotiMother", [inbox.address, owner], { client });
    const sourceChainId = 11155111n;
    const pToken = "0x00000000000000000000000000000000000000a1" as `0x${string}`;
    const expected =
      `0x${((sourceChainId << 160n) | BigInt(pToken)).toString(16).padStart(64, "0")}` as `0x${string}`;
    assert.equal(await mother.read.tokenId([sourceChainId, pToken]), expected);
  });

  it("registers tokens only from allowlisted factories via inbox", async function () {
    const sourceChainId = 11155111n;
    const cotiChainId = 7082400n;
    const sourceInbox = await deployInboxWithFees(viem, sourceChainId, client, owner);
    const cotiInbox = await deployInboxWithFees(viem, cotiChainId, client, owner);
    const mother = await viem.deployContract("PodErc20CotiMother", [cotiInbox.address, owner], { client });
    const pToken = "0x00000000000000000000000000000000000000b2" as `0x${string}`;

    await cotiInbox.write.addMiner([owner], { account: owner });
    await mother.write.setAllowedFactory([sourceChainId, owner, true], { account: owner });

    const data = encodeFunctionData({
      abi: parseAbi([
        "function registerToken(address remotePToken, string name, string symbol, uint8 decimals)",
      ]),
      functionName: "registerToken",
      args: [pToken, "Private SEC", "pSEC", 6],
    });

    await sourceInbox.write.sendOneWayMessage(
      [
        cotiChainId,
        mother.address,
        { selector: "0x00000000", data, datatypes: [], datalens: [] },
        "0x00000000",
      ],
      { account: owner, value: 2_500_000_000_000n }
    );

    const requestCount = await sourceInbox.read.getRequestsLen([cotiChainId]);
    const requests = await sourceInbox.read.getRequests([cotiChainId, requestCount - 1n, 1n]);
    const request = requests[0];

    await cotiInbox.write.batchProcessRequests(
      [
        sourceChainId,
        [
          {
            requestId: request.requestId,
            sourceContract: owner,
            targetContract: mother.address,
            methodCall: request.methodCall,
            callbackSelector: request.callbackSelector,
            errorSelector: request.errorSelector,
            isTwoWay: request.isTwoWay,
            sourceRequestId: request.sourceRequestId,
            targetFee: 2_500_000n,
            callerFee: request.callerFee,
          },
        ],
      ],
      { account: owner, gas: 8_000_000n }
    );

    assert.equal(await mother.read.isRegistered([sourceChainId, pToken]), true);
    const tokenKey = await mother.read.tokenId([sourceChainId, pToken]);
    const [name, symbol, decimals] = await mother.read.tokenMeta([tokenKey]);
    assert.equal(symbol, "pSEC");
    assert.equal(decimals, 6);
    assert.equal(name, "Private SEC");
  });

  it("rejects duplicate registration", async function () {
    const sourceChainId = 11155111n;
    const cotiChainId = 7082400n;
    const sourceInbox = await deployInboxWithFees(viem, sourceChainId, client, owner);
    const cotiInbox = await deployInboxWithFees(viem, cotiChainId, client, owner);
    const mother = await viem.deployContract("PodErc20CotiMother", [cotiInbox.address, owner], { client });
    const pToken = "0x00000000000000000000000000000000000000b3" as `0x${string}`;

    await cotiInbox.write.addMiner([owner], { account: owner });
    await mother.write.setAllowedFactory([sourceChainId, owner, true], { account: owner });

    const registerOnce = async () => {
      const data = encodeFunctionData({
        abi: parseAbi([
          "function registerToken(address remotePToken, string name, string symbol, uint8 decimals)",
        ]),
        functionName: "registerToken",
        args: [pToken, "Private SEC", "pSEC", 6],
      });
      await sourceInbox.write.sendOneWayMessage(
        [
          cotiChainId,
          mother.address,
          { selector: "0x00000000", data, datatypes: [], datalens: [] },
          "0x00000000",
        ],
        { account: owner, value: 2_500_000_000_000n }
      );
      const requestCount = await sourceInbox.read.getRequestsLen([cotiChainId]);
      const requests = await sourceInbox.read.getRequests([cotiChainId, requestCount - 1n, 1n]);
      const request = requests[0];
      await cotiInbox.write.batchProcessRequests(
        [
          sourceChainId,
          [
            {
              requestId: request.requestId,
              sourceContract: owner,
              targetContract: mother.address,
              methodCall: request.methodCall,
              callbackSelector: request.callbackSelector,
              errorSelector: request.errorSelector,
              isTwoWay: request.isTwoWay,
              sourceRequestId: request.sourceRequestId,
              targetFee: 2_500_000n,
              callerFee: request.callerFee,
            },
          ],
        ],
        { account: owner, gas: 8_000_000n }
      );
    };

    await registerOnce();
    await registerOnce();
    const requestId2 = await sourceInbox.read.getRequestId([sourceChainId, cotiChainId, 2n]);
    const errors = await cotiInbox.read.errors([requestId2]);
    assert.equal(Number(errors[1]), 1);
  });

  it("isolates balances between registered token namespaces", async function () {
    const sourceChainId = 11155111n;
    const cotiChainId = 7082400n;
    const sourceInbox = await deployInboxWithFees(viem, sourceChainId, client, owner);
    const cotiInbox = await deployInboxWithFees(viem, cotiChainId, client, owner);
    const mother = await viem.deployContract("PodErc20CotiMother", [cotiInbox.address, owner], { client });
    const pTokenA = "0x00000000000000000000000000000000000000c1" as `0x${string}`;
    const pTokenB = "0x00000000000000000000000000000000000000c2" as `0x${string}`;

    await cotiInbox.write.addMiner([owner], { account: owner });
    await mother.write.setAllowedFactory([sourceChainId, owner, true], { account: owner });

    for (const [pToken, symbol] of [
      [pTokenA, "pA"],
      [pTokenB, "pB"],
    ] as const) {
      const data = encodeFunctionData({
        abi: parseAbi([
          "function registerToken(address remotePToken, string name, string symbol, uint8 decimals)",
        ]),
        functionName: "registerToken",
        args: [pToken, `Private ${symbol}`, symbol, 18],
      });
      await sourceInbox.write.sendOneWayMessage(
        [
          cotiChainId,
          mother.address,
          { selector: "0x00000000", data, datatypes: [], datalens: [] },
          "0x00000000",
        ],
        { account: owner, value: 2_500_000_000_000n }
      );
      const requestCount = await sourceInbox.read.getRequestsLen([cotiChainId]);
      const requests = await sourceInbox.read.getRequests([cotiChainId, requestCount - 1n, 1n]);
      const request = requests[0];
      await cotiInbox.write.batchProcessRequests(
        [
          sourceChainId,
          [
            {
              requestId: request.requestId,
              sourceContract: owner,
              targetContract: mother.address,
              methodCall: request.methodCall,
              callbackSelector: request.callbackSelector,
              errorSelector: request.errorSelector,
              isTwoWay: request.isTwoWay,
              sourceRequestId: request.sourceRequestId,
              targetFee: 2_500_000n,
              callerFee: request.callerFee,
            },
          ],
        ],
        { account: owner, gas: 8_000_000n }
      );
    }

    const idA = await mother.read.tokenId([sourceChainId, pTokenA]);
    const idB = await mother.read.tokenId([sourceChainId, pTokenB]);
    assert.notEqual(idA, idB);
    assert.equal(await mother.read.isRegistered([sourceChainId, pTokenA]), true);
    assert.equal(await mother.read.isRegistered([sourceChainId, pTokenB]), true);
  });
});
