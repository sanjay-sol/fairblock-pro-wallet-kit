import { useOrg } from "../state/OrgContext.jsx";
import { Icon } from "../components/Icons.jsx";
import { CopyBtn, Stat, AsyncButton } from "../components/ui.jsx";
import Qr from "../components/Qr.jsx";
import { explorerAddress } from "../config.js";
import { fmtAmount } from "../lib/format.js";

export default function Fund() {
  const { treasury, cfg, chainId, balances, nativeBalance, symbol, nativeSymbol, refreshBalances, busy } = useOrg();
  const gasFaucets = cfg?.gasFaucets || [];
  const tokenFaucets = cfg?.tokenFaucets || [];
  const addrLink = explorerAddress(chainId, treasury?.address);

  return (
    <div className="page narrow">
      <div className="page-head">
        <h1>Fund wallet</h1>
        <p>The treasury is a fresh wallet — it starts empty. Fund it on <b>{cfg?.networkName}</b> with a little {nativeSymbol} for gas and some {symbol}, then deposit into the confidential balance.</p>
      </div>

      <div className="card">
        <div className="fund-grid">
          <div>
            <label className="fld">Treasury address on {cfg?.networkName}</label>
            <div className="flex between" style={{ background: "var(--card-2)", padding: "12px 14px", borderRadius: 10 }}>
              <span className="mono" style={{ wordBreak: "break-all" }}>{treasury?.address}</span>
              <CopyBtn value={treasury?.address} />
            </div>
            <div className="stats" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 14 }}>
              <Stat k={`Gas (${nativeSymbol})`} icon="coin">{fmtAmount(nativeBalance)}</Stat>
              <Stat k={`${symbol} (public)`} icon="wallet">{fmtAmount(balances.public)}</Stat>
            </div>
            <div className="flex wrap" style={{ marginTop: 14 }}>
              <AsyncButton className="btn sm ghost" onClick={() => refreshBalances()} disabled={busy}><Icon.refresh size={14} /> Refresh balances</AsyncButton>
              {addrLink && <a className="btn sm ghost" href={addrLink} target="_blank" rel="noreferrer"><Icon.ext size={14} /> View on explorer</a>}
            </div>
          </div>
          <div className="qr-col"><Qr value={treasury?.address} /><p className="hint" style={{ textAlign: "center", marginTop: 8 }}>Scan to send from a mobile wallet</p></div>
        </div>
      </div>

      <div className="card">
        <h3>1 · Get gas ({nativeSymbol})</h3>
        <p className="csub">Every transaction needs a little native {nativeSymbol} for gas.</p>
        <div className="faucet-list">{gasFaucets.map((f) => <a key={f.url} className="faucet-link" href={f.url} target="_blank" rel="noreferrer"><Icon.coin size={16} /> {f.name}<span className="ext"><Icon.ext size={15} /></span></a>)}</div>
      </div>

      <div className="card">
        <h3>2 · Get {symbol}</h3>
        <p className="csub">The asset you'll deposit into the confidential balance and pay out.</p>
        <div className="faucet-list">{tokenFaucets.map((f) => <a key={f.url} className="faucet-link" href={f.url} target="_blank" rel="noreferrer"><Icon.wallet size={16} /> {f.name}<span className="ext"><Icon.ext size={15} /></span></a>)}</div>
        <p className="hint" style={{ marginTop: 10 }}>Token contract: <span className="mono">{cfg?.tokenAddress}</span></p>
      </div>

      <div className="card">
        <h3>3 · Deposit</h3>
        <p className="csub">Once gas + {symbol} arrive, go to the <b>Dashboard</b> → <b>Derive confidential keys</b> → <b>Deposit</b> to load your confidential balance.</p>
      </div>
    </div>
  );
}
