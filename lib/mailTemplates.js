/* Transactional emails, in the Earth Editions look. Plain HTML tables, inline
   styles and a text version: that's what survives Outlook/Hotmail and keeps
   spam filters calm (no images required to read it, one clear link). */
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function layout({ preheader, heading, paragraphs, button, footer, logoUrl }) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#f6f4f0;font-family:Helvetica,Arial,sans-serif;color:#141210">
<span style="display:none;max-height:0;overflow:hidden">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4f0;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #ebe7e0">
<tr><td style="padding:32px 36px 8px" align="center">${logoUrl ? `<img src="${esc(logoUrl)}" width="120" alt="Earth Editions" style="display:block;border:0">` : `<div style="font-weight:700;letter-spacing:4px;font-size:20px">EARTH</div><div style="letter-spacing:6px;font-size:10px;color:#5d5850">EDITIONS</div>`}</td></tr>
<tr><td style="padding:24px 36px 8px"><h1 style="margin:0 0 16px;font-family:Georgia,serif;font-weight:normal;font-size:28px;line-height:1.2">${esc(heading)}</h1>
${paragraphs.map(p => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#3d3933">${esc(p)}</p>`).join("")}</td></tr>
${button ? `<tr><td style="padding:12px 36px 28px"><a href="${esc(button.url)}" style="display:inline-block;background:#141210;color:#ffffff;text-decoration:none;font-size:13px;letter-spacing:2px;text-transform:uppercase;padding:15px 28px">${esc(button.label)}</a>
<p style="margin:16px 0 0;font-size:12px;line-height:1.5;color:#9a948a">Or paste this link into your browser:<br><span style="word-break:break-all;color:#5d5850">${esc(button.url)}</span></p></td></tr>` : ""}
<tr><td style="padding:20px 36px 30px;border-top:1px solid #ebe7e0;font-size:12px;line-height:1.5;color:#9a948a">${esc(footer)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [heading, "", ...paragraphs, ...(button ? ["", `${button.label}: ${button.url}`] : []), "", footer].join("\n");
  return { html, text };
}

export function tradeApproved({ name, setupUrl, siteUrl, logoUrl }) {
  const first = String(name || "").split(" ")[0];
  return {
    subject: "Your Earth Editions trade account is approved",
    ...layout({
      logoUrl,
      preheader: "Set your password to see trade prices and order.",
      heading: `Welcome${first ? `, ${first}` : ""}`,
      paragraphs: [
        "Your Earth Editions trade account has been approved. Set a password to open the full catalogue with trade prices, and send us your orders straight from the site.",
        "The link below works once and stays valid for 14 days.",
      ],
      button: { label: "Set up your account", url: setupUrl },
      footer: `Earth Editions · Wholesale crystals & minerals · ${siteUrl.replace(/^https?:\/\//, "")}. You're receiving this because you applied for a trade account.`,
    }),
  };
}

export function passwordReset({ name, resetUrl, siteUrl, logoUrl }) {
  const first = String(name || "").split(" ")[0];
  return {
    subject: "Choose a new password — Earth Editions",
    ...layout({
      logoUrl,
      preheader: "A link to choose a new password.",
      heading: `Hello${first ? ` ${first}` : ""}`,
      paragraphs: ["Someone (hopefully you) asked to reset the password for your Earth Editions account. The link below works for the next two hours.", "If this wasn't you, you can ignore this email — your password stays the same."],
      button: { label: "Choose a new password", url: resetUrl },
      footer: `Earth Editions · ${siteUrl.replace(/^https?:\/\//, "")}`,
    }),
  };
}
