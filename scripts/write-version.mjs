// Writes public/version.json before `vite build` so each deployed build is
// visible at /version.json without spending a Vercel serverless function
// (the 12-function Hobby limit is already fully used by api/).
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

let sha = process.env.VERCEL_GIT_COMMIT_SHA || "";
if (!sha) {
  try {
    sha = execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    /* not a git checkout */
  }
}

const builtAt = new Date().toISOString();
const payload = {
  version: sha ? `${sha}-${builtAt}` : `build-${builtAt}`,
  commit: sha || "unknown",
  builtAt,
};

mkdirSync("public", { recursive: true });
writeFileSync("public/version.json", JSON.stringify(payload) + "\n");
console.log("version.json:", payload);
