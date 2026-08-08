// ─────────────────────────────────────────────────────────────────────────────
// Signer bridges. The Fairblock SDK is signer-agnostic — every op takes an ethers
// v6 signer. This POC produces that signer TWO ways (the "two doors" from the
// architecture decision):
//
//   1. WalletKitSigner — embedded wallet via Turnkey's Embedded Wallet Kit. Signing
//      routes to the wallet-kit SESSION (headless: the session key stamps requests,
//      no modal per signature). We mirror @turnkey/ethers' ethers-correct
//      serialization + signature assembly, but call wallet-kit's stable high-level
//      client (tk.signTransaction / tk.signMessage) instead of the low-level activity
//      API — so there's no coupling to @turnkey/ethers' client-shape expectations.
//
//   2. makeInjectedSigner — self-custody: the user's OWN browser wallet (MetaMask)
//      signs directly. Turnkey holds nothing; Fairblock holds nothing. This is the
//      Hinkal-style "connect your wallet" door.
// ─────────────────────────────────────────────────────────────────────────────
import {
  AbstractSigner,
  BrowserProvider,
  Transaction,
  Signature,
  TypedDataEncoder,
  hashMessage,
  copyRequest,
  resolveProperties,
  resolveAddress,
  getAddress,
  isAddress,
} from "ethers";

// Turnkey returns a raw ECDSA signature { r, s, v } with v as the recovery id
// ("00"/"01"); ethers wants v = 27/28. Assemble into a 65-byte serialized sig.
function assembleSignature({ r, s, v }) {
  return Signature.from({
    r: `0x${r}`,
    s: `0x${s}`,
    v: parseInt(v, 10) + 27,
  }).serialized;
}

// An ethers v6 Signer whose signing routes through the Embedded Wallet Kit session.
// `tkRef` is a React ref to the LATEST useTurnkey() context (so a refreshed session
// is always used — no stale closure). `walletAccount` is the wallet-kit WalletAccount
// object (its .address is the treasury address).
export class WalletKitSigner extends AbstractSigner {
  constructor(tkRef, walletAccount, provider) {
    super(provider);
    this._tkRef = tkRef;
    this.account = walletAccount;
    this.address = getAddress(walletAccount.address);
  }

  get tk() {
    return this._tkRef.current;
  }

  async getAddress() {
    return this.address;
  }

  connect(provider) {
    return new WalletKitSigner(this._tkRef, this.account, provider);
  }

  // Serialize the UNSIGNED tx exactly like ethers' Wallet, hand it to Turnkey to sign,
  // and return the signed serialized tx. AbstractSigner.sendTransaction() populates
  // (nonce/gas/fees/chainId via the connected provider) then calls this then broadcasts.
  async signTransaction(transaction) {
    // eslint-disable-next-line no-unused-vars
    const { from, to, ...txn } = copyRequest(transaction);
    const resolved = await resolveProperties({
      to: transaction.to ? resolveAddress(transaction.to, this.provider) : undefined,
      from: transaction.from ? resolveAddress(transaction.from, this.provider) : undefined,
    });
    // Mimic ethers' Wallet: tx.from is optional, but if present it must match self.
    if (resolved.from != null && getAddress(resolved.from) !== this.address) {
      throw new Error(
        `Transaction from-address mismatch: signer ${this.address}, tx.from ${resolved.from}`,
      );
    }
    const tx = Transaction.from({ ...txn, ...(resolved.to ? { to: resolved.to } : {}) });
    const unsignedTransaction = tx.unsignedSerialized.slice(2); // strip 0x
    const signed = await this.tk.signTransaction({
      walletAccount: this.account,
      unsignedTransaction,
      transactionType: "TRANSACTION_TYPE_ETHEREUM",
    });
    return signed.startsWith("0x") ? signed : `0x${signed}`;
  }

  // Sign a precomputed 32-byte digest via the LOW-LEVEL client (raw payload, NO_OP).
  // We must NOT use the high-level tk.signMessage here: it UTF-8-encodes its `message`
  // argument (it's built for signing a human-readable string), which turns our 32-byte
  // digest into a 66-byte payload and makes NO_OP signing fail with a 400. httpClient's
  // signRawPayload is exactly what the high-level calls internally (and what
  // @turnkey/ethers uses); the 0x-prefixed hex payload matches its own encoder.
  async _signDigest(digest) {
    const client = this.tk?.httpClient;
    if (!client) throw new Error("Wallet Kit client not ready");
    const response = await client.signRawPayload({
      signWith: this.address,
      payload: digest, // 0x-prefixed 32-byte hex
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NO_OP",
    });
    const res =
      response?.activity?.result?.signRawPayloadResult ||
      response?.signRawPayloadResult ||
      response;
    return assembleSignature(res);
  }

