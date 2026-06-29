import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import {
  encodeEventTopics,
  encodePacked,
  getAddress,
  keccak256,
  parseAbiItem,
  toHex,
  zeroAddress,
  zeroHash,
  type Hex,
} from "viem";

const CONFIDENTIAL_TRANSFER = parseAbiItem(
  "event ConfidentialTransfer(address indexed from, address indexed to, bytes32 indexed amount)"
);
const OPERATOR_SET = parseAbiItem("event OperatorSet(address indexed holder, address indexed operator, uint48 until)");
const WRAP_REQUESTED = parseAbiItem(
  "event WrapRequested(address indexed from, address indexed to, uint256 amount, bytes32 indexed mintRequestId)"
);
const UNWRAP_REQUESTED = parseAbiItem(
  "event UnwrapRequested(address indexed receiver, bytes32 indexed unwrapRequestId, bytes32 amount)"
);
const UNWRAP_FINALIZED = parseAbiItem(
  "event UnwrapFinalized(address indexed receiver, bytes32 indexed unwrapRequestId, bytes32 encryptedAmount, uint64 cleartextAmount)"
);

const ERC7984_INTERFACE_ID = "0x4958f2a4" as Hex;

describe("ERC-7984 compatibility", { concurrency: 1 }, async function () {
  const { viem } = await network.connect({ network: "hardhat" });
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const owner = wallet.account.address as `0x${string}`;

  let harness: any;

  before(async function () {
    harness = await viem.deployContract("PodErc7984TestHarness", ["Private Test", "pTST", 6], {
      client: { public: publicClient, wallet },
    });
  });

  it("supports ERC-7984 interface id 0x4958f2a4", async function () {
    assert.equal(await harness.read.supportsInterface([ERC7984_INTERFACE_ID]), true);
    assert.equal(await harness.read.supportsInterface(["0x01ffc9a7"]), true);
    assert.equal(await harness.read.supportsInterface(["0xffffffff"]), false);
  });

  it("maps ctUint256 balances to confidentialBalanceOf handles", async function () {
    const high = 0x1111111111111111111111111111111111111111111111111111111111111111n;
    const low = 0x2222222222222222222222222222222222222222222222222222222222222222n;
    await harness.write.setBalance([owner, { ciphertextHigh: high, ciphertextLow: low }], { account: owner });
    const handle = await harness.read.confidentialBalanceOf([owner]);
    const expected = keccak256(
      encodePacked(["uint256", "uint256"], [high, low])
    );
    assert.equal(handle, expected);
    assert.equal(await harness.read.confidentialTotalSupply(), zeroHash);
  });

  it("emits ConfidentialTransfer with expected topic on completed transfer", async function () {
    const senderHigh = 1n;
    const senderLow = 2n;
    const receiverHigh = 3n;
    const receiverLow = 4n;
    const bob = "0x00000000000000000000000000000000000000b0" as `0x${string}`;

    const txHash = await harness.write.emitCompletedTransfer(
      [owner, bob, { ciphertextHigh: senderHigh, ciphertextLow: senderLow }, { ciphertextHigh: receiverHigh, ciphertextLow: receiverLow }],
      { account: owner }
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const expectedHandle = keccak256(
      encodePacked(["uint256", "uint256"], [receiverHigh, receiverLow])
    );
    const topics = encodeEventTopics({
      abi: [CONFIDENTIAL_TRANSFER],
      eventName: "ConfidentialTransfer",
      args: { from: owner, to: bob, amount: expectedHandle },
    });
    const log = receipt.logs.find((entry) => entry.topics[0] === topics[0]);
    assert.ok(log, "ConfidentialTransfer log missing");
    const topicAddress = (topic: Hex) => getAddress(`0x${topic.slice(-40)}` as `0x${string}`);
    assert.equal(topicAddress(log!.topics[1] as Hex), getAddress(owner));
    assert.equal(topicAddress(log!.topics[2] as Hex), getAddress(bob));
    assert.equal(log!.topics[3], expectedHandle);
    assert.equal(await harness.read.lastConfidentialTransferHandle(), expectedHandle);
  });

  it("uses sender ciphertext handle for burns and receiver handle for mints", async function () {
    const ct = { ciphertextHigh: 9n, ciphertextLow: 8n };
    const handle = keccak256(encodePacked(["uint256", "uint256"], [ct.ciphertextHigh, ct.ciphertextLow]));

    await harness.write.emitCompletedTransfer([owner, zeroAddress, ct, ct], { account: owner });
    assert.equal(await harness.read.lastConfidentialTransferHandle(), handle);

    await harness.write.emitCompletedTransfer([zeroAddress, owner, ct, ct], { account: owner });
    assert.equal(await harness.read.lastConfidentialTransferHandle(), handle);
  });

  it("tracks ERC-7984 operators independently from pToken allowances", async function () {
    const operator = "0x00000000000000000000000000000000000000c0" as `0x${string}`;
    const until = BigInt(Math.floor(Date.now() / 1000) + 3600);
    await harness.write.setOperator([operator, until], { account: owner });
    assert.equal(await harness.read.isOperator([owner, operator]), true);

    const txHash = await harness.write.setOperator([operator, until], { account: owner });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const topics = encodeEventTopics({
      abi: [OPERATOR_SET],
      eventName: "OperatorSet",
      args: { holder: owner, operator, until },
    });
    assert.ok(receipt.logs.some((entry) => entry.topics[0] === topics[0]));
  });
});
