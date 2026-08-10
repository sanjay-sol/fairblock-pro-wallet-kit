// Smoke-test the Model B Turnkey management module against the real (new) org.
import { initTurnkey, whoami, createTreasury, addMember, otpInit } from "./turnkey.mjs";

console.log("turnkey enabled:", initTurnkey());
const who = await whoami();
console.log("org:", who.organizationName, `(${who.organizationId})`);

const t = await createTreasury({ name: "Acme Finance", ownerEmail: "owner@example.com", ownerName: "Owner", threshold: 2 });
console.log("treasury subOrg:", t.subOrgId);
console.log("treasury wallet:", t.address);
console.log("ownerUserId   :", t.ownerUserId, "· spendPolicy:", t.spendPolicyId?.slice(0, 8) + "…");

const uid = await addMember({ rootKey: t.rootKey, email: "admin1@example.com", name: "Admin One" });
console.log("added member  :", uid);

const otpId = await otpInit({ rootKey: t.rootKey, email: "owner@example.com" });
console.log("otpInit otpId :", otpId);

console.log(uid && otpId && t.address ? "\n✅ backend Turnkey module works end-to-end" : "\n❌ something returned empty");
