#!/usr/bin/env node
/**
 * Deploy prebuilt dist/ to Vercel via API using Node.js HTTPS.
 * NODE_TLS_REJECT_UNAUTHORIZED=0 is set by the caller to work around LibreSSL SSL MAC issues.
 */
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const os = require('os');

const DIST_DIR = path.join(__dirname, 'dist');
const AUTH_PATH = path.join(os.homedir(), 'Library/Application Support/com.vercel.cli/auth.json');
const TOKEN = JSON.parse(fs.readFileSync(AUTH_PATH)).token;
const proj = JSON.parse(fs.readFileSync(path.join(__dirname, '.vercel/project.json')));
const TEAM_ID = proj.orgId;

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html',
           '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
}

function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }

function apiRequest(method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.vercel.com', port: 443, method, path: urlPath,
      headers, rejectUnauthorized: false,
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function uploadFile(filePath) {
  const data = fs.readFileSync(filePath);
  const sha = sha1(data);
  const mime = mimeFor(filePath);
  const size = data.length;
  const urlPath = `/v2/files?teamId=${TEAM_ID}`;
  const { status } = await apiRequest('POST', urlPath, {
    'Authorization': `Bearer ${TOKEN}`,
    'x-now-digest': sha,
    'Content-Length': size,
    'Content-Type': mime,
  }, data);
  return { sha, size, ok: status === 200 || status === 201 };
}

function walkDir(dir) {
  const entries = [];
  for (const fn of fs.readdirSync(dir)) {
    const full = path.join(dir, fn);
    if (fs.statSync(full).isDirectory()) entries.push(...walkDir(full));
    else entries.push(full);
  }
  return entries;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const allFiles = walkDir(DIST_DIR);
  console.log(`Found ${allFiles.length} files to deploy from dist/`);

  const deployFiles = [];
  for (const fullPath of allFiles) {
    const rel = path.relative(DIST_DIR, fullPath);
    process.stdout.write(`  uploading ${rel}...`);
    let ok = false, sha, size;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result = await uploadFile(fullPath);
        ok = result.ok; sha = result.sha; size = result.size;
        if (ok) break;
        process.stdout.write(` retry${attempt}`);
        await sleep(2000 * attempt);
      } catch (e) {
        process.stdout.write(` err(${e.message.slice(0,30)}) retry${attempt}`);
        await sleep(2000 * attempt);
      }
    }
    if (!ok) { console.log(` ✗ FAILED`); process.exit(1); }
    const kb = Math.round(size / 1024);
    console.log(` ✓ (${kb}KB)`);
    const urlRel = '/' + rel.replace(/\\/g, '/');
    deployFiles.push({ file: urlRel, sha, size });
  }

  console.log('\nCreating deployment...');
  const deployBody = JSON.stringify({
    name: 'project', files: deployFiles, target: 'production',
    buildCommand: null, installCommand: null, outputDirectory: null, framework: null,
    routes: [{ handle: 'filesystem' }, { src: '/(.*)', dest: '/index.html' }],
  });
  const { status, body } = await apiRequest('POST',
    `/v13/deployments?teamId=${TEAM_ID}&forceNew=1`,
    { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(deployBody) },
    deployBody
  );
  const resp = JSON.parse(body);
  if (resp.error) { console.error('Deploy error:', JSON.stringify(resp.error, null, 2)); process.exit(1); }

  const depId = resp.id || '?';
  const depUrl = resp.url || '?';
  console.log(`✓ Deployment created!`);
  console.log(`  ID:    ${depId}`);
  console.log(`  URL:   https://${depUrl}`);
  const aliases = resp.alias || [];
  if (aliases.length) console.log(`  Prod:  https://${aliases[0]}`);

  // Poll for READY
  process.stdout.write('\nWaiting for deployment to go READY...');
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    try {
      const { body: b2 } = await apiRequest('GET',
        `/v13/deployments/${depId}?teamId=${TEAM_ID}`,
        { 'Authorization': `Bearer ${TOKEN}` }
      );
      const d2 = JSON.parse(b2);
      const state = d2.readyState || '?';
      process.stdout.write(` ${state}`);
      if (['READY', 'ERROR', 'CANCELED'].includes(state)) {
        console.log();
        if (state === 'READY') {
          console.log(`\n🚀 LIVE at https://${depUrl}`);
          if (aliases.length) console.log(`🔗 Prod:  https://${aliases[0]}`);
          // Update alias
          const { execFileSync } = require('child_process');
          try {
            const r = execFileSync('npx', ['vercel', 'alias', 'set', depUrl,
              'project-nine-tan-22.vercel.app', '--scope', 'manavjhaveri5s-projects', '--yes'],
              { encoding: 'utf8', timeout: 30000 });
            if (r.toLowerCase().includes('success')) console.log('🔗 Alias: https://project-nine-tan-22.vercel.app');
            else console.log('  (alias update: ' + r.slice(0, 80) + ')');
          } catch (e) { console.log('  (alias update skipped: ' + e.message.slice(0, 60) + ')'); }
        } else {
          console.log(`✗ Deployment ${state}: ${d2.errorMessage || ''}`);
        }
        break;
      }
    } catch (e) { /* ignore poll errors */ }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
