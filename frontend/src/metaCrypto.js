// Client-side encryption for sensitive transaction metadata (amounts) so PLAINTEXT
// amounts never reach the backend. The key is derived from the user's per-chain
// ElGamal private key (already a secret only they hold, re-derivable on any device
// from their wallet), so:
//   • the backend stores only opaque ciphertext — it can't see payout amounts;
//   • any device the user signs in on can decrypt (same wallet+chain → same key).
//
// Recipient/sender addresses are NOT encrypted here — those are already public
// on-chain in the confidential (non-anonymous) flow. Only the amount is secret.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// AES-GCM key = SHA-256("fbp-meta-v1:" + elgamalPrivateKey). Non-extractable.
async function metaKey(elgamalPriv) {
  const seed = await crypto.subtle.digest("SHA-256", encoder.encode("fbp-meta-v1:" + String(elgamalPriv)));
  return crypto.subtle.importKey("raw", seed, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// Returns { iv:number[], ct:number[] } or null if no key.
export async function encryptAmount(amount, elgamalPriv) {
  if (!elgamalPriv || amount == null) return null;
  try {
    const key = await metaKey(elgamalPriv);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(String(amount)));
    return { iv: Array.from(iv), ct: Array.from(new Uint8Array(ct)) };
  } catch {
    return null;
  }
}

// Returns the plaintext amount string, or null if it can't be decrypted
// (no key for that chain, corrupt, etc. — the UI shows "•••" in that case).
export async function decryptAmount(enc, elgamalPriv) {
  if (!enc?.ct || !elgamalPriv) return null;
  try {
    const key = await metaKey(elgamalPriv);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(enc.iv) },
      key,
      new Uint8Array(enc.ct),
    );
    return decoder.decode(pt);
  } catch {
    return null;
  }
}
