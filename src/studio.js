/* studio.eartheditions.co serves this same app as "Earth Editions Studio":
   the Social module alone, under the Earth Editions name. It's the address
   the TikTok developer app points to (TikTok wants the app's own domain).
   Everywhere else the ERP is unchanged. */
export const STUDIO = typeof location !== "undefined" && /^studio\./i.test(location.hostname);
export const STUDIO_NAME = "Earth Editions Studio";