  // Personal-sign (EIP-191). ethers computes the digest (handling string OR bytes)
  // exactly as any wallet would, so any key the Fairblock SDK derives from it is
  // byte-for-byte standard.
  async signMessage(message) {
    return this._signDigest(hashMessage(message));
  }

  async signTypedData(domain, types, value) {
    const populated = await TypedDataEncoder.resolveNames(
      domain,
      types,
      value,
      async (name) => (await this.provider?.resolveName(name)) ?? "",
    );
    return this._signDigest(TypedDataEncoder.hash(populated.domain, types, populated.value));
  }
}

// Build the embedded-wallet signer, connected to the app's read/broadcast provider.
export function makeWalletKitSigner(tkRef, walletAccount, provider) {
  if (!walletAccount?.address) return null;
  return new WalletKitSigner(tkRef, walletAccount, provider);
}

// Find the EMBEDDED (Turnkey enclave) Ethereum WalletAccount for the signed-in user.
//
// IMPORTANT: wallet-kit's `wallets` also lists CONNECTED external wallets (MetaMask,
// Rabby, …) once they've been connected to the page — and a connected wallet lingers
// even after we drop our self-custody treasury, because you can't programmatically
// un-connect MetaMask. If we didn't filter, logging in with email/passkey would show
// the user's leftover MetaMask address instead of their new embedded treasury wallet.
// So the embedded path selects ONLY `source === "embedded"` wallets (WalletSource.Embedded).
export function pickEvmAccount(wallets) {
  const list = wallets || [];
  const isEth = (a) => {
    const fmt = a?.addressFormat || "";
    return (fmt.includes("ETHEREUM") || (a?.address && isAddress(a.address))) &&
      /^0x[0-9a-fA-F]{40}$/.test(a?.address || "");
  };
  // 1. Embedded (Turnkey enclave) wallet, when it's explicitly labelled.
  for (const w of list) {
    if (w?.source === "embedded") for (const a of w.accounts || []) if (isEth(a)) return a;
  }
  // 2. Otherwise ANY wallet that is NOT a connected external wallet — this covers
  //    embedded wallets whose `source` field is absent at runtime, while STILL
  //    excluding MetaMask/Rabby/… (source === "connected"), so a lingering connected
  //    wallet never leaks into the embedded-treasury view.
  for (const w of list) {
    if (w?.source !== "connected") for (const a of w.accounts || []) if (isEth(a)) return a;
  }
  return null;
}

// ── Self-custody door: the user's own injected wallet (MetaMask / Rabbit / …) ──
function injected() {
  const eth = typeof window !== "undefined" ? window.ethereum : null;
  if (!eth) throw new Error("No browser wallet found. Install MetaMask (or another EVM wallet).");
  return eth;
}

// Make sure the injected wallet is on the app's selected chain; add it if unknown.
export async function ensureInjectedChain(chainId, network) {
  const eth = injected();
  const hexId = "0x" + Number(chainId).toString(16);
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (e) {
    if (e?.code === 4902 && network) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hexId,
            chainName: network.name,
            rpcUrls: [network.rpcUrl],
            nativeCurrency: {
              name: network.nativeSymbol || "ETH",
              symbol: network.nativeSymbol || "ETH",
              decimals: 18,
            },
            blockExplorerUrls: network.explorerUrl ? [network.explorerUrl] : [],
          },
        ],
      });
    } else {
      throw e;
    }
  }
}

// Prompt-connect the injected wallet and return { signer, address }. The signer signs
// AND broadcasts through the wallet's own provider (self-custody — no Turnkey).
export async function makeInjectedSigner(chainId, network) {
  const eth = injected();
  const bp = new BrowserProvider(eth);
  await bp.send("eth_requestAccounts", []);
  if (chainId) await ensureInjectedChain(chainId, network);
  const signer = await bp.getSigner();
  const address = await signer.getAddress();
  return { signer, address };
}

// Silent reconnect on reload (no prompt) — returns { signer, address } or null.
export async function reconnectInjected(expectedAddress) {
  try {
    const eth = typeof window !== "undefined" ? window.ethereum : null;
    if (!eth) return null;
    const accounts = await eth.request({ method: "eth_accounts" });
    if (!accounts?.length) return null;
    if (expectedAddress && getAddress(accounts[0]) !== getAddress(expectedAddress)) return null;
    const bp = new BrowserProvider(eth);
    const signer = await bp.getSigner();
    return { signer, address: await signer.getAddress() };
  } catch {
    return null;
  }
}
