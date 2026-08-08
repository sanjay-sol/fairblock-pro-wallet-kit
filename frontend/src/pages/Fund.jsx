import { useOrg } from "../state/OrgContext.jsx";
import { Icon } from "../components/Icons.jsx";
import { CopyBtn, Stat, AsyncButton, TokenSelect } from "../components/ui.jsx";
import Qr from "../components/Qr.jsx";
import { explorerAddress } from "../networks.js";
import { fmtAmount } from "../lib/format.js";

export default function Fund() {
  const { treasury, network, chainId, token, balances, nativeBalance, symbol, nativeSymbol, refreshBalances, busy } = useOrg();
  const gasFaucets = network?.gasFaucets || [];
  const tokenFaucets = network?.tokenFaucets || [];
  const addrLink = explorerAddress(chainId, treasury?.address);

  return (
    <div className="page narrow">
      <div className="page-head">
        <h1>Fund wallet</h1>
        <p>
          Your treasury is a fresh wallet — it starts empty. Fund it on <b>{network?.name}</b> with a little
          native gas and some {symbol}, then deposit into your confidential balance. The address below is the
          same on every EVM network, but only funds on the selected network are usable here.
        </p>
      </div>

      {/* address + QR + balances */}
      <div className="card">
        <div className="fund-grid">
          <div>
            <label className="fld">Your treasury address on {network?.name}</label>
            <div className="flex between" style={{ background: "var(--card-2)", padding: "12px 14px", borderRadius: 10 }}>
              <span className="mono" style={{ wordBreak: "break-all" }}>{treasury?.address}</span>
              <CopyBtn value={treasury?.address} />
            </div>
            <div className="stats" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 14 }}>
              <Stat k={`Gas (${nativeSymbol})`} icon="coin">{fmtAmount(nativeBalance)}</Stat>
              <Stat k={`${symbol} (public)`} icon="wallet">{fmtAmount(balances.public)}</Stat>
            </div>
            <div className="flex wrap" style={{ marginTop: 14 }}>
              <AsyncButton className="btn sm ghost" onClick={() => refreshBalances()} disabled={busy}>
                <Icon.refresh size={14} /> Refresh balances
              </AsyncButton>
              {addrLink && (
                <a className="btn sm ghost" href={addrLink} target="_blank" rel="noreferrer">
                  <Icon.ext size={14} /> View on explorer
                </a>
              )}
            </div>
          </div>
          <div className="qr-col">
            <Qr value={treasury?.address} />
            <p className="hint" style={{ textAlign: "center", marginTop: 8 }}>Scan to send from a mobile wallet</p>
          </div>
        </div>
      </div>

      {/* step 1 — gas */}
      <div className="card">
        <h3>1 · Get gas ({nativeSymbol})</h3>
        <p className="csub">Every transaction needs a little native {nativeSymbol} for gas. Grab some from a public faucet:</p>
        {gasFaucets.length ? (
          <div className="faucet-list">
            {gasFaucets.map((f) => (
              <a key={f.url} className="faucet-link" href={f.url} target="_blank" rel="noreferrer">
                <Icon.coin size={16} /> {f.name}
                <span className="ext"><Icon.ext size={15} /></span>
              </a>
            ))}
          </div>
        ) : (
          <p className="hint">Request {network?.name} gas from the Fairblock team.</p>
        )}
      </div>

      {/* step 2 — token */}
      <div className="card">
        <h3>2 · Get {symbol}</h3>
        <p className="csub">This is the asset you'll deposit into your confidential balance and pay out.</p>
        <div style={{ maxWidth: 240, marginBottom: 12 }}><TokenSelect /></div>
        {tokenFaucets.length ? (
          <div className="faucet-list">
            {tokenFaucets.map((f) => (
              <a key={f.url} className="faucet-link" href={f.url} target="_blank" rel="noreferrer">
                <Icon.wallet size={16} /> {f.name}
                <span className="ext"><Icon.ext size={15} /></span>
              </a>
            ))}
          </div>
        ) : (
          <p className="hint">Request {symbol} on {network?.name} from the Fairblock team, or transfer it from another wallet.</p>
        )}
        <p className="hint" style={{ marginTop: 10 }}>
          Token contract: <span className="mono">{token?.address || network?.tokenAddress}</span>
        </p>
      </div>

      {/* step 3 — transfer in */}
      <div className="card">
        <h3>3 · Or send from another wallet</h3>
        <p className="csub">
          Already hold {nativeSymbol}/{symbol} elsewhere (MetaMask, an exchange, another account)? Send them to the
          address above on <b>{network?.name}</b>. Once gas + {symbol} arrive, go to the Dashboard → <b>Derive
          confidential keys</b> → <b>Deposit</b> to start making confidential payouts.
        </p>
      </div>
    </div>
  );
}
