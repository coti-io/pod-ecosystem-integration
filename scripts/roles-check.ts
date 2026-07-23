/**
 * On-chain role verify + configure against central `deployConfig.roles`
 * (same intended roles on every chain/contract). Warn when any deployed role differs.
 */
import { keccak256, toBytes, zeroAddress, type Address, type PublicClient, type WalletClient } from "viem";
import {
  readRoles,
  resolveRoles,
  waitMined,
  type ResolvedChainRoles,
} from "./deploy-utils.js";

export type RoleMismatch = { contract: string; field: string; expected: string; actual: string };

const eqAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const OPERATOR_ROLE = keccak256(toBytes("OPERATOR_ROLE"));
const DEFAULT_ADMIN_ROLE = `0x${"00".repeat(32)}` as `0x${string}`;

const ownableAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "transferOwnership",
    stateMutability: "nonpayable",
    inputs: [{ name: "newOwner", type: "address" }],
    outputs: [],
  },
] as const;

const priceOracleAbi = [
  ...ownableAbi,
  { type: "function", name: "priceAdmin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "setPriceAdmin",
    stateMutability: "nonpayable",
    inputs: [{ name: "admin", type: "address" }],
    outputs: [],
  },
] as const;

const inboxAbi = [
  ...ownableAbi,
  {
    type: "function",
    name: "isMiner",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "addMiner",
    stateMutability: "nonpayable",
    inputs: [{ name: "miner", type: "address" }],
    outputs: [],
  },
] as const;

const factoryAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "feeRecipient", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "rescueRecipient", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "deployers",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "grantRole",
    stateMutability: "nonpayable",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setDeployer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "deployer", type: "address" },
      { name: "allowed", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setRescueRecipient",
    stateMutability: "nonpayable",
    inputs: [{ name: "rescueRecipient_", type: "address" }],
    outputs: [],
  },
] as const;

const pushMismatch = (
  out: RoleMismatch[],
  contract: string,
  field: string,
  expected: string,
  actual: string
) => {
  if (!eqAddr(expected, actual)) {
    out.push({ contract, field, expected, actual });
  }
};

export const collectRoleMismatches = async (params: {
  publicClient: PublicClient;
  chainCfg: Record<string, unknown>;
  roles: ResolvedChainRoles;
}): Promise<RoleMismatch[]> => {
  const { publicClient, chainCfg, roles } = params;
  const mismatches: RoleMismatch[] = [];

  const checkOwnable = async (label: string, addrRaw: unknown, expectedOwner: Address) => {
    if (typeof addrRaw !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(addrRaw)) return;
    const code = await publicClient.getBytecode({ address: addrRaw as Address });
    if (!code || code === "0x") return;
    const owner = (await publicClient.readContract({
      address: addrRaw as Address,
      abi: ownableAbi,
      functionName: "owner",
    })) as Address;
    pushMismatch(mismatches, label, "owner", expectedOwner, owner);
  };

  await checkOwnable("inbox", chainCfg.inbox, roles.inbox.owner);
  if (typeof chainCfg.inbox === "string" && /^0x[a-fA-F0-9]{40}$/.test(chainCfg.inbox)) {
    const inbox = chainCfg.inbox as Address;
    const code = await publicClient.getBytecode({ address: inbox });
    if (code && code !== "0x") {
      for (const miner of roles.inbox.miners) {
        const ok = (await publicClient.readContract({
          address: inbox,
          abi: inboxAbi,
          functionName: "isMiner",
          args: [miner],
        })) as boolean;
        if (!ok) {
          mismatches.push({
            contract: "inbox",
            field: "miner",
            expected: miner,
            actual: "not registered",
          });
        }
      }
    }
  }

  if (typeof chainCfg.priceOracle === "string" && /^0x[a-fA-F0-9]{40}$/.test(chainCfg.priceOracle)) {
    const addr = chainCfg.priceOracle as Address;
    const code = await publicClient.getBytecode({ address: addr });
    if (code && code !== "0x") {
      const owner = (await publicClient.readContract({
        address: addr,
        abi: priceOracleAbi,
        functionName: "owner",
      })) as Address;
      pushMismatch(mismatches, "priceOracle", "owner", roles.priceOracle.owner, owner);
      try {
        const priceAdmin = (await publicClient.readContract({
          address: addr,
          abi: priceOracleAbi,
          functionName: "priceAdmin",
        })) as Address;
        pushMismatch(mismatches, "priceOracle", "priceAdmin", roles.priceOracle.priceAdmin, priceAdmin);
      } catch {
        // Plain PriceOracle without priceAdmin getter — skip.
      }
    }
  }

  const liveAdapter = (chainCfg.oracle as { liveAdapter?: string } | undefined)?.liveAdapter;
  if (liveAdapter && /^0x[a-fA-F0-9]{40}$/.test(liveAdapter) && liveAdapter !== zeroAddress) {
    await checkOwnable("oracleLiveAdapter", liveAdapter, roles.oracleLiveAdapter.owner);
  }

  await checkOwnable("mpcAdder", chainCfg.mpcAdder, roles.mpcAdder.owner);
  await checkOwnable("cotiExecutor", chainCfg.cotiExecutor, roles.cotiExecutor.owner);
  await checkOwnable("cotiMother", chainCfg.cotiMother, roles.cotiMother.owner);

  if (
    typeof chainCfg.privacyPortalFactory === "string" &&
    /^0x[a-fA-F0-9]{40}$/.test(chainCfg.privacyPortalFactory)
  ) {
    const factory = chainCfg.privacyPortalFactory as Address;
    const code = await publicClient.getBytecode({ address: factory });
    if (code && code !== "0x") {
      const fr = roles.privacyPortalFactory;
      const owner = (await publicClient.readContract({
        address: factory,
        abi: factoryAbi,
        functionName: "owner",
      })) as Address;
      pushMismatch(mismatches, "privacyPortalFactory", "admin/owner", fr.admin, owner);

      const feeRecipient = (await publicClient.readContract({
        address: factory,
        abi: factoryAbi,
        functionName: "feeRecipient",
      })) as Address;
      pushMismatch(mismatches, "privacyPortalFactory", "feeRecipient", fr.feeRecipient, feeRecipient);

      const rescueRecipient = (await publicClient.readContract({
        address: factory,
        abi: factoryAbi,
        functionName: "rescueRecipient",
      })) as Address;
      pushMismatch(mismatches, "privacyPortalFactory", "rescueRecipient", fr.rescueRecipient, rescueRecipient);

      for (const op of fr.operators) {
        const has = (await publicClient.readContract({
          address: factory,
          abi: factoryAbi,
          functionName: "hasRole",
          args: [OPERATOR_ROLE, op],
        })) as boolean;
        if (!has) {
          mismatches.push({
            contract: "privacyPortalFactory",
            field: "operator",
            expected: op,
            actual: "missing OPERATOR_ROLE",
          });
        }
      }
      const adminHas = (await publicClient.readContract({
        address: factory,
        abi: factoryAbi,
        functionName: "hasRole",
        args: [DEFAULT_ADMIN_ROLE, fr.admin],
      })) as boolean;
      if (!adminHas) {
        mismatches.push({
          contract: "privacyPortalFactory",
          field: "DEFAULT_ADMIN_ROLE",
          expected: fr.admin,
          actual: "missing",
        });
      }
      for (const d of fr.deployers) {
        const ok = (await publicClient.readContract({
          address: factory,
          abi: factoryAbi,
          functionName: "deployers",
          args: [d],
        })) as boolean;
        if (!ok) {
          mismatches.push({
            contract: "privacyPortalFactory",
            field: "deployer",
            expected: d,
            actual: "not allowed",
          });
        }
      }
    }
  }

  return mismatches;
};

