export type CotiBackend = "sim" | "testnet";

export function resolveCotiBackend(): CotiBackend {
  const raw = process.env.COTI_BACKEND?.trim().toLowerCase();
  return raw === "testnet" ? "testnet" : "sim";
}

export function resolveCotiNetworkName(backend: CotiBackend = resolveCotiBackend()): "simCoti" | "cotiTestnet" {
  return backend === "sim" ? "simCoti" : "cotiTestnet";
}

export function isSimCotiBackend(): boolean {
  return resolveCotiBackend() === "sim";
}
