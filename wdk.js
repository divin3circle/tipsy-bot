import WalletManagerEvm from "@tetherto/wdk-wallet-evm";
import WalletManagerBtc, { ElectrumWs } from "@tetherto/wdk-wallet-btc";
import { generateMnemonic, validateMnemonic } from "bip39";

let cachedSeed = "";
let cachedNetworks = ["ethereum", "bitcoin"];
let cachedAddresses = {};

let evmManagers = {};
let evmAccounts = {};
let btcManager = null;
let btcAccount = null;
let isInitialized = false;

const WALLET_STORAGE_KEYS = [
  "encryptedSeed",
  "activeNetworks",
  "walletAddresses",
];
const SUPPORTED_CHAINS = ["ethereum", "polygon", "arbitrum", "bitcoin"];

const RPC_PROVIDERS = {
  ethereum: "https://eth.drpc.org",
  polygon: "https://polygon.drpc.org",
  arbitrum: "https://arb1.arbitrum.io/rpc",
};

const TOKEN_CONTRACTS = {
  USDT: {
    ethereum: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    polygon: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    arbitrum: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  },
  XAUT: {
    ethereum: "0x68749665FF8D2d112Fa859AA293F07A622782F38",
  },
};

const TOKEN_DECIMALS = {
  USDT: 6,
  XAUT: 6,
  BTC: 8,
};

function isRealModeEnabled() {
  return globalThis.TIPSY_WDK_REAL_MODE !== false;
}

function normalizeNetworks(networks) {
  return Array.from(
    new Set(
      (Array.isArray(networks) ? networks : ["ethereum", "bitcoin"])
        .map((item) => String(item || "").toLowerCase())
        .filter((item) => SUPPORTED_CHAINS.includes(item)),
    ),
  );
}

function isHexAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ""));
}

function looksLikeBtcAddress(value) {
  return /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(
    String(value || "").trim(),
  );
}

function formatUnits(value, decimals) {
  const typed = typeof value === "bigint" ? value : BigInt(value || 0);
  const places = Number(decimals || 0);
  if (places <= 0) {
    return typed.toString();
  }

  const base = 10n ** BigInt(places);
  const whole = typed / base;
  const fraction = typed % base;
  if (fraction === 0n) {
    return whole.toString();
  }

  const fractionText = fraction
    .toString()
    .padStart(places, "0")
    .replace(/0+$/, "");
  return `${whole.toString()}.${fractionText}`;
}

function mockTransfer(creatorId, amount, token, message, reason) {
  console.log("[TIPSY WDK MOCK]", {
    creatorId,
    amount,
    token,
    message,
    reason,
  });

  return {
    success: true,
    txHash: `mock_${Date.now()}`,
    mocked: true,
    reason,
  };
}

async function hasWalletSeed() {
  if (String(cachedSeed || "").trim()) {
    return true;
  }

  if (!chrome?.storage?.local) {
    return false;
  }

  const stored = await chrome.storage.local.get(WALLET_STORAGE_KEYS);
  return Boolean(String(stored?.encryptedSeed || "").trim());
}

function resetWalletRuntimeState() {
  for (const manager of Object.values(evmManagers)) {
    try {
      manager.dispose();
    } catch {
      // no-op
    }
  }

  if (btcManager) {
    try {
      btcManager.dispose();
    } catch {
      // no-op
    }
  }

  evmManagers = {};
  evmAccounts = {};
  btcManager = null;
  btcAccount = null;
  isInitialized = false;
}

async function initWdk() {
  if (isInitialized) {
    return true;
  }

  const seedPhrase = String(cachedSeed || "").trim();
  if (!seedPhrase) {
    return false;
  }

  resetWalletRuntimeState();
  const addresses = {};

  const evmNetworks = cachedNetworks.filter((network) => network !== "bitcoin");
  for (const network of evmNetworks) {
    const provider = RPC_PROVIDERS[network];
    if (!provider) {
      continue;
    }

    try {
      const manager = new WalletManagerEvm(seedPhrase, { provider });
      const account = await manager.getAccount(0);
      const address = String((await account.getAddress()) || "").trim();

      evmManagers[network] = manager;
      evmAccounts[network] = account;

      if (address) {
        addresses[network] = address;
      }
    } catch (error) {
      console.warn(`[TIPSY] Could not initialize ${network} wallet`, error);
    }
  }

  if (cachedNetworks.includes("bitcoin")) {
    try {
      const electrumClient = new ElectrumWs({
        host: "electrum.blockstream.info",
        port: 50004,
      });

      btcManager = new WalletManagerBtc(seedPhrase, {
        client: electrumClient,
        network: "bitcoin",
      });

      btcAccount = await btcManager.getAccount(0);
      const address = String((await btcAccount.getAddress()) || "").trim();
      if (address) {
        addresses.bitcoin = address;
      }
    } catch (error) {
      console.warn("[TIPSY] Could not initialize bitcoin wallet", error);
    }
  }

  cachedAddresses = { ...cachedAddresses, ...addresses };
  if (Object.keys(addresses).length) {
    await chrome.storage.local.set({ walletAddresses: cachedAddresses });
  }

  isInitialized =
    Object.keys(evmAccounts).length > 0 ||
    Boolean(btcAccount) ||
    (!isRealModeEnabled() && Boolean(seedPhrase));

  return isInitialized;
}

