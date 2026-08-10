// ─────────────────────────────────────────────────────────────────────────────
// ON-CHAIN SPIKE (Base Sepolia): prove the Fairblock confidential flow works when
// the treasury signer routes through a Turnkey 2-of-3 consensus policy.
//
//   node onchain.mjs setup   → create the multi-sig treasury sub-org + a recipient,
//                              print addresses to fund, save state.
//   node onchain.mjs run     → (after funding) activate + deposit + confidential
//                              transfer, all under 2-of-3, and verify balances.
//
// What it validates end-to-end against the REAL diamond:
//   • ElGamal derive / balance-read works with a SINGLE admin (1-of-3, no tx).
//   • Confidential deposit + transfer require 2-of-3 (admin-1 submits, admin-2 approves).
//   • The multi-sig signature is accepted on-chain (funds actually move, amount hidden).
// ─────────────────────────────────────────────────────────────────────────────
import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  AbstractSigner, Transaction, Signature, TypedDataEncoder, hashMessage,
  copyRequest, resolveProperties, resolveAddress, getAddress,
  Wallet, JsonRpcProvider, Contract, parseUnits, formatUnits, MaxUint256,
} from "ethers";
import { Turnkey } from "@turnkey/sdk-server";
import { generateP256KeyPair } from "@turnkey/crypto";
import { ConfidentialTransferClient } from "@fairblock/stabletrust";

// ── Base Sepolia (from the app's networks.js — single source of truth) ──
const CHAIN_ID = 84532;
const RPC_URL = process.env.RPC_URL_84532 || "https://sepolia.base.org";
const DIAMOND = "0x31Ce72e1D2A499140a95c19accE7bCF5E0664689";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const USDC_DECIMALS = 6;
const EXPLORER = "https://sepolia.basescan.org";
const DEPOSIT = process.env.DEPOSIT_USDC || "1.0";
const TRANSFER = process.env.TRANSFER_USDC || "0.5";
const STATE = new URL("./.onchain-state.json", import.meta.url);

const { TURNKEY_ORG_ID, TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY } = process.env;
const apiBaseUrl = process.env.TURNKEY_API_BASE_URL || "https://api.turnkey.com";

const log = (...a) => console.log(...a);
const hr = () => log("─".repeat(74));
const okm = (m) => log(`  \x1b[32m✓\x1b[0m ${m}`);
const badm = (m) => log(`  \x1b[31m✗\x1b[0m ${m}`);
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
];

// Turnkey server client for a given API keypair, scoped to an org. A short poller so a
// consensus-needed activity returns its pending state quickly (it won't self-complete).
const clientFor = (kp, orgId) =>
  new Turnkey({ apiBaseUrl, apiPublicKey: kp.publicKey, apiPrivateKey: kp.privateKey, defaultOrganizationId: orgId, activityPoller: { intervalMs: 500, numRetries: 1 } }).apiClient();
const apiKeyOf = (kp) => ({ apiKeyName: `${kp.name}-key`, publicKey: kp.publicKey, curveType: "API_KEY_CURVE_P256" });
const gen = (name) => { const k = generateP256KeyPair(); return { name, publicKey: k.publicKey, privateKey: k.privateKey }; };
// Turnkey returns { r, s, v } with v = "00"/"01"; ethers wants 27/28.
const assembleSig = ({ r, s, v }) => Signature.from({ r: `0x${r}`, s: `0x${s}`, v: parseInt(v, 10) + 27 }).serialized;

// ── An ethers v6 signer whose signing routes through a Turnkey sub-org, with a
//    consensus policy: raw-payload (message) signing is 1-of-M (the initiator alone);
//    transaction signing is N-of-M (initiator submits, approvers approve). Mirrors the
//    app's WalletKitSigner, but server-side + with the approval loop. ──
class ConsensusSigner extends AbstractSigner {
  constructor(address, subOrgId, initiator, approvers, provider) {
    super(provider);
    this.address = getAddress(address);
    this.subOrgId = subOrgId;
    this.initiator = initiator;   // apiClient that submits (counts as approval #1)
    this.approvers = approvers;   // apiClients that approve until the threshold is met
  }
  async getAddress() { return this.address; }
  connect(provider) { return new ConsensusSigner(this.address, this.subOrgId, this.initiator, this.approvers, provider); }

