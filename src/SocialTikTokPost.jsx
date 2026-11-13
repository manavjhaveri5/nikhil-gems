/* Compose → TikTok → "Post now": the settings TikTok's Content Sharing
   Guidelines require before a direct post (needed to pass app review):
   - the account it posts to (creator nickname) and a preview of the video;
   - who can see it — chosen by hand every time, from the options TikTok
     gives this account, with nothing picked in advance;
   - comments / duet / stitch, all off until ticked, greyed out where the
     account has them turned off in TikTok;
   - "Disclose video content": Your brand ("Promotional content") and/or
     Branded content ("Paid partnership", which can't be private);
   - the music-usage (and branded-content) consent line;
   - the account's longest allowed video.
   It reports { ready, settings } up to Compose, which sends `settings` as
   payload.tt; api/social.js postTikTok passes them on to TikTok. */
import { useState, useEffect } from "react";
import { C, FI } from "./lmTheme.js";

const LABEL = { PUBLIC_TO_EVERYONE: "Everyone", MUTUAL_FOLLOW_FRIENDS: "Friends", FOLLOWER_OF_CREATOR: "Followers", SELF_ONLY: "Only me" };
const a = { color: C.ink, textDecoration: "underline" };

export default function TikTokPostSettings({ video, onChange }) {
  const [ci, setCi] = useState(null);
  const [err, setErr] = useState("");
  const [privacy, setPrivacy] = useState("");
  const [allow, setAllow] = useState({ comment: false, duet: false, stitch: false });
  const [disclose, setDisclose] = useState(false);
  const [yours, setYours] = useState(false);
  const [paid, setPaid] = useState(false);
  const [dur, setDur] = useState(0);

  useEffect(() => {
    fetch("/api/social?action=tiktok_creator").then(r => r.json()).then(d => d.error ? setErr(d.error) : setCi(d)).catch(e => setErr(e.message));
  }, []);

  const tooLong = !!(ci?.max_video_post_duration_sec && dur && dur > ci.max_video_post_duration_sec);
  const needsBrandPick = disclose && !yours && !paid;
  const privateWithPaid = paid && privacy === "SELF_ONLY";
  const ready = !!ci && !!privacy && !needsBrandPick && !privateWithPaid && !tooLong;

  useEffect(() => {
    onChange({
      ready,
      settings: {
        privacy_level: privacy,
        disable_comment: !allow.comment || !!ci?.comment_disabled,
        disable_duet: !allow.duet || !!ci?.duet_disabled,
        disable_stitch: !allow.stitch || !!ci?.stitch_disabled,
        brand_organic_toggle: disclose && yours,
        brand_content_toggle: disclose && paid,
      },
    });
  }, [ready, privacy, allow, disclose, yours, paid, ci]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <div style={{ fontSize: 12.5, color: C.red, marginTop: 6 }}>⚠ TikTok: {err}</div>;
  if (!ci) return <div style={{ fontSize: 12.5, color: C.inkFaint, marginTop: 6 }}>Checking your TikTok account…</div>;

  const box = (k, label, off) => (
    <label key={k} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, opacity: off ? .45 : 1, cursor: off ? "not-allowed" : "pointer" }}>
      <input type="checkbox" disabled={off} checked={!off && allow[k]} onChange={e => setAllow(s => ({ ...s, [k]: e.target.checked }))} /> {label}
    </label>
  );
  const opts = ci.privacy_level_options || [];

  return (
    <div style={{ marginTop: 8, background: C.card, borderRadius: 10, padding: 12, display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        {video && <video src={video} controls muted playsInline preload="metadata" onLoadedMetadata={e => setDur(e.currentTarget.duration || 0)}
          style={{ width: 110, aspectRatio: "9 / 16", objectFit: "cover", borderRadius: 8, background: "#000", flex: "none" }} />}
        <div style={{ flex: 1, minWidth: 200, display: "grid", gap: 10 }}>
          <div style={{ fontSize: 13 }}>Posting to <b>{ci.creator_nickname || "your TikTok"}</b>{ci.creator_username ? <span style={{ color: C.inkFaint }}> @{ci.creator_username}</span> : null}</div>

          <label style={{ fontSize: 12.5, display: "grid", gap: 4 }}>
            <span style={{ fontWeight: 700 }}>Who can see this video</span>
            <select value={privacy} onChange={e => setPrivacy(e.target.value)} style={FI({ padding: "6px 8px", fontSize: 13 })}>
              <option value="" disabled>Choose…</option>
              {opts.map(o => <option key={o} value={o} disabled={paid && o === "SELF_ONLY"}>{LABEL[o] || o}{paid && o === "SELF_ONLY" ? " (not for branded content)" : ""}</option>)}
            </select>
          </label>

          <div style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700 }}>Allow users to</span>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              {box("comment", "Comment", !!ci.comment_disabled)}
              {box("duet", "Duet", !!ci.duet_disabled)}
              {box("stitch", "Stitch", !!ci.stitch_disabled)}
            </div>
          </div>
        </div>
      </div>

      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10, display: "grid", gap: 6 }}>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
          <input type="checkbox" checked={disclose} onChange={e => { setDisclose(e.target.checked); if (!e.target.checked) { setYours(false); setPaid(false); } }} /> Disclose video content
        </label>
        <div style={{ fontSize: 12, color: C.inkMid }}>Turn on to say this video promotes goods or services in exchange for something of value. It could promote you, a third party, or both.</div>
        {disclose && <div style={{ display: "grid", gap: 6, paddingLeft: 22 }}>
          <label style={{ fontSize: 13, cursor: "pointer" }}><input type="checkbox" checked={yours} onChange={e => setYours(e.target.checked)} /> <b>Your brand</b> — you're promoting yourself or your own business. It will be labelled "Promotional content".</label>
          <label style={{ fontSize: 13, cursor: "pointer" }}><input type="checkbox" checked={paid} onChange={e => { setPaid(e.target.checked); if (e.target.checked && privacy === "SELF_ONLY") setPrivacy(""); }} /> <b>Branded content</b> — you're promoting another brand or a third party. It will be labelled "Paid partnership".</label>
          {needsBrandPick && <div style={{ fontSize: 12, color: C.amber }}>Pick at least one to disclose, or turn disclosure off.</div>}
        </div>}
      </div>

      {tooLong && <div style={{ fontSize: 12.5, color: C.red }}>This video is {Math.round(dur)}s; this account can post up to {ci.max_video_post_duration_sec}s.</div>}
      <div style={{ fontSize: 12, color: C.inkMid }}>
        By posting, you agree to TikTok's{paid ? <> <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noreferrer" style={a}>Branded Content Policy</a> and</> : null}{" "}
        <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer" style={a}>Music Usage Confirmation</a>.
      </div>
      <div style={{ fontSize: 11.5, color: C.inkFaint }}>After posting, TikTok takes a few minutes to process the video before it shows on your profile.</div>
    </div>
  );
}
