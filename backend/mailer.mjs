import nodemailer from "nodemailer";

let transport = null;
let mode = "console";

export function initMailer() {
  if (process.env.SENDGRID_API_KEY) {
    transport = nodemailer.createTransport({
      host: "smtp.sendgrid.net", port: 587, secure: false,
      auth: { user: "apikey", pass: process.env.SENDGRID_API_KEY },
    });
    mode = "sendgrid";
  } else if (process.env.SMTP_HOST && process.env.SMTP_USER) {
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE) === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    mode = "smtp";
  } else {
    mode = "console";
  }
  return { mode, from: process.env.MAIL_FROM };
}
export const mailerMode = () => mode;

function inviteHtml({ orgName, role, inviterEmail, acceptUrl }) {
  return `<!doctype html><html><body style="margin:0;background:#070c14;font-family:Inter,Arial,sans-serif;color:#e9f0f8;padding:28px">
  <table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#0f1826;border:1px solid #1e2c40;border-radius:14px;overflow:hidden">
    <tr><td style="padding:26px 28px 8px">
      <div style="font-size:18px;font-weight:700;color:#ffffff">Stabletrust&nbsp;Pro</div>
      <div style="font-size:12px;color:#8ba0b8">Confidential treasury payouts on Fairblock</div>
    </td></tr>
    <tr><td style="padding:12px 28px 4px;font-size:15px;line-height:1.55;color:#e9f0f8">
      <p style="margin:0"><b>${inviterEmail || "A treasury owner"}</b> invited you to join
      <b>${orgName || "their organization"}</b> as
      <b style="color:#7cc4f7;text-transform:capitalize">${role}</b>.</p>
    </td></tr>
    <tr><td style="padding:18px 28px 6px">
      <a href="${acceptUrl}" style="display:inline-block;background:linear-gradient(135deg,#1b8ae6,#3ba7f3);color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px">Accept invitation &rarr;</a>
    </td></tr>
    <tr><td style="padding:14px 28px 24px;font-size:12px;line-height:1.6;color:#8ba0b8">
      Or paste this link into your browser:<br>
      <span style="color:#7cc4f7;word-break:break-all">${acceptUrl}</span><br><br>
      This invitation expires in 7 days. If you weren't expecting it, you can ignore this email.
    </td></tr>
  </table></body></html>`;
}

export async function sendInvite({ to, orgName, role, inviterEmail, acceptUrl }) {
  const subject = `You're invited to ${orgName || "a treasury"} on Stabletrust Pro`;
  const text = `${inviterEmail || "A treasury owner"} invited you to join ${orgName || "their organization"} as ${role}.\n\nAccept your invitation:\n${acceptUrl}\n\nThis invitation expires in 7 days.`;
  const html = inviteHtml({ orgName, role, inviterEmail, acceptUrl });
  if (mode === "console" || !transport) {
    console.log(`[mailer:console] invite for ${to} → ${acceptUrl}`);
    return { mode: "console", acceptUrl };
  }
  const info = await transport.sendMail({ from: process.env.MAIL_FROM, to, subject, text, html });
  return { mode, messageId: info.messageId, accepted: info.accepted };
}
