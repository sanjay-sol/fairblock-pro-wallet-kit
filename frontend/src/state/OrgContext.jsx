import { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import { ethers, getAddress } from "ethers";
import { useTurnkey, AuthState, ClientState } from "@turnkey/react-wallet-kit";
import { loadBackendConfig, buildConfig } from "../config.js";
import {
  getNetwork,
  getTokens,
  networkList,
  loadSelectedChainId,
  saveSelectedChainId,
  explorerTx,
} from "../networks.js";
import { api } from "../lib/api.js";
import { short } from "../lib/format.js";
import {
  makeWalletKitSigner,
  pickEvmAccount,
  makeInjectedSigner,
  reconnectInjected,
  ensureInjectedChain,
} from "../signers.js";
import { saveVault, loadVault, clearVault } from "../vault.js";
import { encryptAmount, decryptAmount } from "../metaCrypto.js";
import { computeAnalytics } from "../lib/analytics.js";
import {
  initConfidential,
  activateAccount,
  deposit as cDeposit,
  confidentialTransfer,
  withdraw as cWithdraw,
  payDirect,
  publicBalance,
  confidentialBalance,
  isActivated,
  resolveToken,
} from "../confidential.js";

const OrgCtx = createContext(null);
export const useOrg = () => useContext(OrgCtx);

// Nominal session length (for any UI that shows it). The AUTHORITATIVE expiry always
// comes from the wallet-kit session (treasury.sessionExpiresAt), which the Auth Proxy
// controls via the dashboard.
const SESSION_SECONDS = 900;

// localStorage holds ONLY the non-secret treasury identity. Secrets (ElGamal keys) live
// in the encrypted IndexedDB vault (see vault.js). For embedded (Turnkey) treasuries the
// wallet-kit session itself is managed by wallet-kit; we only remember identity so the
// self-custody (external) treasury can be reconnected on reload.
const TKEY = "fbp-wk-treasury";
const loadTreasury = () => {
  try {
    return JSON.parse(localStorage.getItem(TKEY) || "null");
  } catch {
    return null;
  }
};
const saveTreasuryId = (t) =>
  t
    ? localStorage.setItem(
        TKEY,
        JSON.stringify({
          kind: t.kind, // "turnkey" | "external"
          label: t.label,
          subOrgId: t.subOrgId || null,
          address: t.address,
          userId: t.userId || null,
          email: t.email || null,
          authMethod: t.authMethod || null,
        }),
      )
    : localStorage.removeItem(TKEY);

// Per-chain token registry: the network's supported tokens + any the user has added
// by address (validated on-chain via resolveToken). Selected token is persisted per chain.
const CUSTOM_TOKENS_KEY = (cid) => `fbp-wk-tokens-${cid}`;
const SEL_TOKEN_KEY = (cid) => `fbp-wk-seltoken-${cid}`;
const sameAddr = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const loadCustomTokens = (cid) => {
  try { return JSON.parse(localStorage.getItem(CUSTOM_TOKENS_KEY(cid)) || "[]"); } catch { return []; }
};
const saveCustomTokens = (cid, list) => {
  try { localStorage.setItem(CUSTOM_TOKENS_KEY(cid), JSON.stringify(list)); } catch { /* ignore */ }
};
const buildTokenList = (cid) => {
  const reg = getTokens(cid);
  const custom = loadCustomTokens(cid).filter((c) => !reg.some((r) => sameAddr(r.address, c.address)));
  return [...reg, ...custom];
};
const pickToken = (cid, list) => {
  let want = null;
  try { want = localStorage.getItem(SEL_TOKEN_KEY(cid)); } catch { /* ignore */ }
  return list.find((t) => sameAddr(t.address, want)) || list[0] || null;
};

const EMPTY_BAL = { public: "0", confidential: { available: "0", pending: "0" } };

export function OrgProvider({ children }) {
  const tk = useTurnkey();
  const tkRef = useRef(tk);
  tkRef.current = tk; // always point the signer at the LATEST wallet-kit context (fresh session)

  const [cfg, setCfg] = useState(null);
  const [provider, setProvider] = useState(null);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState(null);

  const [chainId, setChainId] = useState(loadSelectedChainId());
  const [treasury, setTreasury] = useState(null); // {kind,label,subOrgId,address,userId,account,signer,activated,elgamalPriv,sessionExpiresAt,authMethod}
  const [balances, setBalances] = useState(EMPTY_BAL);
  const [nativeBalance, setNativeBalance] = useState("0");
  const [token, setToken] = useState(null);
  const [tokens, setTokens] = useState([]);

  const [org, setOrg] = useState(null);
  const [owner, setOwner] = useState(null);
  const [team, setTeam] = useState([]);
  const [recipients, setRecipients] = useState([]);
  const [txs, setTxs] = useState([]);
  const [analytics, setAnalytics] = useState(null);

  const [toasts, setToasts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [busyDesc, setBusyDesc] = useState("");
  const [now, setNow] = useState(Date.now());

  const provRef = useRef(null);
  const cfgRef = useRef(null);
  const backendCfgRef = useRef(null);
  const vaultRef = useRef(null); // { address, elgamal:{[chainId]:priv} }
  const treasuryRef = useRef(null);
  const tokenRef = useRef(null);
  const lastAuthedSubOrg = useRef(null); // guards one-time backend setup per sign-in
  const walletSetupRef = useRef(null); // guards one-time wallet provisioning per sub-org

  const toast = useCallback((msg, kind = "info") => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 4200);
  }, []);

  // ---- reloads --------------------------------------------------------------
  const reloadOrg = useCallback(async () => {
    const { org, owner } = await api.getOrg();
    setOrg(org);
    setOwner(owner);
  }, []);
  const reloadTeam = useCallback(async () => setTeam(await api.getTeam()), []);
  const reloadRecipients = useCallback(async () => setRecipients(await api.recipients()), []);
  const reloadTxs = useCallback(async () => {
    const raw = await api.getTransactions({ subOrgId: treasuryRef.current?.subOrgId || treasuryRef.current?.address });
    const elg = vaultRef.current?.elgamal || {};
    const dec = await Promise.all(
      raw.map(async (t) => ({
        ...t,
        amount: t.amountEnc ? await decryptAmount(t.amountEnc, elg[t.chainId]) : (t.amount ?? null),
      })),
    );
    setTxs(dec);
  }, []);
  const reloadAnalytics = useCallback(async () => {}, []);

  useEffect(() => { treasuryRef.current = treasury; }, [treasury]);
  useEffect(() => { tokenRef.current = token; }, [token]);
  useEffect(() => { setAnalytics(computeAnalytics(txs)); }, [txs]);

  // ---- vault helpers (ElGamal keys only; session is managed by wallet-kit) ---
  const persistElgamal = useCallback((cid, elgamalPriv) => {
    const address = treasuryRef.current?.address;
    vaultRef.current = {
      ...(vaultRef.current || {}),
      address,
      elgamal: { ...(vaultRef.current?.elgamal || {}), [cid]: elgamalPriv },
    };
    saveVault(vaultRef.current);
  }, []);

  const wipeVault = useCallback(() => {
    vaultRef.current = null;
    clearVault();
  }, []);

  // ---- balances -------------------------------------------------------------
  const refreshBalances = useCallback(async (t = treasuryRef.current, tok = tokenRef.current) => {
    if (!t?.address) return;
    try {
      const [pub, native] = await Promise.all([
        tok ? publicBalance(t.address, tok) : Promise.resolve("0"),
        provRef.current ? provRef.current.getBalance(t.address) : Promise.resolve(0n),
      ]);
      let conf = { available: "0", pending: "0" };
      if (tok && t.activated && t.elgamalPriv) {
        const cb = await confidentialBalance(t.address, t.elgamalPriv, tok);
        conf = { available: cb.available, pending: cb.pending };
      }
      setBalances({ public: pub, confidential: conf });
      setNativeBalance(ethers.formatEther(native || 0n));
    } catch (e) {
      console.warn("balance refresh failed:", e?.message || e);
    }
  }, []);

  // ---- shared treasury builders --------------------------------------------
  const loadElgamalForAddress = useCallback(async (address, cid) => {
    const vault = await loadVault();
    if (vault && sameAddr(vault.address, address)) {
      vaultRef.current = vault;
      return vault.elgamal?.[cid] || null;
    }
    return null;
  }, []);

  const clearTreasuryLocal = useCallback((toastMsg) => {
    saveTreasuryId(null);
    setTreasury(null);
    treasuryRef.current = null;
    lastAuthedSubOrg.current = null;
    wipeVault();
    setBalances(EMPTY_BAL);
    setNativeBalance("0");
    setTxs([]);
    setAnalytics(null);
    setOrg(null);
    setOwner(null);
    if (toastMsg) toast(toastMsg, "muted");
  }, [toast, wipeVault]);

  // ---- boot -----------------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const backendCfg = await loadBackendConfig();
        backendCfgRef.current = backendCfg;
        const cid = loadSelectedChainId();
        const network = getNetwork(cid);
        const c = buildConfig(backendCfg, network);
        cfgRef.current = c;
        setCfg(c);
        setChainId(cid);
        initConfidential(c);
        const tlist = buildTokenList(cid);
        setTokens(tlist);
        const tok0 = pickToken(cid, tlist);
        setToken(tok0);
        tokenRef.current = tok0;
        const prov = new ethers.JsonRpcProvider(c.rpcUrl, c.chainId);
        provRef.current = prov;
        setProvider(prov);

        // Only the self-custody (external) treasury is restored here; embedded (Turnkey)
        // treasuries are derived from the wallet-kit session by the effect below.
        const savedId = loadTreasury();
        if (savedId?.kind === "external") {
          const rc = await reconnectInjected(savedId.address);
          if (rc) {
            const elgamalPriv = await loadElgamalForAddress(rc.address, cid);
            const t = {
              kind: "external",
              label: savedId.label || short(rc.address),
              subOrgId: null,
              userId: null,
              address: rc.address,
              email: savedId.email || null,
              account: null,
              authMethod: "external",
              signer: rc.signer,
              activated: !!elgamalPriv,
              elgamalPriv,
              sessionExpiresAt: null,
            };
            setTreasury(t);
            treasuryRef.current = t;
            refreshBalances(t);
          } else {
            saveTreasuryId(null); // wallet not available/authorized anymore
          }
        }
        await Promise.all([reloadOrg(), reloadTeam(), reloadRecipients(), reloadTxs()]);
        setReady(true);
      } catch (e) {
        setBootError(e.message || String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 1s tick (session countdown)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // ---- derive the embedded (Turnkey) treasury from the wallet-kit session ----
  // Runs whenever auth state / session / wallet / chain changes. External treasuries
  // own the slot exclusively (until disconnected), so we skip while one is active.
  const evmAddress = pickEvmAccount(tk.wallets)?.address || null;

  // TEMP diagnostic — shows what wallet-kit exposes after auth. Remove once stable.
  useEffect(() => {
    console.log("[wk-debug]", {
      clientState: tk.clientState,
      authState: tk.authState,
      hasSession: !!tk.session,
      subOrg: tk.session?.organizationId,
      wallets: (tk.wallets || []).map((w) => ({ source: w?.source, accounts: (w?.accounts || []).map((a) => a?.address) })),
      pickedEvmAddress: evmAddress,
    });
  }, [tk.clientState, tk.authState, tk.session?.token, evmAddress]);

  useEffect(() => {
    if (!provRef.current) return;
    if (treasuryRef.current?.kind === "external") return;

    const authed =
      tk.clientState === ClientState.Ready &&
      tk.authState === AuthState.Authenticated &&
      !!tk.session;

    if (!authed) {
      if (treasuryRef.current?.kind === "turnkey") clearTreasuryLocal(null);
      lastAuthedSubOrg.current = null;
      walletSetupRef.current = null;
      return;
    }

    const subOrgId = tk.session.organizationId;
    const account = pickEvmAccount(tk.wallets);

    // A brand-new embedded sub-org can start with NO wallet (the Auth Proxy doesn't
    // always create one). Provision an Ethereum wallet ONCE; refreshing the wallet
    // state re-runs this effect, and we then build the treasury below.
    if (!account) {
      if (walletSetupRef.current !== subOrgId) {
        walletSetupRef.current = subOrgId;
        (async () => {
          try {
            let ws = await tkRef.current.refreshWallets();
            if (!pickEvmAccount(ws)) {
              await tkRef.current.createWallet({
                walletName: "Treasury Wallet",
                accounts: [
                  { curve: "CURVE_SECP256K1", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/60'/0'/0/0", addressFormat: "ADDRESS_FORMAT_ETHEREUM" },
                ],
              });
              await tkRef.current.refreshWallets();
            }
          } catch (e) {
            walletSetupRef.current = null;
            console.warn("[wk] wallet provisioning failed:", e?.message || e);
            toast(`Couldn't set up the treasury wallet — ${e?.message || "please retry sign-in"}`, "error");
          }
        })();
      }
      return; // wait for the wallet to appear → effect re-runs → build below
    }

    walletSetupRef.current = null;
    const address = getAddress(account.address);
    const userId = tk.session.userId;
    const expiresAt = Number(tk.session.expiry) * 1000;

    (async () => {
      const signer = makeWalletKitSigner(tkRef, account, provRef.current);

      // Same wallet already mounted → just refresh signer + session expiry.
      if (treasuryRef.current?.subOrgId === subOrgId) {
        const t = { ...treasuryRef.current, signer, account, userId, sessionExpiresAt: expiresAt };
        setTreasury(t);
        treasuryRef.current = t;
        return;
      }

      // Fresh sign-in.
      const elgamalPriv = await loadElgamalForAddress(address, chainId);
      const email = tk.user?.userEmail || null;
      const label = email || short(address);
      const t = {
        kind: "turnkey",
        label,
        subOrgId,
        userId,
        address,
        email,
        account,
        authMethod: "turnkey",
        signer,
        activated: !!elgamalPriv,
        elgamalPriv,
        sessionExpiresAt: expiresAt,
      };
      setTreasury(t);
      treasuryRef.current = t;
      saveTreasuryId(t);

      if (lastAuthedSubOrg.current !== subOrgId) {
        lastAuthedSubOrg.current = subOrgId;
        try {
          // Reflect the signed-in account in the sidebar; don't clobber a user-set org name.
          const cur = await api.getOrg();
          await api.setOwner({ name: email || "Treasury owner", email: email || undefined, address });
          if (!cur.org?.name) await api.updateOrg({ name: label });
          await reloadOrg();
        } catch (e) {
          console.warn("owner sync failed:", e?.message || e);
        }
      }
      await Promise.all([refreshBalances(t), reloadTxs()]);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tk.authState, tk.clientState, tk.session?.token, evmAddress, chainId]);

  useEffect(() => {
    if (treasury?.address) refreshBalances(treasury);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treasury?.address, treasury?.activated, chainId]);

  // ---- run helper -----------------------------------------------------------
  const run = useCallback(
    async (desc, fn, { silent = false } = {}) => {
      setBusy(true);
      setBusyDesc(desc);
      try {
        const r = await fn();
        if (!silent) toast(`${desc} ✓`, "ok");
        return r;
      } catch (e) {
        toast(`${desc} ✗ — ${e?.message || e}`, "error");
        console.error(desc, e);
        throw e;
      } finally {
        setBusy(false);
        setBusyDesc("");
      }
    },
    [toast],
  );

  // ---- network switching ----------------------------------------------------
  const switchNetwork = useCallback(
    (newChainId) => {
      const cid = Number(newChainId);
      if (cid === chainId) return;
      const network = getNetwork(cid);
      if (!network) return;
      saveSelectedChainId(cid);
      const c = buildConfig(backendCfgRef.current, network);
      cfgRef.current = c;
      setCfg(c);
      setChainId(cid);
      initConfidential(c);
      const prov = new ethers.JsonRpcProvider(c.rpcUrl, c.chainId);
      provRef.current = prov;
      setProvider(prov);
      const tlist = buildTokenList(cid);
      setTokens(tlist);
      const newTok = pickToken(cid, tlist);
      setToken(newTok);
      tokenRef.current = newTok;
      setTreasury((t) => {
        if (!t) return t;
        const elgamalPriv = vaultRef.current?.elgamal?.[cid] || null;
        let signer = t.signer;
        if (t.kind === "turnkey" && t.account) signer = makeWalletKitSigner(tkRef, t.account, prov);
        const nt = { ...t, signer, activated: !!elgamalPriv, elgamalPriv };
        refreshBalances(nt, newTok);
        if (t.kind === "external") {
          // Rebind the injected wallet to the new chain (may prompt a chain switch).
          (async () => {
            try {
              await ensureInjectedChain(cid, network);
              const rc = await reconnectInjected(t.address);
              if (rc) {
                const n2 = { ...nt, signer: rc.signer };
                setTreasury(n2);
                treasuryRef.current = n2;
              }
            } catch {
              toast(`Switch your wallet to ${network.name}`, "muted");
            }
          })();
        }
        return nt;
      });
      toast(`Switched to ${network.name}`, "info");
    },
    [chainId, refreshBalances, toast],
  );

  // ---- token selection ------------------------------------------------------
  const switchToken = useCallback(
    (address) => {
      const t = tokens.find((x) => sameAddr(x.address, address));
      if (!t) return;
      setToken(t);
      tokenRef.current = t;
      try { localStorage.setItem(SEL_TOKEN_KEY(chainId), t.address); } catch { /* ignore */ }
      refreshBalances(treasuryRef.current, t);
    },
    [tokens, chainId, refreshBalances],
  );

  const addCustomToken = (address) =>
    run(`Add token`, async () => {
      const info = await resolveToken(address);
      if (!info.supported) {
        throw new Error(`${info.symbol} isn't enabled on the confidential contract for this network — ask the team to whitelist it (setTokenConfig).`);
      }
      const entry = { address: info.address, symbol: info.symbol, decimals: info.decimals };
      if (!buildTokenList(chainId).some((t) => sameAddr(t.address, entry.address))) {
        saveCustomTokens(chainId, [...loadCustomTokens(chainId), entry]);
      }
      const list = buildTokenList(chainId);
      setTokens(list);
      setToken(entry);
      tokenRef.current = entry;
      try { localStorage.setItem(SEL_TOKEN_KEY(chainId), entry.address); } catch { /* ignore */ }
      refreshBalances(treasuryRef.current, entry);
      return entry;
    }, { silent: true });

  // ---- auth / treasury lifecycle (wallet-kit) -------------------------------
  // Embedded: open the Auth Proxy modal (email / passkey / Google / external-wallet).
  const connectEmbedded = () =>
    run(`Sign in`, async () => { await tk.handleLogin(); }, { silent: true });

  // Embedded: go straight to Google.
  const connectGoogle = () =>
    run(`Continue with Google`, async () => { await tk.handleGoogleOauth(); }, { silent: true });

  // Self-custody: the user's own wallet (MetaMask) signs directly — no Turnkey.
  const connectWallet = () =>
    run(`Connect wallet`, async () => {
      const network = getNetwork(chainId);
      const { signer, address } = await makeInjectedSigner(chainId, network);
      const elgamalPriv = await loadElgamalForAddress(address, chainId);
      const nm = `Wallet ${short(address)}`;
      const t = {
        kind: "external",
        label: nm,
        subOrgId: null,
        userId: null,
        address,
        email: null,
        account: null,
        authMethod: "external",
        signer,
        activated: !!elgamalPriv,
        elgamalPriv,
        sessionExpiresAt: null,
      };
      setTreasury(t);
      treasuryRef.current = t;
      saveTreasuryId(t);
      try {
        const cur = await api.getOrg();
        await api.setOwner({ name: "Self-custody wallet", address });
        if (!cur.org?.name) await api.updateOrg({ name: nm });
        await reloadOrg();
      } catch (e) {
        console.warn("owner sync failed:", e?.message || e);
      }
      await Promise.all([refreshBalances(t), reloadTxs()]);
      return t;
    });

  // Add THIS device's passkey to the signed-in embedded wallet (one-tap next time).
  const addDevicePasskey = () =>
    run(`Add this device (passkey)`, async () => {
      await tk.handleAddPasskey();
      toast("Passkey added to this device ✓", "ok");
    }, { silent: true });

  // "Create session": embedded → re-open the login modal to mint a fresh session.
  const startSession = () =>
    run(`Create session`, async () => {
      if (treasuryRef.current?.kind === "external") return; // self-custody signs on demand
      await tk.handleLogin();
    }, { silent: true });

  // "End session": embedded → log out of wallet-kit; external → drop the local connection.
  const lock = async () => {
    const wasTurnkey = treasuryRef.current?.kind === "turnkey";
    clearTreasuryLocal("Session ended");
    if (wasTurnkey) { try { await tkRef.current.logout(); } catch { /* ignore */ } }
  };

  const disconnectTreasury = async () => {
    const wasTurnkey = treasuryRef.current?.kind === "turnkey";
    clearTreasuryLocal("Treasury disconnected from this browser");
    if (wasTurnkey) { try { await tkRef.current.logout(); } catch { /* ignore */ } }
  };

  const activateTreasury = () =>
    run(`Derive confidential keys`, async () => {
      const keys = await activateAccount(treasury.signer);
      const t = { ...treasury, activated: true, elgamalPriv: keys.privateKey };
      setTreasury(t);
      treasuryRef.current = t;
      persistElgamal(chainId, keys.privateKey);
      await Promise.all([refreshBalances(t), reloadTxs()]);
    });

  // ---- confidential ops (unchanged — all take treasury.signer) --------------
  const depositToConfidential = (amount) => {
    const tok = tokenRef.current;
    return run(`Deposit ${amount} ${tok?.symbol || ""} → confidential`, async () => {
      const r = await cDeposit(treasury.signer, tok, amount);
      const txHash = r?.hash || r?.transactionHash || null;
      await api.addTransaction(await txRecord({ kind: "deposit", to: treasury.address, recipientLabel: "Treasury (self)", amount, delivery: "confidential", txHash, token: tok }));
      await Promise.all([refreshBalances(treasury, tok), reloadTxs()]);
    });
  };

  const withdrawToPublic = (amount) => {
    const tok = tokenRef.current;
    return run(`Withdraw ${amount} ${tok?.symbol || ""} → public`, async () => {
      const r = await cWithdraw(treasury.signer, tok, amount);
      const txHash = r?.hash || r?.transactionHash || null;
      await api.addTransaction(await txRecord({ kind: "withdraw", to: treasury.address, recipientLabel: "Treasury (self)", amount, delivery: "direct", txHash, token: tok }));
      await Promise.all([refreshBalances(treasury, tok), reloadTxs()]);
    });
  };

  async function txRecord({ kind, status = "completed", to, recipientLabel, amount, delivery, txHash, batchId, note, error, createdBy, createdByRole, token: tok }) {
    const c = cfgRef.current;
    const t = tok || tokenRef.current;
    const elg = treasuryRef.current?.elgamalPriv || vaultRef.current?.elgamal?.[c?.chainId];
    return {
      subOrgId: treasuryRef.current?.subOrgId || treasuryRef.current?.address || null,
      kind,
      status,
      to,
      recipientLabel: recipientLabel ?? null,
      amount: null,
      amountEnc: await encryptAmount(amount, elg),
      tokenSymbol: t?.symbol || null,
      token: t?.address || null,
      delivery,
      network: c?.networkName || null,
      chainId: c?.chainId || null,
      txHash: txHash ?? null,
      explorerUrl: txHash ? explorerTx(c?.chainId, txHash) : null,
      batchId: batchId ?? null,
      note: note ?? null,
      error: error ?? null,
      ...(createdBy ? { createdBy } : {}),
      ...(createdByRole ? { createdByRole } : {}),
    };
  }

  async function executeOnChain({ recipient, amount, delivery, token: tok }) {
    const t = tok || tokenRef.current;
    if (delivery === "direct") {
      const rc = await payDirect(treasury.signer, recipient, t, amount);
      return rc?.hash || rc?.transactionHash || null;
    }
    const r = await confidentialTransfer(treasury.signer, recipient, t, amount);
    return r?.hash || r?.transactionHash || null;
  }

  const payNow = ({ recipient, amount, delivery, recipientLabel, note }) => {
    const tok = tokenRef.current;
    return run(`Pay ${amount} ${tok?.symbol || ""} → ${recipientLabel || recipient.slice(0, 8)}`, async () => {
      if (delivery === "confidential") {
        const ok = await isActivated(recipient);
        if (!ok) throw new Error("recipient has no confidential account — use Direct-to-wallet, or have them onboard first");
      }
      const txHash = await executeOnChain({ recipient, amount, delivery, token: tok });
      const rec = await api.addTransaction(await txRecord({ kind: "payout", to: recipient, recipientLabel, amount, delivery, txHash, note, token: tok }));
      await Promise.all([refreshBalances(treasury, tok), reloadTxs()]);
      return rec;
    });
  };

  const requestPayout = ({ recipient, amount, delivery, recipientLabel, note, createdBy, createdByRole }) =>
    run(`Submit payout for approval`, async () => {
      const rec = await api.addTransaction(
        await txRecord({ kind: "payout", status: "pending", to: recipient, recipientLabel, amount, delivery, note, token: tokenRef.current, createdBy: createdBy || "Member", createdByRole: createdByRole || "member" }),
      );
      await reloadTxs();
      return rec;
    });

  const approvePayout = (tx) =>
    run(`Approve & pay ${tx.amount} ${tx.tokenSymbol} → ${tx.recipientLabel || tx.to?.slice(0, 8)}`, async () => {
      const tok = tokens.find((t) => sameAddr(t.address, tx.token)) || tokenRef.current;
      if (tx.delivery === "confidential") {
        const ok = await isActivated(tx.to);
        if (!ok) throw new Error("recipient has no confidential account");
      }
      let txHash = null;
      try {
        txHash = await executeOnChain({ recipient: tx.to, amount: tx.amount, delivery: tx.delivery, token: tok });
      } catch (e) {
        await api.patchTransaction(tx.id, { status: "failed", error: e.message });
        await reloadTxs();
        throw e;
      }
      await api.patchTransaction(tx.id, {
        status: "completed",
        txHash,
        explorerUrl: explorerTx(cfgRef.current?.chainId, txHash),
        approvedBy: owner?.name || "Owner",
        approvedAt: new Date().toISOString(),
      });
      await Promise.all([refreshBalances(treasury), reloadTxs()]);
    });

  const rejectPayout = (tx) =>
    run(`Reject payout`, async () => {
      await api.patchTransaction(tx.id, { status: "failed", error: "rejected by approver" });
      await reloadTxs();
    });

  const runBatch = async (rows, delivery, onProgress) => {
    const batchId = `batch_${Date.now().toString(36)}`;
    const results = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const tok = row.token || tokenRef.current;
      try {
        if (delivery === "confidential") {
          const ok = await isActivated(row.address);
          if (!ok) throw new Error("no confidential account");
        }
        const txHash = await executeOnChain({ recipient: row.address, amount: row.amount, delivery, token: tok });
        await api.addTransaction(await txRecord({ kind: "payout", to: row.address, recipientLabel: row.label || null, amount: row.amount, delivery, txHash, batchId, token: tok }));
        results.push({ ...row, status: "completed", txHash });
        onProgress?.(i, row, { status: "completed", txHash });
      } catch (e) {
        await api.addTransaction(await txRecord({ kind: "payout", status: "failed", to: row.address, recipientLabel: row.label || null, amount: row.amount, delivery, batchId, error: e.message, token: tok }));
        results.push({ ...row, status: "failed", error: e.message });
        onProgress?.(i, row, { status: "failed", error: e.message });
      }
    }
    await Promise.all([refreshBalances(treasury), reloadTxs()]);
    return { batchId, results };
  };

  // ---- recipients address book ---------------------------------------------
  const addRecipient = (label, address) =>
    run(`Add recipient`, async () => {
      const rec = await api.addRecipient(label, address);
      await reloadRecipients();
      return rec;
    }, { silent: true });

  const removeRecipient = (id) =>
    run(`Remove recipient`, async () => {
      await api.removeRecipient(id);
      await reloadRecipients();
    }, { silent: true });

  const isExternal = treasury?.kind === "external";
  const sessionActive = treasury
    ? isExternal
      ? true
      : tk.authState === AuthState.Authenticated && !!treasury.sessionExpiresAt && treasury.sessionExpiresAt > now
    : false;

  const value = {
    cfg,
    provider,
    ready,
    bootError,
    chainId,
    network: cfg?.network || null,
    networks: networkList(),
    treasury,
    balances,
    nativeBalance,
    org,
    owner,
    team,
    recipients,
    txs,
    analytics,
    toasts,
    busy,
    busyDesc,
    now,
    sessionSeconds: SESSION_SECONDS,
    token,
    tokens,
    symbol: token?.symbol || cfg?.tokenSymbol || "USDC",
    tokenDecimals: token?.decimals ?? cfg?.tokenDecimals ?? 6,
    nativeSymbol: cfg?.network?.nativeSymbol || "ETH",
    sessionActive,
    isExternal,
    // actions
    toast,
    switchNetwork,
    switchToken,
    addCustomToken,
    connectEmbedded,
    connectGoogle,
    connectWallet,
    connectTreasury: connectEmbedded, // back-compat alias
    addDevicePasskey,
    disconnectTreasury,
    startSession,
    lock,
    activateTreasury,
    depositToConfidential,
    withdrawToPublic,
    payNow,
    requestPayout,
    approvePayout,
    rejectPayout,
    runBatch,
    addRecipient,
    removeRecipient,
    refreshBalances,
    isActivated,
    // reloads
    reloadOrg,
    reloadTeam,
    reloadRecipients,
    reloadTxs,
    reloadAnalytics,
  };

  return <OrgCtx.Provider value={value}>{children}</OrgCtx.Provider>;
}