  // READ path — 1-of-M. A single admin's stamp completes it (no approvals needed).
  async _signDigest(digest) {
    const res = await this.initiator.signRawPayload({ organizationId: this.subOrgId, signWith: this.address, payload: digest, encoding: "PAYLOAD_ENCODING_HEXADECIMAL", hashFunction: "HASH_FUNCTION_NO_OP" });
    const a = res.activity;
    if (a?.status !== "ACTIVITY_STATUS_COMPLETED") throw new Error(`raw-payload not completed (needs quorum?): ${a?.status}`);
    return assembleSig(a.result.signRawPayloadResult);
  }
  async signMessage(message) { return this._signDigest(hashMessage(message)); }
  async signTypedData(domain, types, value) {
    const p = await TypedDataEncoder.resolveNames(domain, types, value, async (n) => (await this.provider?.resolveName(n)) ?? "");
    return this._signDigest(TypedDataEncoder.hash(p.domain, types, p.value));
  }

  // SPEND path — N-of-M. Initiator submits → CONSENSUS_NEEDED → approver(s) approve → signed.
  async signTransaction(transaction) {
    const { from, to, ...txn } = copyRequest(transaction);
    const resolved = await resolveProperties({ to: transaction.to ? resolveAddress(transaction.to, this.provider) : undefined, from: transaction.from ? resolveAddress(transaction.from, this.provider) : undefined });
    if (resolved.from != null && getAddress(resolved.from) !== this.address) throw new Error(`from mismatch: ${resolved.from}`);
    const tx = Transaction.from({ ...txn, ...(resolved.to ? { to: resolved.to } : {}) });
    const res = await this.initiator.signTransaction({ organizationId: this.subOrgId, signWith: this.address, unsignedTransaction: tx.unsignedSerialized.slice(2), type: "TRANSACTION_TYPE_ETHEREUM" });
    let a = res.activity;
    if (a.status === "ACTIVITY_STATUS_CONSENSUS_NEEDED") {
      log(`    \x1b[33m[2-of-3]\x1b[0m admin-1 submitted a payout → awaiting a 2nd admin…`);
      for (const approver of this.approvers) {
        await approver.approveActivity({ organizationId: this.subOrgId, fingerprint: a.fingerprint });
        for (let i = 0; i < 6 && a.status !== "ACTIVITY_STATUS_COMPLETED"; i++) {
          a = (await this.initiator.getActivity({ organizationId: this.subOrgId, activityId: a.id })).activity;
          if (a.status !== "ACTIVITY_STATUS_COMPLETED") await new Promise((r) => setTimeout(r, 400));
        }
        if (a.status === "ACTIVITY_STATUS_COMPLETED") { log(`    \x1b[32m[2-of-3]\x1b[0m admin-2 approved → signature produced, broadcasting`); break; }
      }
    }
    if (a.status !== "ACTIVITY_STATUS_COMPLETED") throw new Error(`transaction not completed: ${a.status}`);
    const signed = a.result.signTransactionResult.signedTransaction;
    return signed.startsWith("0x") ? signed : `0x${signed}`;
  }
}

const subResult = (r) => r?.activity?.result?.createSubOrganizationResultV7 || r?.activity?.result?.createSubOrganizationResultV6 || r?.activity?.result?.createSubOrganizationResult || r || {};

