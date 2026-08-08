import { useEffect, useState } from "react";
import QRCode from "qrcode";

// Renders an offline QR (data URL) of `value` — used to scan the treasury address
// into a mobile wallet. qrcode is a pure-JS dep (no network), CSP-safe.
export default function Qr({ value, size = 176 }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let alive = true;
    if (!value) return;
    QRCode.toDataURL(String(value), { margin: 1, width: size * 2, errorCorrectionLevel: "M" })
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setSrc(""));
    return () => {
      alive = false;
    };
  }, [value, size]);

  if (!src) return <div className="qrbox" style={{ width: size + 24, height: size + 24 }} />;
  return (
    <div className="qrbox">
      <img src={src} alt="wallet address QR" width={size} height={size} />
    </div>
  );
}
