import { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import { ethers } from "ethers";
import { loadBackendConfig, buildConfig, supportedNetworks } from "../config.js";
import { networkList, getNetwork, getTokens, loadSelectedChainId, saveSelectedChainId, explorerTx, DEFAULT_CHAIN_ID } from "../networks.js";
import { api, setApiContext, setAuthErrorHandler } from "../lib/api.js";
import { newTargetKey, establishSession, restoreSession, clearSession, sessionActive, getSession, patchSession } from "../lib/session.js";
import { makeConsensusSigner, takeLastPending, approveActivity as tkApprove, setNonceOverride, clearNonceOverride, makeRootProxySigner, setBatchSignContext, clearBatchSignContext, setRowSigner } from "../signers.js";
import { saveVault, loadVault, clearVault } from "../vault.js";
import { encryptAmount, decryptAmount } from "../metaCrypto.js";
import { computeAnalytics } from "../lib/analytics.js";
import {
  initConfidential, activateAccount, deposit as cDeposit, confidentialTransfer,
  withdraw as cWithdraw, payDirect, publicBalance, confidentialBalance, isActivated, pendingActionOf, resolveToken,
} from "../confidential.js";

const OrgCtx = createContext(null);
export const useOrg = () => useContext(OrgCtx);
const EMPTY_BAL = { public: "0", confidential: { available: "0", pending: "0" } };
const sameAddr = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const tokenOf = (n) => ({ address: n.tokenAddress, symbol: n.tokenSymbol, decimals: n.tokenDecimals });

// ── multi-token: per-chain selected token + user-added custom tokens ──
// The confidential diamond CANNOT enumerate its whitelisted tokens (plain mapping,
// no event, no getter), so the offered list = the chain's registry tokens
// (networks.js getTokens) + any the user adds by address, each validated on-chain via
// resolveToken → isSupportedToken. The selection is persisted per chain.
const CUSTOM_TOKENS_KEY = (cid) => `fbp-tokens-${cid}`;
const SEL_TOKEN_KEY = (cid) => `fbp-seltoken-${cid}`;
const loadCustomTokens = (cid) => { try { return JSON.parse(localStorage.getItem(CUSTOM_TOKENS_KEY(cid)) || "[]"); } catch { return []; } };
const saveCustomTokens = (cid, list) => { try { localStorage.setItem(CUSTOM_TOKENS_KEY(cid), JSON.stringify(list)); } catch { /* ignore */ } };
const buildTokenList = (cid) => {
  const reg = getTokens(cid);
  const custom = loadCustomTokens(cid).filter((c) => !reg.some((r) => sameAddr(r.address, c.address)));
  return [...reg, ...custom];
};
const pickToken = (cid, list) => {
  let sel = null;
  try { sel = localStorage.getItem(SEL_TOKEN_KEY(cid)); } catch { /* ignore */ }
  return list.find((t) => sameAddr(t.address, sel)) || list[0] || null;
};

// Map low-level Turnkey/session/db errors to friendly, actionable messages (task 2).
function friendlyError(e) {
  const m = String(e?.message || e || "");
  if (/allotted quota|signing is disabled/i.test(m)) return "Turnkey signing credits are exhausted for this workspace — it needs more credits before anyone can sign again.";
  if (/resource_exhausted|quota exceeded/i.test(m)) return "The database hit its daily free-tier quota — switch the backend to in-memory or wait for the quota to reset.";
  // NONCE checks come FIRST — otherwise "NONCE_EXPIRED" matches /expired/ in the session rule below and
  // gets mislabeled "Your session expired" (that was a real bug in the screenshots).
  if (/nonce has already been used|nonce too low|already known|NONCE_EXPIRED|replacement transaction underpriced/i.test(m)) return "A previous transaction is still settling on-chain — wait a few seconds, then try again.";
  if (/execution reverted|CALL_EXCEPTION/i.test(m)) return "The transaction was rejected on-chain — refresh your balances and try again.";
  if (/failed to post request|net::ERR_FAILED|access-control|\bCORS\b/i.test(m)) return "The confidential relayer couldn't be reached — its backend (Stabletrust SDK) is blocking this origin. That's a backend/infra fix, not something the app can resolve.";
  // Rate limiting: the backend's specific 429 message (e.g. "wait a few minutes") passes through
  // as `m`; this only catches an opaque 429 (body couldn't be parsed → "path → 429").
  if (/RATE_LIMITED|\b429\b/i.test(m)) return "You're going too fast - please wait a moment, then try again.";
  // Session rule intentionally omits a bare `expired` (that caught NONCE_EXPIRED above).
  if (/SIGNATURE_MISSING|\bsession\b|unauthorized|\b401\b|invalid.{0,4}credential/i.test(m)) return "Your session expired — please sign in again.";
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
  const [token, setToken] = useState(null);   // selected confidential token { address, symbol, decimals }
  const [tokens, setTokens] = useState([]);    // tokens offered on the current chain (registry + custom)
  const [payouts, setPayouts] = useState([]);
  const [recipients, setRecipients] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  // A batch run lives HERE (not in the BatchPayout page) so it survives navigation: the
  // loop keeps going + progress is preserved even if you leave and come back (task 2).
  const [activeBatch, setActiveBatch] = useState(null); // { id, delivery, willPropose, rows[], progress{i}, running, done, startedAt }
  const [appBatches, setAppBatches] = useState([]); // app-approval N-of-M batches (list) — drives the approvals UI
  // A single payout also lives HERE so it survives navigation (task: same fix as the batch). The
  // send keeps running + its result (sent / proposed / failed) stays visible on return (task 2).
  const [activeSend, setActiveSend] = useState(null); // { id, recipient, amount, delivery, willPropose, status, txHash, error }
  // Deposit / confidential transfer / claim all CONFIRM at their tx receipt (~5-10s) but only SETTLE
  // ~30-60s later (keyshare finalization). While settling we (a) show a "settling" state and (b) BLOCK
  // new ops — the account has a live pendingAction and the next op's balance-proof would be built
  // against a stale balance. ONE unified settling state covers deposit + transfer + claim.
  const [settling, setSettling] = useState(null); // { kind, amountLabel, txHash, chainId, snap:{available,pending}, startedAt } | null

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
  const reloadBatchesRef = useRef(null); // stable handle to reloadBatches (called from the poll + handlers)
  const executingAppRef = useRef(false); // true while an app-approval batch is executing (one at a time)
  const activeSendRef = useRef(null);  // mirror of activeSend for the fire-and-forget single send
  const treasurySyncRef = useRef(0);   // last time we re-read the treasury (throttles team/threshold sync)
  const kickedRef = useRef(false);     // set when the API says we're no longer a member → force logout
  const balanceWatchRef = useRef(null); // { timer, until } — polls balances through the ~30-60s confidential finalization so a just-"completed" op isn't shown with a stale balance
  const lastPendingRef = useRef(null);  // { chainId, pending } — detect INCOMING confidential transfers (pending increased) → log a "received" history row
  const lastLocalOpRef = useRef(0);     // ts of our last local balance-moving op — suppress false "received" right after our own deposit
  const reloadPayoutsRef = useRef(null); // stable handle to reloadPayouts (called from the memoized refreshBalances without a dep cycle)
  const settlingRef = useRef(null);      // mirror of `settling` — read by op guards to block a new op while one is finalizing
  const balancesRef = useRef(EMPTY_BAL); // mirror of `balances` — snapshot the pre-settle balance without a stale closure

  useEffect(() => { treasuryRef.current = treasury; }, [treasury]);
  useEffect(() => { activeBatchRef.current = activeBatch; }, [activeBatch]);
  useEffect(() => { activeSendRef.current = activeSend; }, [activeSend]);
  useEffect(() => { settlingRef.current = settling; }, [settling]);
  useEffect(() => { balancesRef.current = balances; }, [balances]);

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
      let incoming = null; // { delta, cid } — an INCOMING confidential transfer just detected
      if (tok && t.activated && t.elgamalPriv) {
        const cb = await confidentialBalance(t.address, t.elgamalPriv, tok);
        conf = { available: cb.available, pending: cb.pending };
        // Incoming confidential transfers land in `pending`. When pending increases (same chain,
        // and NOT right after one of our own ops), it's money someone sent us → log a "received"
        // history row. Deposits go to `available` (not pending) + our ops stamp lastLocalOpRef, so
        // this won't misfire. Update the ref synchronously (before the async record) to prevent a
        // concurrent refresh double-logging the same increase.
        const cid = cfgRef.current?.chainId;
        const pend = Number(conf.pending || 0);
        const prev = lastPendingRef.current;
        lastPendingRef.current = { chainId: cid, token: tok.address, pending: pend };
        if (prev && prev.chainId === cid && sameAddr(prev.token, tok.address) && pend > prev.pending + 1e-6 && Date.now() - lastLocalOpRef.current > 20000) {
          incoming = { delta: pend - prev.pending, cid };
        }
      } else {
        lastPendingRef.current = null;
      }
      setBalances({ public: pub, confidential: conf });
      setNativeBalance(ethers.formatEther(native || 0n));
      if (incoming) { // fire-and-forget so it never delays the balance UI
        const delta = incoming.delta.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
        encryptAmount(delta, t.elgamalPriv)
          .then((amountEnc) => api.proposePayout({ kind: "received", recipient: t.address, recipientLabel: "Incoming transfer", amountEnc, tokenSymbol: tok.symbol, token: tok.address, delivery: "confidential", note: null, nonce: null, batchId: null, chainId: incoming.cid, status: "completed", txHash: null, explorerUrl: null }))
          .then(() => reloadPayoutsRef.current?.())
          .catch((e) => console.warn("record received:", e?.message || e));
      }
    } catch (e) { console.warn("balance refresh:", e?.message || e); }
  }, []);

  // After an op settles, the confidential balance only reflects once the keyshare network
  // finalizes (~30-60s AFTER the tx shows "completed"/"submitted") — a single refresh fires too
  // early and leaves a stale balance until a manual Refresh. So poll balances every 7s for ~90s
  // (extending the window if another op lands); the balance catches up on its own. Also used after
  // a Claim to reflect the pending→available move. Self-terminates; one watcher at a time.
  const watchBalances = useCallback((windowMs = 90000) => {
    const until = Date.now() + windowMs;
    if (balanceWatchRef.current) { balanceWatchRef.current.until = Math.max(balanceWatchRef.current.until, until); return; }
    balanceWatchRef.current = {
      until,
      timer: setInterval(() => {
        refreshBalances();
        if (!balanceWatchRef.current || Date.now() >= balanceWatchRef.current.until) {
          if (balanceWatchRef.current) clearInterval(balanceWatchRef.current.timer);
          balanceWatchRef.current = null;
        }
      }, 7000),
    };
  }, [refreshBalances]);

  // Enter the "settling" phase after an op is CONFIRMED at its receipt: snapshot the pre-finalization
  // balance, poll balances through the ~30-60s keyshare finalization, and (via the effect below) clear
  // as soon as the balance moves. Ops are BLOCKED while this is set. amountLabel/txHash drive the UI.
  const beginSettling = (kind, amountLabel, txHash) => {
    const snap = {
      kind, amountLabel: amountLabel != null ? String(amountLabel) : null, txHash: txHash || null,
      chainId: cfgRef.current?.chainId,
      snap: { available: balancesRef.current?.confidential?.available ?? "0", pending: balancesRef.current?.confidential?.pending ?? "0" },
      startedAt: Date.now(),
    };
    setSettling(snap); settlingRef.current = snap;
    watchBalances(105000); // keep polling balances a touch past the safety-clear window
    setTimeout(() => setSettling((s) => (s && s.startedAt === snap.startedAt ? null : s)), 110000); // safety clear if the balance never visibly moves
  };

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
      // A newly-settled payout shows "completed" on its receipt, but the confidential balance only
      // moves ~30-60s later (keyshare finalization). Watch balances across that window instead of a
      // single (too-early) refresh — otherwise the balance looks stuck until a manual Refresh.
      if (settledRef.current != null && settled > settledRef.current) watchBalances();
      settledRef.current = settled;
    } catch (e) { if (/not a member/i.test(String(e?.message || ""))) kickedRef.current = true; console.warn("reloadPayouts:", e?.message || e); }
  }, [watchBalances]);
  useEffect(() => { reloadPayoutsRef.current = reloadPayouts; }, [reloadPayouts]);

  const loadElgamal = useCallback(async (address, cid) => {
    const vault = await loadVault();
    if (vault && sameAddr(vault.address, address)) { vaultRef.current = vault; return vault.elgamal?.[cid] || null; }
    return null;
  }, []);

  // Build the treasury object from a fresh session (after OTP verify or a restore).
  const mountTreasury = useCallback(async (sess) => {
    setApiContext({ subOrgId: sess.subOrgId, email: sess.email, token: sess.token });
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
        const btl = buildTokenList(cid);
        setTokens(btl);
        const btok = pickToken(cid, btl);
        tokenRef.current = btok; setToken(btok);
        provRef.current = new ethers.JsonRpcProvider(c.rpcUrl, c.chainId);
        const sess = restoreSession();
        if (sess) await mountTreasury(sess);
        setReady(true);
      } catch (e) { setBootError(e?.message || String(e)); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The RootProxySigner hands each unsigned batch row here → the backend root-signs it (Option A).
  // signBatchRow resolves to { signedTx, txHash }; the signer needs the signed-tx HEX STRING.
  useEffect(() => { setRowSigner(async (unsignedTx, batchId, rowIndex) => (await api.signBatchRow(batchId, { unsignedTx, rowIndex })).signedTx); }, []);

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
    const hasPending = payouts.some((p) => p.status === "pending" || p.status === "submitted")
      || appBatches.some((x) => ["pending_approval", "approved", "executing"].includes(x.status));
    const interval = hasPending ? 6000 : 45000;
    // Also refresh balances on each tick so unclaimed `pending` (incoming transfers) surfaces on
    // the dashboard + gets a "received" history row within ~45s idle — not only after an op.
    const id = setInterval(() => { if (treasuryRef.current && !document.hidden) { reloadPayouts(); reloadBatchesRef.current?.(); syncTeam(); refreshBalances(); } }, interval);
    const onVis = () => { if (!document.hidden && treasuryRef.current) { reloadPayouts(); reloadBatchesRef.current?.(); syncTeam(true); refreshBalances(); } };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [treasury, payouts, appBatches, reloadPayouts, syncTeam, refreshBalances]);

  // Clear the settling state once the balance reflects OUR op: `available` changed (deposit ↑ / transfer ↓
  // / claim ↑) OR `pending` DECREASED (claim applied / transfer's pre-apply). We deliberately do NOT clear
  // on a `pending` INCREASE — that's an INCOMING transfer from someone else, not our op finalizing, and
  // clearing on it would lift the op-block while our pendingAction is still live. Safety timeout in
  // beginSettling covers the rare case where the balance read never visibly moves.
  useEffect(() => {
    if (!settling) return;
    const a = Number(balances.confidential.available || 0), p = Number(balances.confidential.pending || 0);
    const sa = Number(settling.snap.available || 0), sp = Number(settling.snap.pending || 0), eps = 1e-9;
    if (Math.abs(a - sa) > eps || p < sp - eps) setSettling(null);
  }, [balances, settling]);

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
        chainId: v.chainId, token: v.token, baseUrl: cfgRef.current.turnkeyBaseUrl,
      });
      await mountTreasury(sess);
      return sess;
    }, { silent: true });

  const mountFromAuth = async (v, ephemeralPrivateKey) => {
    const sess = establishSession({
      credentialBundle: v.credentialBundle, ephemeralPrivateKey,
      subOrgId: v.subOrgId, address: v.address, email: v.email, role: v.role, name: v.name, threshold: v.threshold, memberCount: v.memberCount,
      chainId: v.chainId, token: v.token, baseUrl: cfgRef.current.turnkeyBaseUrl,
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
    clearSession(); setApiContext({ subOrgId: null, email: null, token: null });
    clearVault();
    setTreasury(null); treasuryRef.current = null; vaultRef.current = null; settledRef.current = null;
    setActiveBatch(null); activeBatchRef.current = null;
    setActiveSend(null); activeSendRef.current = null;
    setBalances(EMPTY_BAL); setNativeBalance("0"); setPayouts([]); setRecipients([]); setMembers([]); setAnalytics(null);
    toast(msg || "Signed out", msg ? "error" : "muted");
  }, [toast]);

  // Session-expiry watchdog: when the OTP session lapses, wipe stale state + prompt re-auth
  // (avoids a lingering dashboard showing a dead session's numbers — task 2).
  useEffect(() => {
    if (!treasury) return;
    if (kickedRef.current) { kickedRef.current = false; logout("You were removed from this treasury"); return; }
    const s = getSession();
    if (s && s.expiry <= now) logout("Session expired - please sign in again");
  }, [now, treasury, logout]);

  // A 401 from any API call (token missing / expired / invalid on the server) → sign out cleanly.
  // Guarded by treasuryRef so a 401 DURING sign-in (e.g. a wrong OTP code) can't force a logout —
  // it only fires once we're actually mounted into a treasury.
  useEffect(() => {
    setAuthErrorHandler(() => { if (treasuryRef.current) logout("Your session expired — please sign in again"); });
    return () => setAuthErrorHandler(null);
  }, [logout]);

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
    const ntl = buildTokenList(cid);
    setTokens(ntl);
    const ntok = pickToken(cid, ntl);
    tokenRef.current = ntok; setToken(ntok);
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

  // ── multi-token selection ──
  const switchToken = useCallback((address) => {
    const cid = cfgRef.current?.chainId;
    const tok = (tokens || []).find((t) => sameAddr(t.address, address));
    if (!tok || !cid) return;
    try { localStorage.setItem(SEL_TOKEN_KEY(cid), tok.address); } catch { /* ignore */ }
    tokenRef.current = tok; setToken(tok);
    refreshBalances();
  }, [tokens, refreshBalances]);

  // Add a whitelisted token by address: resolveToken validates it's supported on THIS
  // chain's diamond (rejects otherwise), then persist + select it. This is how the app
  // surfaces tokens beyond the default — the contract has no way to list them itself.
  const addCustomToken = (address) =>
    run(`Add token`, async () => {
      const cid = cfgRef.current?.chainId;
      const info = await resolveToken(address); // { address, symbol, decimals, supported }
      if (!info.supported) throw new Error(`${info.symbol} isn't whitelisted on this chain's confidential contract — ask the admin to enable it first.`);
      const entry = { address: info.address, symbol: info.symbol, decimals: info.decimals };
      const reg = getTokens(cid);
      if (!reg.some((r) => sameAddr(r.address, entry.address))) {
        const custom = loadCustomTokens(cid);
        if (!custom.some((c) => sameAddr(c.address, entry.address))) saveCustomTokens(cid, [...custom, entry]);
      }
      const list = buildTokenList(cid);
      setTokens(list);
      try { localStorage.setItem(SEL_TOKEN_KEY(cid), entry.address); } catch { /* ignore */ }
      tokenRef.current = entry; setToken(entry);
      refreshBalances();
      return entry;
    }, { silent: true });

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

  // waitForFinalization=false lets a SINGLE confidential transfer resolve at its receipt (confirmed) and
  // settle in the background. BATCH rows MUST keep it true: each row's ZK proof is built against the
  // current balance, so row N+1 can't be built until row N finalizes (else the proof is stale/invalid).
  const executeOnChain = async ({ recipient, amount, delivery }, waitForFinalization = true) => {
    const tok = tokenRef.current;
    if (delivery === "direct") { const rc = await payDirect(treasury.signer, recipient, tok, amount); return rc?.hash || rc?.transactionHash || null; }
    const r = await confidentialTransfer(treasury.signer, recipient, tok, amount, waitForFinalization);
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
      if (settlingRef.current) throw new Error("A previous operation is still settling onchain - wait for it to finalize, then try again.");
      if (activeBatchRef.current?.running) throw new Error("A batch payout is still running - let it finish before starting another payout.");
      if (delivery === "direct" && (treasuryRef.current?.threshold || 1) > 1) throw new Error("Direct-to-wallet isn't supported under multi-sig yet (it needs 2 txns) - use Confidential Settlement.");
      if (delivery === "confidential") { const ok = await isActivated(recipient); if (!ok) throw new Error("recipient has no confidential account - ask them to onboard first"); }
      lastLocalOpRef.current = Date.now();
      const { base } = await api.nonce(1, cid); // reserve this payout's nonce on this chain
      let txHash = null, pending = null;
      // NONCE OVERRIDE ONLY FOR MULTI-SIG. At 1-of-M the SDK's confidentialTransfer/withdraw runs its own
      // applyPending() tx FIRST (when pending>0) then the transfer — forcing our single reserved nonce onto
      // BOTH makes them collide ("nonce already used"). At 1-of-M we DON'T force it: the SDK auto-sequences
      // via getTransactionCount (applyPending=N, transfer=N+1), which also makes auto-claim-on-next-op work.
      // Multi-sig co-signed txs aren't broadcast until approval, so they still NEED forced consecutive nonces.
      if ((treasuryRef.current?.threshold || 1) > 1) setNonceOverride(base);
      // A 1-of-M confidential transfer resolves at its RECEIPT (waitForFinalization:false) → "confirmed"
      // now, settles in the background. N-of-M throws PENDING_CONSENSUS before broadcast; direct keeps the
      // full wait (withdraw + public ERC20 transfer, no confidential settling phase).
      try { txHash = await executeOnChain({ recipient, amount, delivery }, delivery !== "confidential"); }
      catch (e) { pending = takeLastPending(); if (!pending) throw e; }
      finally { clearNonceOverride(); }
      const kind = delivery === "direct" ? "withdraw" : "transfer";
      if (pending) { await recordPayout({ kind, recipient, recipientLabel, amount, delivery, note, nonce: base }, { pending: true, ...pending }); await reloadPayouts(); return { pending: true }; }
      await recordPayout({ kind, recipient, recipientLabel, amount, delivery, note, nonce: base }, { txHash });
      if (delivery === "confidential") beginSettling("transfer", amount, txHash); // confirmed @ receipt; finalizes in bg
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

  // Wait until a co-signed batch row has been APPROVED to threshold, broadcast, and FINALIZED
  // on-chain — i.e. the treasury's `pendingAction` has cleared and its new balance is written.
  // That's the precondition for the NEXT row: its proof is bound to the current balance, and the
  // next transfer must pass the contract's one-pending-action `gate`. We drive the backend executor
  // by polling `/api/payouts` (which captures the signed tx on approval, then broadcasts + finalizes)
  // and then gate on the EXACT on-chain signal the contract checks (`pendingActionOf`).
  const BATCH_ROW_TIMEOUT = 30 * 60 * 1000; // 30 min — co-signers may take a while to approve
  async function waitForBatchRowSettled(payoutId) {
    const addr = treasuryRef.current?.address;
    const deadline = Date.now() + BATCH_ROW_TIMEOUT;
    for (;;) {
      if (!activeBatchRef.current?.running) throw new Error("batch stopped");
      if (Date.now() > deadline) throw new Error("timed out waiting for approvals — approve the remaining payouts, then run the rest again");
      // GET /api/payouts drives the backend (capture signed tx on approval → broadcast → finalize)
      // and returns the fresh list so we can read this row's status.
      const list = await api.listPayouts().catch(() => null);
      const p = list?.find((x) => x.id === payoutId);
      if (p) {
        if (p.status === "rejected") throw new Error("a co-signer rejected this payout");
        if (p.status === "failed") throw new Error(p.error || "payout reverted on-chain");
        if (p.status === "completed") {
          // "completed" = the transfer got a success receipt, but the keyshare callback that clears
          // pendingAction + writes the new sender balance lands ~30-60s LATER. The next row's proof
          // needs that cleared state, so wait for the exact on-chain gate to open (fail closed).
          const stillPending = await pendingActionOf(addr).catch(() => true);
          if (!stillPending) { await refreshBalances(); return; }
        }
      }
      await new Promise((r) => setTimeout(r, 3500));
    }
  }

  // ── APP-APPROVAL N-of-M BATCH (Option A) ─────────────────────────────────────
  // The N-of-M batch is approved at the APP layer (our DB + session tokens), then executed
  // "1-of-M underneath": once approvals reach the threshold, the PROPOSER's client builds each
  // row's proof (its ElGamal key stays client-side) and the backend ROOT key signs the row (via
  // /api/batches/:id/sign-row, which only ever signs an approved transferConfidential). Rows settle
  // serially (each waits for on-chain finalization before the next). Runs from OrgContext so it
  // survives navigation, and resumes from the record after a reload.

  // Execute an approved app-batch serially. Guarded so only ONE runs, and only on the batch's chain.
  const executeAppBatch = useCallback((snap) => {
    if (!snap || snap.kind !== "app" || snap.done) return;
    if (executingAppRef.current) return;
    if (cfgRef.current?.chainId !== snap.chainId) return; // only the proposer, on the batch's chain
    executingAppRef.current = true;
    const mark = (i, res) => setActiveBatch((b) => (b && b.id === snap.id ? { ...b, progress: { ...b.progress, [i]: res } } : b));
    setActiveBatch((b) => (b && b.id === snap.id ? { ...b, running: true } : b));
    if (activeBatchRef.current?.id === snap.id) activeBatchRef.current = { ...activeBatchRef.current, running: true };
    (async () => {
      let anyFail = false;
      try {
        for (let i = 0; i < snap.rows.length; i++) {
          if (snap.progress?.[i]?.status === "completed") continue; // resume: skip already-settled rows
          const row = snap.rows[i];
          mark(i, { status: "running" });
          try {
            if (snap.delivery === "confidential") { const ok = await isActivated(row.address); if (!ok) throw new Error("recipient has no confidential account"); }
            setBatchSignContext({ batchId: snap.id, rowIndex: i });
            const signer = makeRootProxySigner(provRef.current);
            const r = await confidentialTransfer(signer, row.address, snap.token, row.amount, true); // waitForFinalization → serial
            const txHash = r?.hash || r?.transactionHash || null;
            mark(i, { status: "completed", txHash });
            await api.batchProgress(snap.id, { rowIndex: i, status: "completed", txHash }).catch(() => {});
          } catch (e) {
            anyFail = true;
            mark(i, { status: "failed", error: friendlyError(e) });
            await api.batchProgress(snap.id, { rowIndex: i, status: "failed", error: String(e?.message || e).slice(0, 180) }).catch(() => {});
            break; // abort the rest — each row's proof is bound to the balance the prior row left
          } finally { clearBatchSignContext(); }
        }
      } finally {
        setActiveBatch((b) => (b && b.id === snap.id ? { ...b, running: false, done: true } : b));
        if (activeBatchRef.current?.id === snap.id) activeBatchRef.current = { ...activeBatchRef.current, running: false, done: true };
        executingAppRef.current = false;
        await api.batchProgress(snap.id, { done: true, failed: anyFail }).catch(() => {});
        await Promise.all([refreshBalances(), reloadPayouts()]).catch(() => {});
      }
    })();
  }, [refreshBalances, reloadPayouts]);

  const maybeExecuteAppBatch = useCallback(() => {
    const b = activeBatchRef.current;
    if (b && b.kind === "app" && b.status === "approved" && !b.done && !b.running) executeAppBatch(b);
  }, [executeAppBatch]);

  // Poll app-batches: refresh the approvals list, sync the proposer's active batch, kick execution
  // once approved, and resume an approved/executing batch this admin proposed but lost (e.g. reload).
  const reloadBatches = useCallback(async () => {
    try {
      const list = await api.listBatches();
      // Decrypt each row's amount with the key of the chain it was created on (like reloadPayouts),
      // so the approvals UI can show what's being approved. Amounts stay ciphertext on the wire.
      const keyFor = (bt) => vaultRef.current?.elgamal?.[bt.chainId] || (Number(bt.chainId) === cfgRef.current?.chainId ? treasuryRef.current?.elgamalPriv : null);
      const dec = await Promise.all(list.map(async (bt) => {
        const k = keyFor(bt);
        return { ...bt, rows: await Promise.all((bt.rows || []).map(async (r) => ({ ...r, amount: r.amountEnc && k ? await decryptAmount(r.amountEnc, k).catch(() => null) : null }))) };
      }));
      setAppBatches(dec);
      const mine = (getSession()?.email || "").toLowerCase();
      const b = activeBatchRef.current;
      if (b && b.kind === "app") {
        const rec = list.find((x) => x.id === b.id);
        if (rec && (rec.status !== b.status || (rec.approvals || []).length !== (b.approvals || []).length)) {
          // Functional patch so a concurrent row-progress update is never clobbered; mirror into the ref
          // (which already carries the latest progress) so maybeExecuteAppBatch sees the fresh status now.
          setActiveBatch((cur) => (cur && cur.id === b.id ? { ...cur, status: rec.status, approvals: rec.approvals || [], done: cur.done || rec.status === "rejected" } : cur));
          if (activeBatchRef.current?.id === b.id) activeBatchRef.current = { ...activeBatchRef.current, status: rec.status, approvals: rec.approvals || [], done: activeBatchRef.current.done || rec.status === "rejected" };
        }
        maybeExecuteAppBatch();
      } else if (!b && treasuryRef.current?.elgamalPriv) {
        const resumable = list.find((x) => String(x.createdBy || "").toLowerCase() === mine
          && ["approved", "executing"].includes(x.status)
          && Number(x.chainId) === cfgRef.current?.chainId
          && (x.rows || []).some((_, i) => (x.rowProgress || {})[i]?.status !== "completed"));
        if (resumable) {
          const rows = await Promise.all((resumable.rows || []).map(async (r) => ({ address: r.recipient, label: r.recipientLabel, amount: await decryptAmount(r.amountEnc, treasuryRef.current.elgamalPriv).catch(() => null) })));
          if (rows.every((r) => r.amount != null)) {
            const snap = { id: resumable.id, kind: "app", delivery: resumable.delivery, willPropose: true, threshold: resumable.threshold, approvals: resumable.approvals || [], status: resumable.status, token: resumable.token, chainId: Number(resumable.chainId), rows, progress: { ...(resumable.rowProgress || {}) }, running: false, done: false, startedAt: Date.now() };
            setActiveBatch(snap); activeBatchRef.current = snap;
            maybeExecuteAppBatch();
          }
        }
      }
    } catch (e) { console.warn("reloadBatches:", e?.message || e); }
  }, [maybeExecuteAppBatch]);
  useEffect(() => { reloadBatchesRef.current = reloadBatches; }, [reloadBatches]);
  useEffect(() => { if (treasury) reloadBatchesRef.current?.(); }, [treasury]);

  // Propose an N-of-M batch as an app-approval batch (no per-row Turnkey co-sign). Teammates approve
  // once; when the threshold is met the proposer's client (this one) executes each row.
  const startAppBatch = (inputRows, delivery) => {
    if (delivery === "direct") { toast("Direct-to-wallet isn't supported under multi-sig — use Confidential Settlement", "error"); return; }
    const rows = inputRows.map((r) => ({ address: r.address, amount: r.amount, label: r.label || null }));
    run(`Propose batch of ${rows.length}`, async () => {
      const cid = cfgRef.current.chainId;
      const tok = tokenRef.current;
      const token = { address: tok.address, symbol: tok.symbol, decimals: tok.decimals };
      const rowsEnc = await Promise.all(rows.map(async (r) => ({ recipient: r.address, recipientLabel: r.label, amountEnc: await encryptAmount(r.amount, treasuryRef.current.elgamalPriv) })));
      const batch = await api.createBatch({ delivery, chainId: cid, token, rows: rowsEnc });
      const snap = { id: batch.id, kind: "app", delivery, willPropose: true, threshold: batch.threshold, approvals: batch.approvals || [], status: batch.status, token, chainId: cid, rows, progress: {}, running: false, done: false, startedAt: Date.now() };
      setActiveBatch(snap); activeBatchRef.current = snap;
      await reloadPayouts();
      maybeExecuteAppBatch(); // in case threshold is already met
      return batch;
    }, { silent: true }).catch(() => {});
  };

  const approveAppBatch = (id) => run(`Approve batch`, async () => { await api.approveBatch(id); await reloadBatchesRef.current?.(); }, { silent: true });
  const rejectAppBatch = (id) => run(`Reject batch`, async () => {
    await api.rejectBatch(id);
    if (activeBatchRef.current?.id === id) { const nb = { ...activeBatchRef.current, status: "rejected", done: true, running: false }; setActiveBatch(nb); activeBatchRef.current = nb; }
    await reloadBatchesRef.current?.();
  }, { silent: true });

  const startBatch = (inputRows, delivery) => {
    if (activeBatchRef.current?.running) return; // one batch at a time
    if (settlingRef.current) { toast("A previous operation is still settling onchain - please wait until it completes.", "error"); return; }
    // N-of-M → APP-APPROVAL batch (Option A): teammates approve ONCE at the app layer, then the
    // proposer's client executes each row 1-of-M via the backend root key. (The per-row Turnkey
    // co-sign branch below is superseded and no longer reached at threshold > 1.)
    if ((treasuryRef.current?.threshold || 1) > 1) { startAppBatch(inputRows, delivery); return; }
    const rows = inputRows.map((r) => ({ address: r.address, amount: r.amount, label: r.label || null }));
    const willPropose = false; // 1-of-M path only from here
    const id = `batch_${Date.now().toString(36)}`;
    const snapshot = { id, delivery, willPropose, kind: "solo", rows, progress: {}, running: true, done: false, startedAt: Date.now() };
    setActiveBatch(snapshot); activeBatchRef.current = snapshot;

    // Fire-and-forget: not awaited by any component, so unmounting BatchPayout can't stop it.
    (async () => {
      const cid = cfgRef.current.chainId;
      try {
        if (willPropose) {
          // ── N-of-M: SERIALIZED. A confidential transfer's proof is bound to the sender's CURRENT
          // balance ciphertext, and the contract permits only ONE pending action per account. Co-signed
          // txs can't broadcast inline (they wait for approvals), so pre-signing the whole batch against
          // one balance snapshot is exactly what made rows 2..K revert with "pending action". Instead we
          // do one row at a time: propose (fresh proof vs the current balance) → wait for it to be approved
          // AND settled on-chain → then the next. Each row is approved individually and the proposer must
          // keep the app open (only their session can build each subsequent proof).
          for (let i = 0; i < rows.length; i++) {
            if (!activeBatchRef.current?.running) break;
            const row = rows[i];
            setRowProgress(i, { status: "running" });
            try {
              if (delivery === "direct") throw new Error("Direct-to-wallet isn't supported under multi-sig yet — use Confidential Settlement");
              if (delivery === "confidential") { const ok = await isActivated(row.address); if (!ok) throw new Error("recipient has no confidential account"); }
              // Fresh nonce for THIS row — the prior row has mined, so `/api/nonce` returns the correct
              // next value. Forcing it onto the co-signed tx guarantees the baked nonce == what the
              // executor broadcasts at (see proposePayout).
              const { base } = await api.nonce(1, cid);
              let pending = null;
              setNonceOverride(base);
              try { await executeOnChain({ recipient: row.address, amount: row.amount, delivery }); }
              catch (e) { pending = takeLastPending(); if (!pending) throw e; }
              finally { clearNonceOverride(); }
              if (!pending) throw new Error("expected a co-sign request but none was created");
              const payout = await recordPayout({ kind: "transfer", recipient: row.address, recipientLabel: row.label || null, amount: row.amount, delivery, nonce: base, batchId: id }, { pending: true, ...pending });
              setRowProgress(i, { status: "awaiting", payoutId: payout.id });
              await reloadPayouts(); // surface the new pending row to co-signers right away
              await waitForBatchRowSettled(payout.id); // block until approved + finalized (pendingAction clear)
              setRowProgress(i, { status: "completed" });
            } catch (e) {
              setRowProgress(i, { status: "failed", error: friendlyError(e) });
              break; // stop the batch — later rows' proofs depend on this one settling first
            }
          }
        } else {
          // ── 1-of-M: unchanged. The solo signer completes synchronously, so executeOnChain broadcasts
          // AND waits for finalization before the loop builds the next row — already serialized + correct.
          const { base } = await api.nonce(rows.length, cid);
          let nextNonce = base;
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            setRowProgress(i, { status: "running" });
            try {
              if (delivery === "confidential") { const ok = await isActivated(row.address); if (!ok) throw new Error("recipient has no confidential account"); }
              let txHash = null, pending = null;
              try { txHash = await executeOnChain({ recipient: row.address, amount: row.amount, delivery }); }
              catch (e) { pending = takeLastPending(); if (!pending) throw e; }
              await recordPayout({ kind: delivery === "direct" ? "withdraw" : "transfer", recipient: row.address, recipientLabel: row.label || null, amount: row.amount, delivery, nonce: nextNonce, batchId: id }, pending ? { pending: true, ...pending } : { txHash });
              setRowProgress(i, { status: pending ? "proposed" : "completed", txHash });
              nextNonce++; // only advance on a recorded payout — failures reuse the nonce (no gap)
            } catch (e) {
              setRowProgress(i, { status: "failed", error: friendlyError(e) });
            }
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

  // Single payout owned by context (survives navigation, like the batch): snapshot it, run
  // proposePayout fire-and-forget, and stamp the outcome on the snapshot so /single shows the live
  // status / result on return instead of a blank form — and a failure is visible, never "vanished".
  const startSend = (params) => {
    if (activeSendRef.current?.status === "sending") return;
    const snap = {
      id: `send_${Date.now().toString(36)}`,
      recipient: params.recipient, recipientLabel: params.recipientLabel || null,
      amount: params.amount, delivery: params.delivery, note: params.note || null,
      symbol: tokenRef.current?.symbol, chainId: cfgRef.current.chainId,
      willPropose: (treasuryRef.current?.threshold || 1) > 1,
      status: "sending", txHash: null, error: null, startedAt: Date.now(),
    };
    setActiveSend(snap); activeSendRef.current = snap;
    proposePayout(params)
      .then((r) => setActiveSend((s) => (s && s.id === snap.id ? { ...s, status: r?.pending ? "pending" : "completed", txHash: r?.txHash || null } : s)))
      .catch((e) => setActiveSend((s) => (s && s.id === snap.id ? { ...s, status: "failed", error: friendlyError(e) } : s)));
  };
  const clearSend = () => { if (activeSendRef.current?.status !== "sending") { setActiveSend(null); activeSendRef.current = null; } };

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
      if (settlingRef.current) throw new Error("A previous operation is still settling onchain - please wait until it completes.");
      if (activeBatchRef.current?.running) throw new Error("A batch payout is still running - let it finish before depositing.");
      lastLocalOpRef.current = Date.now();     // our own op — suppress a false "received" from this balance change
      await api.ensureAllowance(cid);          // backend-root sets the allowance if needed
      const { base } = await api.nonce(1, cid); // reserve a nonce (won't collide with pending payouts)
      let txHash = null, pending = null;
      // NONCE OVERRIDE ONLY FOR MULTI-SIG (see proposePayout). At 1-of-M, confidentialDeposit runs its own
      // applyPending() FIRST when pending>0 then the deposit — forcing our single nonce onto BOTH clashes.
      // Skipping it lets the SDK auto-sequence (applyPending=N finalized → deposit=N+1), i.e. auto-claim-then-
      // deposit works. At N-of-M the applyPending needs approvals (orphaned) so the deposit runs fine at `base`.
      if ((treasuryRef.current?.threshold || 1) > 1) setNonceOverride(base);
      try { const r = await cDeposit(treasury.signer, tok, amount); txHash = r?.hash || r?.transactionHash || null; }
      catch (e) { pending = takeLastPending(); if (!pending) throw e; }
      finally { clearNonceOverride(); }
      if (pending) { await recordPayout({ kind: "deposit", recipient: treasury.address, recipientLabel: "Treasury (self)", amount, delivery: "confidential", nonce: base }, { pending: true, ...pending }); await reloadPayouts(); return { pending: true }; }
      await recordPayout({ kind: "deposit", recipient: treasury.address, recipientLabel: "Treasury (self)", amount, delivery: "confidential", nonce: base }, { txHash });
      beginSettling("deposit", amount, txHash); // cDeposit resolved at the receipt (confirmed); balance settles in ~30-60s
      await Promise.all([refreshBalances(), reloadPayouts()]);
      return { completed: true };
    });

  // Claim = apply the treasury's `pending` (RECEIVED confidential funds) into `available` so they
  // show up + become spendable. A confidential transfer lands in the recipient's `pending`;
  // applyPending() finalizes it. The backend ROOT key signs it (fund-neutral → 1-click, NO
  // approvals, even at N-of-M). Then watch balances through the ~30-60s finalization. Bonus:
  // keeping `pending` at 0 stops the SDK's per-op auto-applyPending, so deposits/transfers stay fast.
  const claimPending = () =>
    run(`Claim confidential balance`, async () => {
      const cid = cfgRef.current.chainId;
      if (settlingRef.current) throw new Error("A previous operation is still settling onchain - wait for it to finalize, then try again.");
      if (activeBatchRef.current?.running) throw new Error("A batch payout is still running - let it finish before claiming.");
      lastLocalOpRef.current = Date.now();
      const amount = balances.confidential.pending; // what we're claiming (pre-claim pending)
      const r = await api.claim(cid);
      // applyPending mined (confirmed); the pending→available move lands after finalization (~30-60s).
      beginSettling("claim", amount, r?.txHash || null);
      // Record the claim in Transaction History (received funds finalized into spendable balance).
      await recordPayout({ kind: "claim", recipient: treasuryRef.current.address, recipientLabel: "Treasury (self)", amount, delivery: "confidential", nonce: null }, { txHash: r?.txHash || null });
      await Promise.all([refreshBalances(), reloadPayouts()]);
      return r;
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

  const activeSigners = members.filter((m) => m.status === "active").length;
  const signerCount = Math.max(activeSigners, treasury?.memberCount || 0);
  const network = cfg ? { name: cfg.networkName, shortName: cfg.shortName, chainId: cfg.chainId } : null;
  const value = {
    cfg, ready, bootError, now,
    chainId, networks, network, switchNetwork,
    treasury, members, signerCount, role: treasury?.role || null, threshold: treasury?.threshold || 1,
    authed: sessionActive(), session: getSession(),
    balances, nativeBalance, payouts, recipients, analytics, activeBatch, appBatches, activeSend, settling,
    token, tokens, switchToken, addCustomToken, symbol: token?.symbol || "USDC", tokenDecimals: token?.decimals ?? 6, nativeSymbol: cfg?.nativeSymbol || "ETH",
    toasts, busy, busyDesc, toast,
    // auth
    createTreasury, beginOtp, completeOtp, completeGoogle, createOrgWithGoogle, logout,
    // treasury ops
    activateTreasury, refreshBalances, depositToConfidential, claimPending, proposePayout, startSend, clearSend, startBatch, clearBatch, approveBatch, approveAppBatch, rejectAppBatch, approvePayout, rejectPayout,
    // members
    addMember, removeMember, setThreshold, saveName, addRecipient, removeRecipient, isActivated,
    // reloads
    reloadTreasury, reloadPayouts, reloadRecipients, reloadBatches,
  };
  return <OrgCtx.Provider value={value}>{children}</OrgCtx.Provider>;
}