async function setup() {
  const parent = clientFor({ publicKey: TURNKEY_API_PUBLIC_KEY, privateKey: TURNKEY_API_PRIVATE_KEY }, TURNKEY_ORG_ID);
  const rootAdmin = gen("root-admin");
  const signers = [gen("signer-1"), gen("signer-2"), gen("signer-3")];

  hr(); log("SETUP — creating the 2-of-3 treasury sub-org on Base Sepolia");
  const created = await parent.createSubOrganization({
    subOrganizationName: `cosign-onchain-${Date.now().toString(36)}`,
    rootUsers: [{ userName: rootAdmin.name, apiKeys: [apiKeyOf(rootAdmin)], authenticators: [], oauthProviders: [] }],
    rootQuorumThreshold: 1,
    wallet: { walletName: "Treasury", accounts: [{ curve: "CURVE_SECP256K1", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/60'/0'/0/0", addressFormat: "ADDRESS_FORMAT_ETHEREUM" }] },
  });
  const sr = subResult(created);
  const subOrgId = sr.subOrganizationId;
  const treasury = sr.wallet?.addresses?.[0];
  if (!subOrgId || !treasury) throw new Error("could not read subOrgId/treasury: " + JSON.stringify(created).slice(0, 400));

  const root = clientFor(rootAdmin, subOrgId);
  await root.createUsers({ organizationId: subOrgId, users: signers.map((s) => ({ userName: s.name, apiKeys: [apiKeyOf(s)], authenticators: [], oauthProviders: [], userTags: [] })) });
  await root.createPolicy({ organizationId: subOrgId, policyName: "SPEND 2-of-3", effect: "EFFECT_ALLOW", consensus: "approvers.count() >= 2", condition: "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2'", notes: "spike" });
  await root.createPolicy({ organizationId: subOrgId, policyName: "READ 1-of-3", effect: "EFFECT_ALLOW", consensus: "approvers.count() >= 1", condition: "activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2'", notes: "spike" });
  await root.createPolicy({ organizationId: subOrgId, policyName: "allow approvals", effect: "EFFECT_ALLOW", consensus: "approvers.count() >= 1", condition: "activity.type == 'ACTIVITY_TYPE_APPROVE_ACTIVITY'", notes: "spike" });

  const recipient = Wallet.createRandom();
  writeFileSync(STATE, JSON.stringify({ subOrgId, treasury, rootAdmin, signers, recipient: { address: recipient.address, privateKey: recipient.privateKey } }, null, 2));

  okm(`treasury sub-org + 2-of-3 policies created`);
  hr();
  log("FUND THESE TWO ADDRESSES ON BASE SEPOLIA, then run:  node onchain.mjs run\n");
  log(`  1) TREASURY (multi-sig)   ${treasury}`);
  log(`       • ~0.02 ETH gas  +  ~2 test USDC`);
  log(`  2) RECIPIENT (plain)      ${recipient.address}`);
  log(`       • ~0.01 ETH gas  (only needs to activate its own confidential account)`);
  log("");
  log("  Gas faucet : https://www.alchemy.com/faucets/base-sepolia");
  log("  USDC faucet: https://faucet.circle.com  (Base Sepolia, token " + USDC + ")");
  log(`  Explorer   : ${EXPLORER}/address/${treasury}`);
  hr();
}

async function run() {
  if (!existsSync(STATE)) throw new Error("no state — run `node onchain.mjs setup` first");
  const st = JSON.parse(readFileSync(STATE));
  const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID);
  const [s1, s2, s3] = st.signers;
  const initiator = clientFor(s1, st.subOrgId);
  const approver = clientFor(s2, st.subOrgId);
  const treasurySigner = new ConsensusSigner(st.treasury, st.subOrgId, initiator, [approver], provider);
  const recipient = new Wallet(st.recipient.privateKey, provider);
  const sdk = new ConfidentialTransferClient(RPC_URL, DIAMOND, CHAIN_ID);
  const usdc = new Contract(USDC, ERC20_ABI, provider);
  const fmt = (v) => formatUnits(v, USDC_DECIMALS);
  const confBal = async (addr, pk) => { const b = await sdk.getConfidentialBalance(addr, pk, USDC); return { total: fmt(b.amount), avail: fmt(b.available.amount), pending: fmt(b.pending.amount) }; };
  let fails = 0; const check = (c, m) => { if (c) okm(m); else { badm(m); fails++; } };

  hr(); log("PRE-FLIGHT — funding check");
  const [tEth, tUsdc, rEth] = await Promise.all([provider.getBalance(st.treasury), usdc.balanceOf(st.treasury), provider.getBalance(st.recipient.address)]);
  log(`  treasury ${st.treasury}`);
  log(`    ETH ${formatUnits(tEth, 18)}   USDC ${fmt(tUsdc)}`);
  log(`  recipient ${st.recipient.address}`);
  log(`    ETH ${formatUnits(rEth, 18)}`);
  if (tEth === 0n || tUsdc < parseUnits(DEPOSIT, USDC_DECIMALS) || rEth === 0n) {
    throw new Error(`under-funded — need treasury gas + ≥${DEPOSIT} USDC and recipient gas. Fund and re-run.`);
  }
  okm("funded");

  hr(); log("STEP 1 — activate the RECIPIENT's confidential account (single-sig, plain wallet)");
  await sdk.ensureAccount(recipient);
  okm(`recipient activated (${st.recipient.address.slice(0, 10)}…)`);

  hr(); log("STEP 2 — activate the TREASURY: derive ElGamal key (1-of-3) + register on-chain (2-of-3)");
  const keys = await sdk.ensureAccount(treasurySigner);
  const info = await sdk.getAccountInfo(st.treasury);
  check(info.exists && info.finalized, `treasury confidential account is live on-chain (exists=${info.exists}, finalized=${info.finalized})`);

  hr(); log("STEP 3 — prove 1-of-3 READ: a DIFFERENT single admin (signer-3) derives the key & reads the balance");
  const readOnly = new ConsensusSigner(st.treasury, st.subOrgId, clientFor(s3, st.subOrgId), [], provider); // no approvers → only 1-of-M works
  const keys3 = await sdk.ensureAccount(readOnly, { waitForFinalization: false });
  check(keys3.privateKey === keys.privateKey, "any single admin derives the SAME key (deterministic) — 1-of-3 read confirmed");
  const before = await confBal(st.treasury, keys.privateKey);
  log(`  treasury confidential (before): ${before.total} USDC`);

  hr(); log(`STEP 4 — DEPOSIT ${DEPOSIT} USDC → confidential (approve 2-of-3, then deposit 2-of-3)`);
  const amount = parseUnits(DEPOSIT, USDC_DECIMALS);
  const usdcW = new Contract(USDC, ERC20_ABI, treasurySigner);
  if ((await usdcW.allowance(st.treasury, DIAMOND)) < amount) {
    const ap = await usdcW.approve(DIAMOND, MaxUint256); await ap.wait();
    okm("USDC approved to the diamond (via 2-of-3)");
  }
  const depRc = await sdk.confidentialDeposit(treasurySigner, USDC, amount);
  log(`    deposit tx: ${EXPLORER}/tx/${depRc?.hash || depRc?.transactionHash || "?"}`);
  const afterDep = await confBal(st.treasury, keys.privateKey);
  log(`  treasury confidential (after deposit): ${afterDep.total} USDC`);
  check(Number(afterDep.total) >= Number(before.total) + Number(DEPOSIT) - 1e-9, `deposit moved ${DEPOSIT} USDC into the confidential balance under 2-of-3`);

  hr(); log(`STEP 5 — CONFIDENTIAL TRANSFER ${TRANSFER} USDC → recipient (amount hidden on-chain, 2-of-3)`);
  const rKeys = await sdk.ensureAccount(recipient, { waitForFinalization: false });
  const rBefore = await confBal(st.recipient.address, rKeys.privateKey);
  const trRc = await sdk.confidentialTransfer(treasurySigner, st.recipient.address, USDC, parseUnits(TRANSFER, USDC_DECIMALS));
  log(`    transfer tx: ${EXPLORER}/tx/${trRc?.hash || trRc?.transactionHash || "?"}`);
  const tAfter = await confBal(st.treasury, keys.privateKey);
  const rAfter = await confBal(st.recipient.address, rKeys.privateKey);
  log(`  treasury confidential (after transfer): ${tAfter.total} USDC   recipient: ${rAfter.total} USDC`);
  check(Number(rAfter.total) >= Number(rBefore.total) + Number(TRANSFER) - 1e-9, `recipient received ${TRANSFER} USDC via a 2-of-3 confidential transfer`);

  hr();
  if (fails === 0) log("\x1b[32m✅ ON-CHAIN SPIKE PASSED\x1b[0m — confidential activate + deposit + transfer all work under Turnkey 2-of-3 on Base Sepolia.");
  else log(`\x1b[31m❌ ${fails} check(s) failed\x1b[0m`);
  process.exit(fails === 0 ? 0 : 1);
}

const cmd = process.argv[2];
try {
  if (cmd === "setup") await setup();
  else if (cmd === "run") await run();
  else { log("usage: node onchain.mjs [setup|run]"); process.exit(1); }
} catch (e) {
  badm(`error: ${e?.message || e}`);
  if (e?.cause) log("  cause:", JSON.stringify(e.cause).slice(0, 500));
  process.exit(1);
}
