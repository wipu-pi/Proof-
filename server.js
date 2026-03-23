/**
 * ProofTH — Railway Server
 * Proxies Google Vision API and Gemini API
 *
 * Environment variables (set in Railway dashboard):
 *   GV_KEY  = your Google Cloud Vision API key
 *   GM_KEY  = your Gemini API key
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT   = process.env.PORT || 3000;
const GV_KEY = process.env.GV_KEY || '';
const GM_KEY = process.env.GM_KEY || '';
const TY_KEY = process.env.TY_KEY || '';

if (!GV_KEY) console.warn('⚠  GV_KEY not set — Google Vision will fail');
if (!GM_KEY) console.warn('⚠  GM_KEY not set — Gemini will fail');
if (!TY_KEY) console.warn('⚠  TY_KEY not set — Typhoon will fail');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.ico':  'image/x-icon',
};

function proxyPost(req, res, hostname, pathname, extraHeaders) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); }
    catch (e) { res.writeHead(400); res.end('Bad JSON'); return; }

    const payload = JSON.stringify(parsed);
    const options = {
      hostname,
      path: pathname,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...extraHeaders,
      },
    };

    console.log('[' + new Date().toISOString() + '] POST -> ' + hostname + pathname);

    const apiReq = https.request(options, apiRes => {
      let data = '';
      apiRes.on('data', chunk => { data += chunk; });
      apiRes.on('end', () => {
        console.log('  <- ' + apiRes.statusCode);
        if (apiRes.statusCode !== 200) console.log('  Body:', data.slice(0, 300));
        res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    });

    apiReq.on('error', err => {
      console.error('  Proxy error:', err.message);
      res.writeHead(502);
      res.end(JSON.stringify({ error: { message: 'Proxy error: ' + err.message } }));
    });

    apiReq.write(payload);
    apiReq.end();
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed = url.parse(req.url);

  // POST /api/vision -> Google Cloud Vision
  if (req.method === 'POST' && parsed.pathname === '/api/vision') {
    if (!GV_KEY) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: { message: 'GV_KEY not configured on server' } }));
      return;
    }
    proxyPost(req, res, 'vision.googleapis.com', '/v1/images:annotate?key=' + GV_KEY, {});
    return;
  }

  // POST /api/gemini -> Gemini API
  if (req.method === 'POST' && parsed.pathname === '/api/gemini') {
    if (!GM_KEY) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: { message: 'GM_KEY not configured on server' } }));
      return;
    }
    proxyPost(req, res, 'generativelanguage.googleapis.com',
      '/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + GM_KEY, {});
    return;
  }

  // GET /health -> status check
  if (req.method === 'GET' && parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', gv: !!GV_KEY, gm: !!GM_KEY }));
    return;
  }

  // POST /api/typhoon -> Typhoon API (OpenAI-compatible)
  if (req.method === 'POST' && parsed.pathname === '/api/typhoon') {
    if (!TY_KEY) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: { message: 'TY_KEY not configured on server' } }));
      return;
    }
    proxyPost(req, res, 'api.opentyphoon.ai',
      '/v1/chat/completions',
      { 'Authorization': 'Bearer ' + TY_KEY });
    return;
  }

  // Static files
  let filePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  filePath = path.join(__dirname, filePath);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const mime = MIME[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('\nProofTH Server running on port ' + PORT);
  console.log('GV_KEY: ' + (GV_KEY ? GV_KEY.slice(0,12)+'...' : 'NOT SET'));
  console.log('GM_KEY: ' + (GM_KEY ? GM_KEY.slice(0,12)+'...' : 'NOT SET'));
console.log('TY_KEY: ' + (TY_KEY ? TY_KEY.slice(0,12)+'...' : 'NOT SET'));
});
