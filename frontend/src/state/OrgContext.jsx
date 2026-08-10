import { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import { ethers } from "ethers";
import { loadBackendConfig, buildConfig, explorerTx } from "../config.js";
import { api, setApiContext } from "../lib/api.js";
import { newTargetKey, establishSession, restoreSession, clearSession, sessionActive, getSession, patchSession } from "../lib/session.js";
import { makeConsensusSigner, takeLastPending, approveActivity as tkApprove } from "../signers.js";
import { saveVault, loadVault, clearVault } from "../vault.js";
import { encryptAmount, decryptAmount } from "../metaCrypto.js";
import { computeAnalytics } from "../lib/analytics.js";
import {
  initConfidential, activateAccount, deposit as cDeposit, confidentialTransfer,
  withdraw as cWithdraw, payDirect, publicBalance, confidentialBalance, isActivated,
} from "../confidential.js";

const OrgCtx = createContext(null);
export const useOrg = () => useContext(OrgCtx);
const EMPTY_BAL = { public: "0", confidential: { available: "0", pending: "0" } };
const sameAddr = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function OrgProvider({ children }) {
  const [cfg, setCfg] = useState(null);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState(null);

  const [treasury, setTreasury] = useState(null); // { subOrgId, address, name, role, threshold, activated, elgamalPriv, signer }
  const [members, setMembers] = useState([]);
  const [balances, setBalances] = useState(EMPTY_BAL);
  const [nativeBalance, setNativeBalance] = useState("0");
  const [payouts, setPayouts] = useState([]);
  const [recipients, setRecipients] = useState([]);
  const [analytics, setAnalytics] = useState(null);

  const [toasts, setToasts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [busyDesc, setBusyDesc] = useState("");
  const [now, setNow] = useState(Date.now());

  const provRef = useRef(null);
  const cfgRef = useRef(null);
  const tokenRef = useRef(null);
  const treasuryRef = useRef(null);
  const vaultRef = useRef(null); // { address, elgamal: { [chainId]: priv } }

  useEffect(() => { treasuryRef.current = treasury; }, [treasury]);

  const toast = useCallback((msg, kind = "info") => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 4200);
  }, []);

  const run = useCallback(async (desc, fn, { silent = false } = {}) => {
    setBusy(true); setBusyDesc(desc);
    try { const r = await fn(); if (!silent) toast(`${desc} ✓`, "ok"); return r; }
    catch (e) { toast(`${desc} ✗ — ${e?.message || e}`, "error"); console.error(desc, e); throw e; }
    finally { setBusy(false); setBusyDesc(""); }
  }, [toast]);

  // ── balances ──
  const refreshBalances = useCallback(async (t = treasuryRef.current) => {
    if (!t?.address) return;
    const tok = tokenRef.current;
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
    } catch (e) { console.warn("balance refresh:", e?.message || e); }
  }, []);

  // ── reloads ──
  const reloadTreasury = useCallback(async () => {
    try { const t = await api.getTreasury(); setMembers(t.members || []); setTreasury((cur) => cur ? { ...cur, name: t.name, threshold: t.threshold, role: t.role } : cur); }
    catch (e) { console.warn("reloadTreasury:", e?.message || e); }
  }, []);
  const reloadRecipients = useCallback(async () => {
    try { setRecipients(await api.recipients()); } catch (e) { console.warn("reloadRecipients:", e?.message || e); }
  }, []);
  const reloadPayouts = useCallback(async () => {
    try {
      const raw = await api.listPayouts();
      const elg = treasuryRef.current?.elgamalPriv;
      const cid = cfgRef.current?.chainId;
      const dec = await Promise.all(raw.map(async (p) => ({
        ...p,
        amount: p.amountEnc && elg ? await decryptAmount(p.amountEnc, elg) : null,
      })));
      setPayouts(dec);
      setAnalytics(computeAnalytics(dec.filter((p) => p.status === "completed")));
    } catch (e) { console.warn("reloadPayouts:", e?.message || e); }
  }, []);

  const loadElgamal = useCallback(async (address, cid) => {
    const vault = await loadVault();
    if (vault && sameAddr(vault.address, address)) { vaultRef.current = vault; return vault.elgamal?.[cid] || null; }
    return null;
  }, []);

  // Build the treasury object from a fresh session (after OTP verify or a restore).
  const mountTreasury = useCallback(async (sess) => {
    setApiContext({ subOrgId: sess.subOrgId, email: sess.email });
    const cid = cfgRef.current?.chainId;
    const elgamalPriv = await loadElgamal(sess.address, cid);
    const signer = makeConsensusSigner(provRef.current);
    const t = { subOrgId: sess.subOrgId, address: sess.address, name: sess.name, role: sess.role, threshold: sess.threshold, activated: !!elgamalPriv, elgamalPriv, signer };
    setTreasury(t); treasuryRef.current = t;
    await Promise.all([reloadTreasury(), reloadRecipients(), reloadPayouts(), refreshBalances(t)]);
    return t;
  }, [loadElgamal, reloadTreasury, reloadRecipients, reloadPayouts, refreshBalances]);

  // ── boot ──
  useEffect(() => {
    (async () => {
      try {
        const backendCfg = await loadBackendConfig();
        const c = buildConfig(backendCfg);
        cfgRef.current = c; setCfg(c);
        initConfidential(c);
        const tok = { address: c.tokenAddress, symbol: c.tokenSymbol, decimals: c.tokenDecimals };
        tokenRef.current = tok;
        provRef.current = new ethers.JsonRpcProvider(c.rpcUrl, c.chainId);
        const sess = restoreSession();
        if (sess) await mountTreasury(sess);
        setReady(true);
      } catch (e) { setBootError(e?.message || String(e)); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  // Poll pending payouts so the consensus view + auto-execute stay live.
  useEffect(() => {
    if (!treasury) return;
    const hasPending = payouts.some((p) => p.status === "pending");
    const id = setInterval(() => { if (treasuryRef.current) reloadPayouts(); }, hasPending ? 5000 : 20000);
    return () => clearInterval(id);
  }, [treasury, payouts, reloadPayouts]);

  // ── auth ──
  const createTreasury = ({ name, ownerEmail, ownerName, threshold }) =>
    run(`Create treasury`, async () => { await api.createTreasury({ name, ownerEmail, ownerName, threshold: Number(threshold) || 1 }); return { ownerEmail }; }, { silent: true });

  const beginOtp = (email) =>
    run(`Email a sign-in code`, async () => {
      const { targetPublicKey, ephemeralPrivateKey } = newTargetKey();
      const { otpId } = await api.authInit(email);
      return { email: email.toLowerCase(), otpId, targetPublicKey, ephemeralPrivateKey };
    }, { silent: true });

  const completeOtp = (pending, code) =>
    run(`Sign in`, async () => {
      const v = await api.authVerify({ email: pending.email, otpId: pending.otpId, otpCode: String(code).trim(), targetPublicKey: pending.targetPublicKey });
      const sess = establishSession({
        credentialBundle: v.credentialBundle, ephemeralPrivateKey: pending.ephemeralPrivateKey,
        subOrgId: v.subOrgId, address: v.address, email: v.email, role: v.role, name: v.name, threshold: v.threshold,
        chainId: v.chainId, baseUrl: cfgRef.current.turnkeyBaseUrl,
      });
      await mountTreasury(sess);
      return sess;
    }, { silent: true });

  const logout = useCallback(() => {
    clearSession(); setApiContext({ subOrgId: null, email: null });
    clearVault(); // don't leave one admin's derived key for the next login on this browser
    setTreasury(null); treasuryRef.current = null; vaultRef.current = null;
    setBalances(EMPTY_BAL); setNativeBalance("0"); setPayouts([]); setRecipients([]); setMembers([]); setAnalytics(null);
    toast("Signed out", "muted");
  }, [toast]);

  // ── activation (derive ElGamal key; registers on-chain if first time) ──
  const activateTreasury = () =>
    run(`Derive confidential keys`, async () => {
      const keys = await activateAccount(treasury.signer);
      const cid = cfgRef.current.chainId;
      vaultRef.current = { address: treasury.address, elgamal: { ...(vaultRef.current?.elgamal || {}), [cid]: keys.privateKey } };
      saveVault(vaultRef.current);
      const t = { ...treasury, activated: true, elgamalPriv: keys.privateKey };
      setTreasury(t); treasuryRef.current = t;
      await Promise.all([refreshBalances(t), reloadPayouts()]);
    });

  const executeOnChain = async ({ recipient, amount, delivery }) => {
    const tok = tokenRef.current;
    if (delivery === "direct") { const rc = await payDirect(treasury.signer, recipient, tok, amount); return rc?.hash || rc?.transactionHash || null; }
    const r = await confidentialTransfer(treasury.signer, recipient, tok, amount);
    return r?.hash || r?.transactionHash || null;
  };

  // Record a payout: solo (threshold 1 → completed synchronously) or pending (needs approvals).
  async function recordPayout({ kind, recipient, recipientLabel, amount, delivery, note }, outcome) {
    const tok = tokenRef.current;
    const amountEnc = await encryptAmount(amount, treasuryRef.current.elgamalPriv);
    const base = { kind, recipient, recipientLabel: recipientLabel || null, amountEnc, tokenSymbol: tok.symbol, token: tok.address, delivery, note: note || null };
    if (outcome.pending) return api.proposePayout({ ...base, activityId: outcome.activityId, fingerprint: outcome.fingerprint });
    return api.proposePayout({ ...base, status: "completed", txHash: outcome.txHash, explorerUrl: explorerTx(outcome.txHash) });
  }

  const proposePayout = ({ recipient, amount, delivery = "confidential", recipientLabel, note }) =>
    run(`Pay ${amount} ${tokenRef.current?.symbol || ""}`, async () => {
      if (delivery === "confidential") { const ok = await isActivated(recipient); if (!ok) throw new Error("recipient has no confidential account — ask them to onboard, or use Direct-to-wallet"); }
      let txHash = null, pending = null;
      try { txHash = await executeOnChain({ recipient, amount, delivery }); }
      catch (e) { pending = takeLastPending(); if (!pending) throw e; }
      const kind = delivery === "direct" ? "withdraw" : "transfer";
      if (pending) { await recordPayout({ kind, recipient, recipientLabel, amount, delivery, note }, { pending: true, ...pending }); await reloadPayouts(); return { pending: true }; }
      await recordPayout({ kind, recipient, recipientLabel, amount, delivery, note }, { txHash });
      await Promise.all([refreshBalances(), reloadPayouts()]);
      return { completed: true, txHash };
    }, { silent: true });

  const depositToConfidential = (amount) =>
    run(`Deposit ${amount} ${tokenRef.current?.symbol || ""} → confidential`, async () => {
      const tok = tokenRef.current;
      let txHash = null, pending = null;
      try { const r = await cDeposit(treasury.signer, tok, amount); txHash = r?.hash || r?.transactionHash || null; }
      catch (e) { pending = takeLastPending(); if (!pending) throw e; }
      if (pending) { await recordPayout({ kind: "deposit", recipient: treasury.address, recipientLabel: "Treasury (self)", amount, delivery: "confidential" }, { pending: true, ...pending }); await reloadPayouts(); return { pending: true }; }
      await recordPayout({ kind: "deposit", recipient: treasury.address, recipientLabel: "Treasury (self)", amount, delivery: "confidential" }, { txHash });
      await Promise.all([refreshBalances(), reloadPayouts()]);
      return { completed: true };
    });

  const approvePayout = (p) =>
    run(`Approve payout`, async () => {
      if (!p.activityId) throw new Error("this payout has no Turnkey activity to approve");
      await tkApprove(p.activityId);
      await reloadPayouts(); // enrichment broadcasts + settles once the threshold is met
    }, { silent: true });

  const rejectPayout = (p) => run(`Reject payout`, async () => { await api.rejectPayout(p.id); await reloadPayouts(); }, { silent: true });

  // ── members / threshold / recipients ──
  const addMember = ({ email, name }) => run(`Invite member`, async () => { const r = await api.addMember({ email, name }); await reloadTreasury(); return r; }, { silent: true });
  const removeMember = (email) => run(`Remove member`, async () => { await api.removeMember(email); await reloadTreasury(); }, { silent: true });
  const setThreshold = (n) => run(`Set approval threshold`, async () => { await api.setThreshold(n); await reloadTreasury(); const t = { ...treasuryRef.current, threshold: n }; setTreasury(t); treasuryRef.current = t; patchSession({ threshold: n }); }, { silent: true });
  const addRecipient = (label, address) => run(`Add recipient`, async () => { const r = await api.addRecipient(label, address); await reloadRecipients(); return r; }, { silent: true });
  const removeRecipient = (id) => run(`Remove recipient`, async () => { await api.removeRecipient(id); await reloadRecipients(); }, { silent: true });
  const saveName = (name) => run(`Save`, async () => { await api.updateTreasury({ name }); await reloadTreasury(); }, { silent: true });

  const token = tokenRef.current;
  const value = {
    cfg, ready, bootError, now,
    treasury, members, role: treasury?.role || null, threshold: treasury?.threshold || 1,
    authed: sessionActive(), session: getSession(),
    balances, nativeBalance, payouts, recipients, analytics,
    token, symbol: token?.symbol || "USDC", tokenDecimals: token?.decimals ?? 6, nativeSymbol: cfg?.nativeSymbol || "ETH",
    network: cfg ? { name: cfg.networkName, shortName: "Base", chainId: cfg.chainId } : null,
    toasts, busy, busyDesc, toast,
    // auth
    createTreasury, beginOtp, completeOtp, logout,
    // treasury ops
    activateTreasury, refreshBalances, depositToConfidential, proposePayout, approvePayout, rejectPayout,
    // members
    addMember, removeMember, setThreshold, saveName, addRecipient, removeRecipient, isActivated,
    // reloads
    reloadTreasury, reloadPayouts, reloadRecipients,
  };
  return <OrgCtx.Provider value={value}>{children}</OrgCtx.Provider>;
}
