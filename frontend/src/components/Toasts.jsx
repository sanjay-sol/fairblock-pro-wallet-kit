import { useOrg } from "../state/OrgContext.jsx";

export default function Toasts() {
  const { toasts } = useOrg();
  if (!toasts.length) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>
      ))}
    </div>
  );
}
