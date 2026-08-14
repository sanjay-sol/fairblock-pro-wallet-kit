import { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import { ethers } from "ethers";
import { loadBackendConfig, buildConfig, supportedNetworks } from "../config.js";
import { networkList, getNetwork, loadSelectedChainId, saveSelectedChainId, explorerTx, DEFAULT_CHAIN_ID } from "../networks.js";
import { api, setApiContext } from "../lib/api.js";
import { newTargetKey, establishSession, restoreSession, clearSession, sessionActive, getSession, patchSession } from "../lib/session.js";
import { makeConsensusSigner, takeLastPending, approveActivity as tkApprove, setNonceOverride, clearNonceOverride } from "../signers.js";
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
const tokenOf = (n) => ({ address: n.tokenAddress, symbol: n.tokenSymbol, decimals: n.tokenDecimals });

// Map low-level Turnkey/session/db errors to friendly, actionable messages (task 2).
function friendlyError(e) {
  const m = String(e?.message || e || "");
  if (/allotted quota|signing is disabled/i.test(m)) return "Turnkey signing credits are exhausted for this workspace — it needs more credits before anyone can sign again.";
  if (/resource_exhausted|quota exceeded/i.test(m)) return "The database hit its daily free-tier quota — switch the backend to in-memory or wait for the quota to reset.";
  if (/SIGNATURE_MISSING|session|expired|unauthorized|\b401\b|credential/i.test(m)) return "Your session expired — please sign in again.";
  return m;
}

export function OrgProvider({ children }) {
  const [cfg, setCfg] = useState(null);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState(null);

  const [chainId, setChainId] = useState(DEFAULT_CHAIN_ID);
  const [networks, setNetworks] = useState([]);

  const [treasury, setTreasury] = useState(null); // { subOrgId, address, name, role, threshold, memberCount, activated, elgamalPriv, signer }
  const [members, setMembers] = useState([]);
  const [balances, setBalances] = useState(EMPTY_BAL);
  const [nativeBalance, setNativeBalance] = useState("0");
  const [payouts, setPayouts] = useState([]);
  const [recipients, setRecipients] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  // A batch run lives HERE (not in the BatchPayout page) so it survives navigation: the
  // loop keeps going + progress is preserved even if you leave and come back (task 2).
  const [activeBatch, setActiveBatch] = useState(null); // { id, delivery, willPropose, rows[], progress{i}, running, done, startedAt }

  const [toasts, setToasts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [busyDesc, setBusyDesc] = useState("");
  const [now, setNow] = useState(Date.now());

  const provRef = useRef(null);
  const cfgRef = useRef(null);
  const backendCfgRef = useRef(null);
  const tokenRef = useRef(null);
  const treasuryRef = useRef(null);
  const vaultRef = useRef(null);     // { address, elgamal: { [chainId]: priv } } — per-chain keys
  const settledRef = useRef(null);   // count of settled payouts last seen → detect new settlements
  const activeBatchRef = useRef(null); // mirror of activeBatch for the fire-and-forget batch loop
  const treasurySyncRef = useRef(0);   // last time we re-read the treasury (throttles team/threshold sync)
  const kickedRef = useRef(false);     // set when the API says we're no longer a member → force logout

  useEffect(() => { treasuryRef.current = treasury; }, [treasury]);
  useEffect(() => { activeBatchRef.current = activeBatch; }, [activeBatch]);

  const toast = useCallback((msg, kind = "info") => {
    // Defensive: only ever render a string. A stray object (e.g. a click event
    // accidentally passed in as the message) would throw in React and blank the app.
    const text = typeof msg === "string" ? msg : (msg && typeof msg.message === "string" ? msg.message : String(msg ?? ""));
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((t) => [...t, { id, msg: text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 4200);
  }, []);

  const run = useCallback(async (desc, fn, { silent = false } = {}) => {
    setBusy(true); setBusyDesc(desc);
    try { const r = await fn(); if (!silent) toast(`${desc} ✓`, "ok"); return r; }
    catch (e) { toast(`${desc} ✗ — ${friendlyError(e)}`, "error"); console.error(desc, e); throw e; }
    finally { setBusy(false); setBusyDesc(""); }
  }, [toast]);

  // ── balances (always read from the CURRENTLY selected chain via the refs) ──
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
    try {
      const t = await api.getTreasury();
      setMembers(t.members || []);
      // Only produce a new treasury object when a field actually changed — otherwise the 20s
      // team-sync would churn a re-render (and reset the poll interval) on every tick.
      setTreasury((cur) => {
        if (!cur) return cur;
        if (cur.name === t.name && cur.threshold === t.threshold && cur.role === t.role && cur.memberCount === t.memberCount) return cur;
        return { ...cur, name: t.name, threshold: t.threshold, role: t.role, memberCount: t.memberCount };
      });
    } catch (e) { if (/not a member/i.test(String(e?.message || ""))) kickedRef.current = true; console.warn("reloadTreasury:", e?.message || e); }
  }, []);
  const reloadRecipients = useCallback(async () => {
    try { setRecipients(await api.recipients()); } catch (e) { console.warn("reloadRecipients:", e?.message || e); }
  }, []);
  // Decrypt each payout's amount with the key of the chain it was CREATED on (keys are
  // per-chain). When a payout settles (poll picks it up), auto-refresh balances (task 3).
  const reloadPayouts = useCallback(async () => {
    try {
      const raw = await api.listPayouts();
      const curCid = cfgRef.current?.chainId;
      const keyFor = (p) => vaultRef.current?.elgamal?.[p.chainId ?? curCid] || (p.chainId == null || p.chainId === curCid ? treasuryRef.current?.elgamalPriv : null);
      const dec = await Promise.all(raw.map(async (p) => {
        const k = keyFor(p);
        return { ...p, amount: p.amountEnc && k ? await decryptAmount(p.amountEnc, k).catch(() => null) : null };
      }));
      setPayouts(dec);
      setAnalytics(computeAnalytics(dec.filter((p) => p.status === "completed")));
      const settled = dec.filter((p) => p.status === "completed" || p.status === "submitted").length;
      if (settledRef.current != null && settled > settledRef.current) refreshBalances();
      settledRef.current = settled;
    } catch (e) { if (/not a member/i.test(String(e?.message || ""))) kickedRef.current = true; console.warn("reloadPayouts:", e?.message || e); }
  }, [refreshBalances]);

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
    const t = { subOrgId: sess.subOrgId, address: sess.address, name: sess.name, role: sess.role, threshold: sess.threshold, memberCount: sess.memberCount, activated: !!elgamalPriv, elgamalPriv, signer };
    setTreasury(t); treasuryRef.current = t;
    settledRef.current = null;
    await Promise.all([reloadTreasury(), reloadRecipients(), reloadPayouts(), refreshBalances(t)]);
    return t;
  }, [loadElgamal, reloadTreasury, reloadRecipients, reloadPayouts, refreshBalances]);

  // ── boot ──
  useEffect(() => {
    (async () => {
      try {
        const backendCfg = await loadBackendConfig();
        backendCfgRef.current = backendCfg;
        const nets = supportedNetworks(backendCfg, networkList());
        setNetworks(nets);
        const saved = loadSelectedChainId();
        const cid = nets.some((n) => n.chainId === saved) ? saved : (backendCfg.defaultChainId || DEFAULT_CHAIN_ID);
        const network = getNetwork(cid);
        const c = buildConfig(backendCfg, network);
        cfgRef.current = c; setCfg(c); setChainId(cid);
        initConfidential(c);
        tokenRef.current = tokenOf(network);
        provRef.current = new ethers.JsonRpcProvider(c.rpcUrl, c.chainId);
        const sess = restoreSession();
        if (sess) await mountTreasury(sess);
        setReady(true);
      } catch (e) { setBootError(e?.message || String(e)); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  // Re-read the treasury (threshold, team, name, role) at most once per 20s. The owner sees
  // their own threshold change instantly, but OTHER admins only had it at mount — so without
  // this they'd keep a stale "N-of-M" until a full page reload (task 3). Throttled to stay
  // light on DB reads. `force` (on tab re-focus / first poll) bypasses the throttle.
  const syncTeam = useCallback((force = false) => {
    const t = Date.now();
    if (!force && t - treasurySyncRef.current < 20000) return;
    treasurySyncRef.current = t;
    reloadTreasury();
  }, [reloadTreasury]);

  // Poll pending payouts so the consensus view + auto-execute + balance refresh stay live.
  // Read-reduction: SKIP polling while the tab is hidden (huge saver for backgrounded tabs),
  // poll fast only while something is pending, and slowly when idle. Refresh once on re-focus.
  useEffect(() => {
    if (!treasury) return;
    const hasPending = payouts.some((p) => p.status === "pending" || p.status === "submitted");
    const interval = hasPending ? 6000 : 45000;
    const id = setInterval(() => { if (treasuryRef.current && !document.hidden) { reloadPayouts(); syncTeam(); } }, interval);
    const onVis = () => { if (!document.hidden && treasuryRef.current) { reloadPayouts(); syncTeam(true); } };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [treasury, payouts, reloadPayouts, syncTeam]);

  // ── auth ──
  const createTreasury = ({ name, ownerEmail, ownerName, threshold }) =>
    run(`Create organisation`, async () => { await api.createTreasury({ name, ownerEmail, ownerName, threshold: Number(threshold) || 1 }); return { ownerEmail }; }, { silent: true });

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
        subOrgId: v.subOrgId, address: v.address, email: v.email, role: v.role, name: v.name, threshold: v.threshold, memberCount: v.memberCount,
        chainId: v.chainId, baseUrl: cfgRef.current.turnkeyBaseUrl,
      });
      await mountTreasury(sess);
      return sess;
    }, { silent: true });

  const mountFromAuth = async (v, ephemeralPrivateKey) => {
    const sess = establishSession({
      credentialBundle: v.credentialBundle, ephemeralPrivateKey,
      subOrgId: v.subOrgId, address: v.address, email: v.email, role: v.role, name: v.name, threshold: v.threshold, memberCount: v.memberCount,
      chainId: v.chainId, baseUrl: cfgRef.current.turnkeyBaseUrl,
    });
    await mountTreasury(sess);
    return sess;
  };

  // Google sign-in: identical to completeOtp downstream. If the account has NO org yet the backend
  // returns { needsOnboarding, email } (not an error) — we surface that so Onboard can collect just
  // an org name + owner name (no email re-entry) and finish via createOrgWithGoogle.
  const completeGoogle = ({ oidcToken, targetPublicKey, ephemeralPrivateKey }) =>
    run(`Sign in with Google`, async () => {
      const v = await api.authOauth({ oidcToken, targetPublicKey });
      if (v.needsOnboarding) return { needsOnboarding: true, email: v.email };
      await mountFromAuth(v, ephemeralPrivateKey);
      return { signedIn: true };
    }, { silent: true });

  // Create a new org for a Google-verified user (reuses the SAME token + target key from the button).
  const createOrgWithGoogle = ({ oidcToken, targetPublicKey, ephemeralPrivateKey, orgName, ownerName }) =>
    run(`Create organisation`, async () => {
      const v = await api.authOauthCreate({ oidcToken, targetPublicKey, orgName, ownerName });
      await mountFromAuth(v, ephemeralPrivateKey);
      return { signedIn: true };
    }, { silent: true });

  const logout = useCallback((reason) => {
    // `reason` is only a message when we call logout() ourselves (e.g. session expiry).
    // When wired straight to onClick it arrives as a DOM event — ignore anything non-string.
    const msg = typeof reason === "string" ? reason : null;
    clearSession(); setApiContext({ subOrgId: null, email: null });
    clearVault();
    setTreasury(null); treasuryRef.current = null; vaultRef.current = null; settledRef.current = null;
    setActiveBatch(null); activeBatchRef.current = null;
    setBalances(EMPTY_BAL); setNativeBalance("0"); setPayouts([]); setRecipients([]); setMembers([]); setAnalytics(null);
    toast(msg || "Signed out", msg ? "error" : "muted");
  }, [toast]);

  // Session-expiry watchdog: when the OTP session lapses, wipe stale state + prompt re-auth
  // (avoids a lingering dashboard showing a dead session's numbers — task 2).
  useEffect(() => {
    if (!treasury) return;
    if (kickedRef.current) { kickedRef.current = false; logout("You were removed from this treasury"); return; }
    const s = getSession();
    if (s && s.expiry <= now) logout("Session expired — please sign in again");
  }, [now, treasury, logout]);

  // ── network switching (task 5) ──
  const switchNetwork = useCallback((newChainId) => {
    const cid = Number(newChainId);
    if (cid === cfgRef.current?.chainId) return;
    // Switching swaps the signer/provider/SDK under any in-flight work — don't do it mid-batch.
    if (activeBatchRef.current?.running) { toast("Finish the running batch before switching networks", "error"); return; }
    const network = getNetwork(cid);
    if (!network || !backendCfgRef.current) return;
    saveSelectedChainId(cid);
    const c = buildConfig(backendCfgRef.current, network);
    cfgRef.current = c; setCfg(c); setChainId(cid);
    initConfidential(c);
    provRef.current = new ethers.JsonRpcProvider(c.rpcUrl, c.chainId);
    tokenRef.current = tokenOf(network);
    const t0 = treasuryRef.current;
    if (t0) {
      const elg = vaultRef.current?.elgamal?.[cid] || null;
      const t = { ...t0, activated: !!elg, elgamalPriv: elg, signer: makeConsensusSigner(provRef.current) };
      setTreasury(t); treasuryRef.current = t;
      settledRef.current = null;
      Promise.all([refreshBalances(t), reloadPayouts()]).catch(() => {});
    }
    toast(`Switched to ${network.name}`, "info");
  }, [refreshBalances, reloadPayouts, toast]);

  // ── activation (derive ElGamal key for the CURRENT chain; registers on-chain, 1-of-M) ──
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
  async function recordPayout({ kind, recipient, recipientLabel, amount, delivery, note, nonce, batchId }, outcome) {
    const tok = tokenRef.current;
    const cid = cfgRef.current.chainId;
    const amountEnc = await encryptAmount(amount, treasuryRef.current.elgamalPriv);
    const base = { kind, recipient, recipientLabel: recipientLabel || null, amountEnc, tokenSymbol: tok.symbol, token: tok.address, delivery, note: note || null, nonce: nonce ?? null, batchId: batchId ?? null, chainId: cid };
    if (outcome.pending) return api.proposePayout({ ...base, activityId: outcome.activityId, fingerprint: outcome.fingerprint });
    return api.proposePayout({ ...base, status: "completed", txHash: outcome.txHash, explorerUrl: explorerTx(cid, outcome.txHash) });
  }

  const proposePayout = ({ recipient, amount, delivery = "confidential", recipientLabel, note }) =>
    run(`Pay ${amount} ${tokenRef.current?.symbol || ""}`, async () => {
      const cid = cfgRef.current.chainId;
      if (activeBatchRef.current?.running) throw new Error("A batch payout is still running — let it finish before starting another payout (they'd fight over transaction nonces).");
      if (delivery === "direct" && (treasuryRef.current?.threshold || 1) > 1) throw new Error("Direct-to-wallet isn't supported under multi-sig yet (it needs 2 txns) — use Confidential Settlement.");
      if (delivery === "confidential") { const ok = await isActivated(recipient); if (!ok) throw new Error("recipient has no confidential account — ask them to onboard first"); }
      const { base } = await api.nonce(1, cid); // reserve this payout's nonce on this chain
      let txHash = null, pending = null;
      setNonceOverride(base);
      try { txHash = await executeOnChain({ recipient, amount, delivery }); }
      catch (e) { pending = takeLastPending(); if (!pending) throw e; }
      finally { clearNonceOverride(); }
      const kind = delivery === "direct" ? "withdraw" : "transfer";
      if (pending) { await recordPayout({ kind, recipient, recipientLabel, amount, delivery, note, nonce: base }, { pending: true, ...pending }); await reloadPayouts(); return { pending: true }; }
      await recordPayout({ kind, recipient, recipientLabel, amount, delivery, note, nonce: base }, { txHash });
      await Promise.all([refreshBalances(), reloadPayouts()]);
      return { completed: true, txHash };
    }, { silent: true });

  // Batch: propose (or, at threshold 1, send) K payouts with CONSECUTIVE nonces on this chain.
  // A failed/skipped row does NOT consume its nonce (so the executor queue never gaps).
  //
  // The run is OWNED BY CONTEXT (not the BatchPayout page): we snapshot it into `activeBatch`
  // and drive a fire-and-forget loop that writes progress back into that state. This means the
  // batch keeps running — and its progress stays visible — even if the user navigates away and
  // back mid-run (task 2). Every row's outcome (completed / proposed / failed) is recorded, so
  // nothing silently disappears.
  const setRowProgress = (i, res) => setActiveBatch((b) => (b ? { ...b, progress: { ...b.progress, [i]: res } } : b));

  const startBatch = (inputRows, delivery) => {
    if (activeBatchRef.current?.running) return; // one batch at a time
    const rows = inputRows.map((r) => ({ address: r.address, amount: r.amount, label: r.label || null }));
    const willPropose = (treasuryRef.current?.threshold || 1) > 1;
    const id = `batch_${Date.now().toString(36)}`;
    const snapshot = { id, delivery, willPropose, rows, progress: {}, running: true, done: false, startedAt: Date.now() };
    setActiveBatch(snapshot); activeBatchRef.current = snapshot;

    // Fire-and-forget: not awaited by any component, so unmounting BatchPayout can't stop it.
    (async () => {
      const cid = cfgRef.current.chainId;
      try {
        const { base } = await api.nonce(rows.length, cid);
        let nextNonce = base;
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          setRowProgress(i, { status: "running" });
          try {
            if (delivery === "direct" && willPropose) throw new Error("Direct-to-wallet isn't supported under multi-sig yet — use Confidential");
            if (delivery === "confidential") { const ok = await isActivated(row.address); if (!ok) throw new Error("recipient has no confidential account"); }
            let txHash = null, pending = null;
            setNonceOverride(nextNonce);
            try { txHash = await executeOnChain({ recipient: row.address, amount: row.amount, delivery }); }
            catch (e) { pending = takeLastPending(); if (!pending) throw e; }
            finally { clearNonceOverride(); }
            await recordPayout({ kind: delivery === "direct" ? "withdraw" : "transfer", recipient: row.address, recipientLabel: row.label || null, amount: row.amount, delivery, nonce: nextNonce, batchId: id }, pending ? { pending: true, ...pending } : { txHash });
            setRowProgress(i, { status: pending ? "proposed" : "completed", txHash });
            nextNonce++; // only advance on a recorded payout — failures reuse the nonce (no gap)
          } catch (e) {
            setRowProgress(i, { status: "failed", error: friendlyError(e) });
          }
        }
      } catch (e) {
        // Reservation / setup failure before the loop — surface it and mark the batch done.
        toast(`Batch could not start — ${friendlyError(e)}`, "error");
      } finally {
        setActiveBatch((b) => (b && b.id === id ? { ...b, running: false, done: true } : b));
        await Promise.all([refreshBalances(), reloadPayouts()]).catch(() => {});
      }
    })();
  };

  // Clear a FINISHED batch from the dashboard (guarded: never wipe a run in progress).
  const clearBatch = () => { if (!activeBatchRef.current?.running) { setActiveBatch(null); activeBatchRef.current = null; } };

  const approveBatch = (payoutsToApprove) =>
    run(`Approve ${payoutsToApprove.length} payout${payoutsToApprove.length === 1 ? "" : "s"}`, async () => {
      const targets = payoutsToApprove.filter((p) => p.activityId && p.status === "pending");
      const res = await Promise.allSettled(targets.map((p) => tkApprove(p.activityId)));
      await reloadPayouts();
      const failed = res.filter((r) => r.status === "rejected").length;
      if (failed) throw new Error(`${failed} of ${targets.length} approvals failed — tap again to retry the rest`);
    }, { silent: true });

  // Deposit is a SINGLE 1-of-M call: any admin can fund the pool. We first ask the backend to
  // ensure the USDC→diamond allowance (root-signed), then the deposit signs+completes at 1-of-M
  // via the FUND policy — no co-signing needed. Payouts still require full N-of-M.
  const depositToConfidential = (amount) =>
    run(`Deposit ${amount} ${tokenRef.current?.symbol || ""} → confidential`, async () => {
      const tok = tokenRef.current;
      const cid = cfgRef.current.chainId;
      if (activeBatchRef.current?.running) throw new Error("A batch payout is still running — let it finish before depositing (they'd fight over transaction nonces).");
      await api.ensureAllowance(cid);          // backend-root sets the allowance if needed
      const { base } = await api.nonce(1, cid); // reserve a nonce (won't collide with pending payouts)
      let txHash = null, pending = null;
      setNonceOverride(base);
      try { const r = await cDeposit(treasury.signer, tok, amount); txHash = r?.hash || r?.transactionHash || null; }
      catch (e) { pending = takeLastPending(); if (!pending) throw e; }
      finally { clearNonceOverride(); }
      if (pending) { await recordPayout({ kind: "deposit", recipient: treasury.address, recipientLabel: "Treasury (self)", amount, delivery: "confidential", nonce: base }, { pending: true, ...pending }); await reloadPayouts(); return { pending: true }; }
      await recordPayout({ kind: "deposit", recipient: treasury.address, recipientLabel: "Treasury (self)", amount, delivery: "confidential", nonce: base }, { txHash });
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
  const activeSigners = members.filter((m) => m.status === "active").length;
  const signerCount = Math.max(activeSigners, treasury?.memberCount || 0);
  const network = cfg ? { name: cfg.networkName, shortName: cfg.shortName, chainId: cfg.chainId } : null;
  const value = {
    cfg, ready, bootError, now,
    chainId, networks, network, switchNetwork,
    treasury, members, signerCount, role: treasury?.role || null, threshold: treasury?.threshold || 1,
    authed: sessionActive(), session: getSession(),
    balances, nativeBalance, payouts, recipients, analytics, activeBatch,
    token, symbol: token?.symbol || "USDC", tokenDecimals: token?.decimals ?? 6, nativeSymbol: cfg?.nativeSymbol || "ETH",
    toasts, busy, busyDesc, toast,
    // auth
    createTreasury, beginOtp, completeOtp, completeGoogle, createOrgWithGoogle, logout,
    // treasury ops
    activateTreasury, refreshBalances, depositToConfidential, proposePayout, startBatch, clearBatch, approveBatch, approvePayout, rejectPayout,
    // members
    addMember, removeMember, setThreshold, saveName, addRecipient, removeRecipient, isActivated,
    // reloads
    reloadTreasury, reloadPayouts, reloadRecipients,
  };
  return <OrgCtx.Provider value={value}>{children}</OrgCtx.Provider>;
}