export function validateSeedPhrase(seedPhrase) {
  const phrase = String(seedPhrase || "").trim();
  if (!phrase) {
    return { valid: false, reason: "Seed phrase is required" };
  }

  const valid = validateMnemonic(phrase);
  if (!valid) {
    return { valid: false, reason: "Invalid BIP-39 seed phrase" };
  }

  return { valid: true, reason: "ok" };
}

export async function generateSeedPhrase() {
  return {
    success: true,
    seedPhrase: generateMnemonic(256),
    source: "bip39",
  };
}

export async function initializeWallet(
  seedPhrase,
  networks = ["ethereum", "bitcoin"],
) {
  const validation = validateSeedPhrase(seedPhrase);
  if (!validation.valid) {
    return { success: false, error: validation.reason };
  }

  const normalized = normalizeNetworks(networks);
  if (!normalized.length) {
    return { success: false, error: "No supported networks selected" };
  }

  cachedSeed = String(seedPhrase || "").trim();
  cachedNetworks = normalized;
  cachedAddresses = {};

  await chrome.storage.local.set({
    encryptedSeed: cachedSeed,
    activeNetworks: cachedNetworks,
    walletAddresses: {},
  });

  try {
    await initWdk();
    const status = await getWalletStatus();
    return {
      success: Boolean(status.initialized),
      addresses: status.addresses,
      initialized: status.initialized,
      mode: status.mode,
      activeNetworks: status.activeNetworks,
    };
  } catch (error) {
    return { success: false, error: String(error?.message || error) };
  }
}

export async function initializeWalletFromStorage() {
  const stored = await chrome.storage.local.get(WALLET_STORAGE_KEYS);
  const seedPhrase = String(stored?.encryptedSeed || "").trim();
  const networks = normalizeNetworks(stored?.activeNetworks);

  if (!seedPhrase) {
    return { success: false, error: "No wallet seed found" };
  }

  cachedSeed = seedPhrase;
  cachedNetworks = networks.length ? networks : ["ethereum", "bitcoin"];
  cachedAddresses = stored?.walletAddresses || {};

  try {
    await initWdk();
    return getWalletStatus();
  } catch (error) {
    return { success: false, error: String(error?.message || error) };
  }
}

export async function getWalletStatus() {
  const stored = await chrome.storage.local.get(WALLET_STORAGE_KEYS);
  const hasSeed = Boolean(String(stored?.encryptedSeed || "").trim());
  const networks = normalizeNetworks(stored?.activeNetworks);

  if (!cachedSeed && hasSeed) {
    cachedSeed = String(stored?.encryptedSeed || "").trim();
  }
  if (!cachedNetworks.length && networks.length) {
    cachedNetworks = networks;
  }

  const addresses = {
    ...(stored?.walletAddresses || {}),
    ...cachedAddresses,
  };

  const status = {
    success: true,
    initialized: Boolean(isInitialized),
    mode: isRealModeEnabled() ? "real" : "mock",
    hasSeed,
    activeNetworks: networks.length ? networks : cachedNetworks,
    addresses,
  };

  if (!isInitialized && hasSeed && isRealModeEnabled()) {
    await initWdk();
  }

  const nextAddresses = { ...addresses };

  for (const [network, account] of Object.entries(evmAccounts)) {
    try {
      const address = String((await account.getAddress()) || "").trim();
      if (address) {
        nextAddresses[network] = address;
      }
    } catch {
      // no-op
    }
  }

  if (btcAccount) {
    try {
      const address = String((await btcAccount.getAddress()) || "").trim();
      if (address) {
        nextAddresses.bitcoin = address;
      }
    } catch {
      // no-op
    }
  }

  const changed = JSON.stringify(nextAddresses) !== JSON.stringify(addresses);
  if (changed) {
    cachedAddresses = nextAddresses;
    await chrome.storage.local.set({ walletAddresses: nextAddresses });
  }

  return {
    ...status,
    initialized:
      status.initialized ||
      Object.keys(evmAccounts).length > 0 ||
      Boolean(btcAccount) ||
      (!isRealModeEnabled() && hasSeed),
    addresses: changed ? nextAddresses : addresses,
  };
}

