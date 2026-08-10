// Analytics computed CLIENT-SIDE from decrypted transactions. The backend can no
// longer aggregate amounts (they're stored encrypted), so we compute volume /
// by-asset / monthly here after decryption. Counts don't need amounts.
export function computeAnalytics(txs = []) {
  const done = txs.filter((t) => t.status === "completed" && ["payout", "transfer", "withdraw"].includes(t.kind));
  const num = (t) => Number(t.amount) || 0; // t.amount is the decrypted value (or null → 0)

  const totalVolume = done.reduce((s, t) => s + num(t), 0);
  const recipients = new Set(done.map((t) => (t.to || t.recipient || "").toLowerCase()).filter(Boolean));

  const byDelivery = {};
  for (const t of done) byDelivery[t.delivery] = (byDelivery[t.delivery] || 0) + num(t);

  const byAsset = {};
  for (const t of done) byAsset[t.tokenSymbol] = (byAsset[t.tokenSymbol] || 0) + num(t);

  const monthly = {};
  for (const t of done) {
    const key = (t.createdAt || "").slice(0, 7);
    if (key) monthly[key] = (monthly[key] || 0) + num(t);
  }

  return {
    totalVolume,
    totalPayouts: done.length,
    activeRecipients: recipients.size,
    byDelivery,
    byAsset,
    monthly,
  };
}