export const formatRoleMismatches = (mismatches: RoleMismatch[]): string => {
  if (mismatches.length === 0) return "ok";
  return mismatches
    .slice(0, 4)
    .map((m) => `${m.contract}.${m.field}: want ${m.expected.slice(0, 10)}… got ${m.actual}`)
    .join("; ");
};

/** Apply grants / transfers the connected wallet can perform. */
export const configureChainRoles = async (params: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Address;
  chainCfg: Record<string, unknown>;
  roles: ResolvedChainRoles;
}): Promise<{ applied: string[]; skipped: string[] }> => {
  const { publicClient, walletClient, account, chainCfg, roles } = params;
  const applied: string[] = [];
  const skipped: string[] = [];
  const writeOpts = { account };

  const tryTransferOwnable = async (label: string, addrRaw: unknown, expectedOwner: Address) => {
    if (typeof addrRaw !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(addrRaw)) return;
    const addr = addrRaw as Address;
    const code = await publicClient.getBytecode({ address: addr });
    if (!code || code === "0x") return;
    const owner = (await publicClient.readContract({
      address: addr,
      abi: ownableAbi,
      functionName: "owner",
    })) as Address;
    if (eqAddr(owner, expectedOwner)) return;
    if (!eqAddr(owner, account)) {
      skipped.push(`${label}.owner: signer is not current owner ${owner}`);
      return;
    }
    const hash = await walletClient.writeContract({
      address: addr,
      abi: ownableAbi,
      functionName: "transferOwnership",
      args: [expectedOwner],
      ...writeOpts,
    });
    await waitMined(publicClient, hash);
    applied.push(`${label}.owner -> ${expectedOwner}`);
  };

  if (typeof chainCfg.inbox === "string" && /^0x[a-fA-F0-9]{40}$/.test(chainCfg.inbox)) {
    const inbox = chainCfg.inbox as Address;
    await tryTransferOwnable("inbox", inbox, roles.inbox.owner);
    const owner = (await publicClient.readContract({
      address: inbox,
      abi: inboxAbi,
      functionName: "owner",
    })) as Address;
    if (eqAddr(owner, account)) {
      for (const miner of roles.inbox.miners) {
        const isMiner = (await publicClient.readContract({
          address: inbox,
          abi: inboxAbi,
          functionName: "isMiner",
          args: [miner],
        })) as boolean;
        if (isMiner) continue;
        const hash = await walletClient.writeContract({
          address: inbox,
          abi: inboxAbi,
          functionName: "addMiner",
          args: [miner],
          ...writeOpts,
        });
        await waitMined(publicClient, hash);
        applied.push(`inbox.addMiner(${miner})`);
      }
    } else if (roles.inbox.miners.length > 0) {
      skipped.push(`inbox.miners: signer is not inbox owner ${owner}`);
    }
  }

  if (typeof chainCfg.priceOracle === "string" && /^0x[a-fA-F0-9]{40}$/.test(chainCfg.priceOracle)) {
    const addr = chainCfg.priceOracle as Address;
    await tryTransferOwnable("priceOracle", addr, roles.priceOracle.owner);
    try {
      const owner = (await publicClient.readContract({
        address: addr,
        abi: priceOracleAbi,
        functionName: "owner",
      })) as Address;
      const priceAdmin = (await publicClient.readContract({
        address: addr,
        abi: priceOracleAbi,
        functionName: "priceAdmin",
      })) as Address;
      if (!eqAddr(priceAdmin, roles.priceOracle.priceAdmin)) {
        if (!eqAddr(owner, account)) {
          skipped.push(`priceOracle.priceAdmin: signer is not owner ${owner}`);
        } else {
          const hash = await walletClient.writeContract({
            address: addr,
            abi: priceOracleAbi,
            functionName: "setPriceAdmin",
            args: [roles.priceOracle.priceAdmin],
            ...writeOpts,
          });
          await waitMined(publicClient, hash);
          applied.push(`priceOracle.priceAdmin -> ${roles.priceOracle.priceAdmin}`);
        }
      }
    } catch {
      // no priceAdmin
    }
  }

  const liveAdapter = (chainCfg.oracle as { liveAdapter?: string } | undefined)?.liveAdapter;
  if (liveAdapter && liveAdapter !== zeroAddress) {
    await tryTransferOwnable("oracleLiveAdapter", liveAdapter, roles.oracleLiveAdapter.owner);
  }

  await tryTransferOwnable("mpcAdder", chainCfg.mpcAdder, roles.mpcAdder.owner);
  await tryTransferOwnable("cotiExecutor", chainCfg.cotiExecutor, roles.cotiExecutor.owner);
  await tryTransferOwnable("cotiMother", chainCfg.cotiMother, roles.cotiMother.owner);

  if (
    typeof chainCfg.privacyPortalFactory === "string" &&
    /^0x[a-fA-F0-9]{40}$/.test(chainCfg.privacyPortalFactory)
  ) {
    const factory = chainCfg.privacyPortalFactory as Address;
    const fr = roles.privacyPortalFactory;
    const isAdmin = (await publicClient.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "hasRole",
      args: [DEFAULT_ADMIN_ROLE, account],
    })) as boolean;
    if (!isAdmin) {
      skipped.push(`privacyPortalFactory: signer lacks DEFAULT_ADMIN_ROLE`);
    } else {
      for (const op of fr.operators) {
        const has = (await publicClient.readContract({
          address: factory,
          abi: factoryAbi,
          functionName: "hasRole",
          args: [OPERATOR_ROLE, op],
        })) as boolean;
        if (has) continue;
        const hash = await walletClient.writeContract({
          address: factory,
          abi: factoryAbi,
          functionName: "grantRole",
          args: [OPERATOR_ROLE, op],
          ...writeOpts,
        });
        await waitMined(publicClient, hash);
        applied.push(`factory.grantRole(OPERATOR, ${op})`);
      }
      for (const d of fr.deployers) {
        const ok = (await publicClient.readContract({
          address: factory,
          abi: factoryAbi,
          functionName: "deployers",
          args: [d],
        })) as boolean;
        if (ok) continue;
        const hash = await walletClient.writeContract({
          address: factory,
          abi: factoryAbi,
          functionName: "setDeployer",
          args: [d, true],
          ...writeOpts,
        });
        await waitMined(publicClient, hash);
        applied.push(`factory.setDeployer(${d})`);
      }
      const rescue = (await publicClient.readContract({
        address: factory,
        abi: factoryAbi,
        functionName: "rescueRecipient",
      })) as Address;
      if (!eqAddr(rescue, fr.rescueRecipient)) {
        const hash = await walletClient.writeContract({
          address: factory,
          abi: factoryAbi,
          functionName: "setRescueRecipient",
          args: [fr.rescueRecipient],
          ...writeOpts,
        });
        await waitMined(publicClient, hash);
        applied.push(`factory.rescueRecipient -> ${fr.rescueRecipient}`);
      }
      // feeRecipient is immutable — mismatches can only be reported, not fixed.
    }
  }

  return { applied, skipped };
};

export { readRoles, readChainRoles, resolveRoles, resolveChainRoles };