export async function executeWDKTip(
  creatorId,
  amount,
  token,
  message,
  options = {},
) {
  const network = String(options.network || "polygon").toLowerCase();
  const upperToken = String(token || "USDT").toUpperCase();

  if (!isRealModeEnabled()) {
    const hasSeed = await hasWalletSeed();
    if (!hasSeed) {
      return {
        success: false,
        error:
          "Wallet not initialized. Generate and initialize your seed first.",
        reason: "wallet-not-initialized",
      };
    }

    return mockTransfer(
      creatorId,
      amount,
      upperToken,
      message,
      "real-mode-disabled",
    );
  }

  if (!isInitialized) {
    await initializeWalletFromStorage();
  }

  if (upperToken === "BTC") {
    if (network !== "bitcoin") {
      return {
        success: false,
        error: "BTC can only be sent on Bitcoin network",
      };
    }

    if (!btcAccount) {
      return { success: false, error: "Bitcoin wallet not initialized" };
    }

    const destination = String(creatorId || "").trim();
    if (!looksLikeBtcAddress(destination)) {
      return { success: false, error: "Invalid BTC recipient" };
    }

    const satoshis = BigInt(
      Math.floor(Number(amount || 0) * 10 ** TOKEN_DECIMALS.BTC),
    );
    if (satoshis <= 0n) {
      return { success: false, error: "Invalid BTC amount" };
    }

    try {
      const tx = await btcAccount.sendTransaction({
        to: destination,
        value: satoshis,
      });

      return {
        success: true,
        txHash: tx?.hash || tx?.txid || `btc_${Date.now()}`,
        real: true,
      };
    } catch (error) {
      return {
        success: false,
        error: String(error?.message || "btc-transfer-failed"),
      };
    }
  }

  const recipient = String(creatorId || "").trim();
  if (!isHexAddress(recipient)) {
    return {
      success: false,
      error: "Invalid EVM recipient",
    };
  }

  const account = evmAccounts[network];
  if (!account) {
    return {
      success: false,
      error: `No wallet for network: ${network}`,
    };
  }

  const contract = TOKEN_CONTRACTS[upperToken]?.[network];
  if (!contract || !isHexAddress(contract)) {
    return {
      success: false,
      error: `${upperToken} is not available on ${network}`,
    };
  }

  const decimals = TOKEN_DECIMALS[upperToken] || 6;
  const amountUnits = BigInt(Math.floor(Number(amount || 0) * 10 ** decimals));
  if (amountUnits <= 0n) {
    return { success: false, error: "Invalid token amount" };
  }

  try {
    const balanceRaw = await account.getTokenBalance(contract);
    const balanceUnits =
      typeof balanceRaw === "bigint"
        ? balanceRaw
        : BigInt(String(balanceRaw || "0"));

    if (balanceUnits < amountUnits) {
      return {
        success: false,
        error: `Insufficient ${upperToken} balance on ${network}. Required ${formatUnits(amountUnits, decimals)} ${upperToken}, available ${formatUnits(balanceUnits, decimals)} ${upperToken}.`,
        reason: "insufficient_token_balance",
      };
    }
  } catch {
    // If balance read fails, let transfer attempt surface the provider error.
  }

  try {
    const tx = await account.transfer({
      token: contract,
      recipient,
      amount: amountUnits,
    });

    return {
      success: true,
      txHash: tx?.hash || tx?.txid || `evm_${Date.now()}`,
      real: true,
    };
  } catch (error) {
    const rawMessage = String(error?.message || "evm-transfer-failed");
    if (/transfer amount exceeds balance/i.test(rawMessage)) {
      return {
        success: false,
        error: `Insufficient ${upperToken} balance on ${network}.`,
        reason: "insufficient_token_balance",
      };
    }

    return {
      success: false,
      error: rawMessage,
    };
  }
}
