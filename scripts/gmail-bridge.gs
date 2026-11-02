/* Gmail bridge for the Nikhil Gems ERP — read-only.
   Runs in your own Google account (script.google.com), so the ERP can search your
   Gmail for a figure and fetch an attachment, without a Google Cloud app.

   Set up once:
   1. script.google.com → New project → paste this file → Save.
   2. Project Settings → Script properties → add SECRET = the same long random
      string you put in Vercel as GMAIL_BRIDGE_SECRET.
   3. Deploy → New deployment → type "Web app": Execute as "Me",
      Who has access "Anyone" → Deploy → allow Gmail access when Google asks.
   4. Copy the Web app URL into Vercel as GMAIL_BRIDGE_URL.
   Without the secret every request is refused, so the URL alone gets nobody in. */

function doPost(e) {
  var b = {};
  try { b = JSON.parse(e.postData.contents); } catch (err) { return out({ error: "Bad request" }); }
  var secret = PropertiesService.getScriptProperties().getProperty("SECRET");
  if (!secret || b.secret !== secret) return out({ error: "Not allowed" });

  if (b.action === "search") {
    var threads = GmailApp.search(String(b.q || ""), 0, Math.min(Number(b.max) || 15, 30));
    return out({ threads: threads.map(function (t) {
      return {
        id: t.getId(), subject: t.getFirstMessageSubject(), url: t.getPermalink(),
        messages: t.getMessages().slice(-6).map(function (m) {
          var body = m.getPlainBody() || "";
          return {
            id: m.getId(), from: m.getFrom(), date: m.getDate().toISOString(), subject: m.getSubject(),
            hit: around(body, b.find), snippet: body.replace(/\s+/g, " ").slice(0, 220),
            attachments: m.getAttachments({ includeInlineImages: false }).map(function (a, i) {
              return { index: i, name: a.getName(), type: a.getContentType(), size: a.getSize() };
            }),
          };
        }),
      };
    }) });
  }

  if (b.action === "attachment") {
    var a = GmailApp.getMessageById(String(b.messageId)).getAttachments({ includeInlineImages: false })[Number(b.index) || 0];
    if (!a) return out({ error: "Attachment not found" });
    return out({ name: a.getName(), type: a.getContentType(), size: a.getSize(), b64: Utilities.base64Encode(a.getBytes()) });
  }
  return out({ error: "Unknown action" });
}

// The line around the first figure found, so you can see why the email matched.
function around(body, find) {
  var figs = String(find || "").split("|").filter(String);
  var flat = body.replace(/\s+/g, " ");
  for (var i = 0; i < figs.length; i++) {
    var at = flat.indexOf(figs[i]);
    if (at >= 0) return flat.slice(Math.max(0, at - 90), at + figs[i].length + 90);
  }
  return "";
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
