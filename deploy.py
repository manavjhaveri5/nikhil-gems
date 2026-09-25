#!/usr/bin/env python3
"""Deploy prebuilt dist/ + api/ functions to Vercel (bypasses Node.js TLS issue)."""
import json, os, hashlib, subprocess, sys, mimetypes, time

AUTH_PATH = os.path.expanduser("~/Library/Application Support/com.vercel.cli/auth.json")
with open(AUTH_PATH) as f:
    TOKEN = json.load(f)["token"]

with open("/Users/manavjhaveri/Downloads/project/.vercel/project.json") as f:
    proj = json.load(f)

TEAM_ID = proj["orgId"]
# The checkout this script lives in — a worktree deploys its own files.
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
DIST_DIR = os.path.join(ROOT_DIR, "dist")
API_DIR  = os.path.join(ROOT_DIR, "api")

def sha1_of_file(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()

def curl_upload(path, sha, size):
    url = f"https://api.vercel.com/v2/files?teamId={TEAM_ID}"
    mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
    # wget avoids the OpenSSL BAD_RECORD_MAC issue curl has with large files on this machine
    cmd = [
        "wget", "-q", "-O-", "--no-check-certificate",
        "--server-response",
        f"--header=Authorization: Bearer {TOKEN}",
        f"--header=x-now-digest: {sha}",
        f"--header=Content-Length: {size}",
        f"--header=Content-Type: {mime}",
        f"--post-file={path}",
        url
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=130)
    # wget writes response headers to stderr, body to stdout
    if result.returncode not in (0, 8):  # 8 = server error response but still got one
        return False, result.stderr[:200]
    # Check HTTP status in stderr
    for line in result.stderr.split("\n"):
        if "HTTP/" in line and ("200" in line or "201" in line or "409" in line):
            return True, result.stdout
    # If body has URLs it's a success too
    if '"urls"' in result.stdout or '"url"' in result.stdout:
        return True, result.stdout
    return result.returncode == 0, result.stderr[:200]

# A build made without .env (e.g. in a fresh worktree) has no Supabase URL baked
# in and ships a blank page. Refuse it.
_assets = os.path.join(DIST_DIR, "assets")
if not any(".supabase.co" in open(os.path.join(_assets, fn), errors="ignore").read()
           for fn in os.listdir(_assets) if fn.endswith(".js")):
    sys.exit("dist/ has no Supabase URL — copy .env into this checkout and rebuild before deploying.")

# Collect dist/ files (mapped to root paths)
files = []
for root, dirs, filenames in os.walk(DIST_DIR):
    for fn in filenames:
        full = os.path.join(root, fn)
        rel = os.path.relpath(full, DIST_DIR).replace("\\", "/")
        sha = sha1_of_file(full)
        size = os.path.getsize(full)
        files.append({"file": rel, "sha": sha, "size": size, "path": full, "kind": "static"})

# Collect api/ files (kept as api/ paths)
api_files = []
for fn in os.listdir(API_DIR):
    if fn.endswith(".js"):
        full = os.path.join(API_DIR, fn)
        rel = f"api/{fn}"
        sha = sha1_of_file(full)
        size = os.path.getsize(full)
        api_files.append({"file": rel, "sha": sha, "size": size, "path": full, "kind": "function"})

# lib/ holds helpers the functions import (etsy-auth, canva-auth,
# listingCategories). Without it every function that imports ../lib crashes
# at load with FUNCTION_INVOCATION_FAILED, since nothing is built on Vercel.
LIB_DIR = os.path.join(ROOT_DIR, "lib")
for fn in sorted(os.listdir(LIB_DIR)):
    if fn.endswith(".js"):
        full = os.path.join(LIB_DIR, fn)
        api_files.append({"file": f"lib/{fn}", "sha": sha1_of_file(full), "size": os.path.getsize(full), "path": full, "kind": "support"})

# Also include package.json (needed so Vercel knows it's ESM: "type":"module")
pkg_path = os.path.join(ROOT_DIR, "package.json")
pkg_sha  = sha1_of_file(pkg_path)
pkg_size = os.path.getsize(pkg_path)
api_files.append({"file": "package.json", "sha": pkg_sha, "size": pkg_size, "path": pkg_path, "kind": "config"})

all_files = files + api_files
print(f"Found {len(files)} static files + {len(api_files)-1} api functions")

# Upload all files
for fi in all_files:
    ok, out = False, ""
    for attempt in range(3):
        ok, out = curl_upload(fi["path"], fi["sha"], fi["size"])
        if ok:
            break
        if attempt < 2:
            time.sleep(2 + attempt * 2)
    kb = fi["size"] // 1024
    tag = "fn" if fi["kind"] == "function" else fi["kind"]
    if ok:
        print(f"  ✓ [{tag}] {fi['file']} ({kb}KB)")
    else:
        print(f"  ✗ FAILED {fi['file']}: {out[:100]}")
        sys.exit(1)

# Build functions config from api/*.js files
functions_config = {}
max_durations = {
    "claude.js": 30, "etsy.js": 60, "raj.js": 60, "shopify.js": 90,
    "telegram.js": 60, "openai.js": 30, "embed.js": 30,
    "parse-pdf.js": 60, "etsy-auth.js": 30, "listing-manager.js": 30,
    "blob-upload.js": 30, "admin-create-user.js": 30,
    "ebay.js": 30, "mail.js": 15,
}
for fi in api_files:
    if fi["kind"] == "function":
        fn_name = os.path.basename(fi["file"])
        functions_config[fi["file"]] = {
            "maxDuration": max_durations.get(fn_name, 30)
        }

# Create deployment with static files + serverless functions
print("\nCreating deployment...")
deploy_files = []
for fi in all_files:
    deploy_files.append({"file": fi["file"], "sha": fi["sha"], "size": fi["size"]})

with open(os.path.join(ROOT_DIR, "vercel.json")) as f:
    rewrite_routes = [{"src": f"^{r['source']}$", "dest": r["destination"]}
                      for r in json.load(f).get("rewrites", [])]

deploy_body = {
    "name": "project",
    "files": deploy_files,
    "target": "production",
    # What is uploaded is already built: dist/ flattened to the root, plus the
    # api/ functions. Vercel must not build it again — the payload carries no
    # src/, no index.html and no vite.config for a build to work from.
    #
    # These four belong under projectSettings. Sent at the top level the API
    # ignores them, the project's own Vite setting stands, and Vercel runs
    # `npm run build` against a source tree that isn't there. An empty string
    # is the way to say "no command"; null means "inherit", which is how this
    # went unnoticed.
    "projectSettings": {
        "framework": None,
        "buildCommand": "",
        "installCommand": "",
        "outputDirectory": ".",
    },
    "functions": functions_config,
    "routes": [
        # vercel.json's rewrites (/api/etsy-auth, /api/canva-auth, /api/openai, …) —
        # a files-only deploy ignores vercel.json, so they have to be routes here.
        *rewrite_routes,
        {"src": "/api/(.*)", "dest": "/api/$1"},   # API functions
        {"src": "/sw.js", "dest": "/api/sw.js"},
        {"src": "/manifest.json", "dest": "/api/manifest.js"},
        {"src": "/icon-192.png", "dest": "/icon-192.png"},
        {"src": "/icon-512.png", "dest": "/icon-512.png"},
        {"src": "/assets/(.*)", "dest": "/assets/$1"},
        {"handle": "filesystem"},
        {"src": "/(.*)", "dest": "/index.html"}    # SPA fallback
    ],
}

body_str = json.dumps(deploy_body)
url = f"https://api.vercel.com/v13/deployments?teamId={TEAM_ID}&forceNew=1"

cmd = [
    "curl", "-sS", "--max-time", "60",
    "--tlsv1.2", "--http1.1",
    "-X", "POST", url,
    "-H", f"Authorization: Bearer {TOKEN}",
    "-H", "Content-Type: application/json",
    "-d", body_str
]
result = subprocess.run(cmd, capture_output=True, text=True, timeout=70)
if result.returncode != 0:
    print("Deploy FAILED:", result.stderr)
    sys.exit(1)

resp = json.loads(result.stdout)
if "error" in resp:
    print("Deploy error:", json.dumps(resp["error"], indent=2))
    sys.exit(1)

dep_id = resp.get("id","?")
dep_url = resp.get("url","?")
dep_state = resp.get("readyState","?")
print(f"\n✓ Deployment created!")
print(f"  ID:    {dep_id}")
print(f"  URL:   https://{dep_url}")
print(f"  State: {dep_state}")
aliases = resp.get("alias", [])
if aliases:
    print(f"  Prod:  https://{aliases[0]}")

# Poll for completion
if dep_id != "?":
    import time
    print("\nWaiting for deployment to go READY...", end="", flush=True)
    for i in range(30):
        time.sleep(5)
        cmd2 = ["curl", "-sS", "--max-time", "15",
                "--tlsv1.2", "--http1.1",
                "-H", f"Authorization: Bearer {TOKEN}",
                f"https://api.vercel.com/v13/deployments/{dep_id}?teamId={TEAM_ID}"]
        r2 = subprocess.run(cmd2, capture_output=True, text=True, timeout=20)
        if r2.returncode == 0:
            try:
                d2 = json.loads(r2.stdout)
                state = d2.get("readyState","?")
                print(f" {state}", end="", flush=True)
                if state in ("READY", "ERROR", "CANCELED"):
                    print()
                    if state == "READY":
                        print(f"\n🚀 LIVE at https://{dep_url}")
                        if aliases: print(f"🔗 Prod:  https://{aliases[0]}")
                        # Always keep the canonical alias pointing to latest
                        CANONICAL = "project-nine-tan-22.vercel.app"
                        alias_cmd = ["npx","vercel","alias","set",dep_url,CANONICAL,"--scope","manavjhaveri5s-projects"]
                        ar = subprocess.run(alias_cmd, capture_output=True, text=True, timeout=30)
                        combined = ar.stdout + ar.stderr
                        if "Success" in combined or "success" in combined.lower():
                            print(f"🔗 Alias: https://{CANONICAL}")
                        else:
                            print(f"  alias stderr: {ar.stderr.strip()[:120]}")
                            print(f"  alias stdout: {ar.stdout.strip()[:120]}")
                    else:
                        print(f"✗ Deployment {state}: {d2.get('errorMessage','')}")
                    break
            except:
                pass
    else:
        print("\nTimed out waiting — check Vercel dashboard")
