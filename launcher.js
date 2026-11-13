'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3855);
const GIST_ID = '2d2eaaf5efd625d4d670877c48922751';
const CLOUDFLARED_PATH = fs.existsSync('C:\\Program Files (x86)\\cloudflared\\cloudflared.exe')
  ? 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe'
  : 'cloudflared';
const API_LOCAL_FILE = path.join(__dirname, 'api-local.json');
const DATA_DIR = path.join(__dirname, 'data');
const QUICK_CFG = path.join(DATA_DIR, 'quick-tunnel.yml');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(QUICK_CFG)) fs.writeFileSync(QUICK_CFG, '# Isolated config for quick tunnel\n', 'utf8');

console.log('Starting Roadtrip Hub local server...');
const serverProc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  stdio: 'inherit',
  env: { ...process.env, PORT: String(PORT) },
});

console.log('Starting Cloudflare Quick Tunnel...');
const tunnelProc = spawn(
  CLOUDFLARED_PATH,
  ['tunnel', '--no-autoupdate', '--config', QUICK_CFG, '--url', `http://127.0.0.1:${PORT}`],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);

let publishedUrl = null;
let buffer = '';

function publishTunnelUrl(url) {
  if (publishedUrl === url) return;
  publishedUrl = url;
  const payload = JSON.stringify({ apiUrl: url, updatedAt: new Date().toISOString() }, null, 2);
  fs.writeFileSync(API_LOCAL_FILE, payload, 'utf8');

  try {
    execFileSync('gh', ['gist', 'edit', GIST_ID, '-f', 'api-local.json', API_LOCAL_FILE], {
      stdio: 'pipe',
    });
    console.log('\n============================================================');
    console.log(' ROADTRIP HUB IS LIVE!');
    console.log('------------------------------------------------------------');
    console.log(` Shareable Page : https://shangle.me/roadtrip/`);
    console.log(` Direct Tunnel  : ${url}`);
    console.log(` Local URL      : http://127.0.0.1:${PORT}`);
    console.log(' Discovery Gist updated — shangle.me/roadtrip/ auto-connects!');
    console.log('============================================================\n');
  } catch (err) {
    console.error('Warning: failed to update discovery Gist:', err.message);
    console.log(`Direct URL still works at: ${url}`);
    console.log(`Or open: https://shangle.me/roadtrip/?api=${encodeURIComponent(url)}`);
  }
}

function handleTunnelOutput(chunk) {
  const text = chunk.toString();
  buffer += text;
  if (buffer.length > 8000) buffer = buffer.slice(-4000);
  const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (match && !publishedUrl) {
    publishTunnelUrl(match[0]);
  }
}

tunnelProc.stdout.on('data', handleTunnelOutput);
tunnelProc.stderr.on('data', handleTunnelOutput);

tunnelProc.on('exit', (code) => {
  console.log(`cloudflared exited with code ${code}`);
  try { serverProc.kill(); } catch {}
  process.exit(code || 0);
});

serverProc.on('exit', (code) => {
  console.log(`server.js exited with code ${code}`);
  try { tunnelProc.kill(); } catch {}
  process.exit(code || 0);
});

function shutdown() {
  console.log('\nShutting down Roadtrip Hub...');
  try { tunnelProc.kill(); } catch {}
  try { serverProc.kill(); } catch {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
