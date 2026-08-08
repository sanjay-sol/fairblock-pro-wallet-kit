// No-op browser stub for the SDK's IBE (Layer B) helper.
//
// `encryptRandomness` is used ONLY for a fire-and-forget off-chain recovery record inside
// confidentialTransfer (it is NOT awaited — the transfer completes independently). The real
// implementation pulls in node `crypto` / `readable-stream`, which crash in the browser.
// Stubbing it keeps the confidential deposit/transfer/withdraw flow fully working while
// dropping that whole dependency subtree. Returning { queuedEncrypted: null } makes the
// downstream `.then(...)` short-circuit cleanly (no throw).
export async function encryptRandomness() {
  return { queuedEncrypted: null };
}
