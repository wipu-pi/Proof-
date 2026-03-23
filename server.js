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
  '.pdf':  'application/pdf',
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


  // POST /api/stamp-pdf -> stamp highlights onto PDF using pdf-lib
  if (req.method === 'POST' && parsed.pathname === '/api/stamp-pdf') {
    let body = Buffer.alloc(0);
    req.on('data', chunk => { body = Buffer.concat([body, chunk]); });
    req.on('end', async () => {
      try {
        const { PDFDocument, rgb } = require('pdf-lib');
        const payload = JSON.parse(body.toString());
        // payload: { pdfBase64, issues, pageWords }
        // pageWords[page] = [{text,x,y,w,h,imgW,imgH}]
        const pdfBytes = Buffer.from(payload.pdfBase64, 'base64');
        const pdfDoc = await PDFDocument.load(pdfBytes);
        const pages = pdfDoc.getPages();
        const colorMap = {
          spelling:    { r:0.85, g:0.18, b:0.18 },
          punctuation: { r:0.82, g:0.44, b:0.02 },
          brand:       { r:0.10, g:0.33, b:0.88 },
          forbidden:   { r:0.63, g:0.00, b:0.13 },
        };

        (payload.issues || []).forEach(function(iss) {
          var pageIdx = (iss.page || 1) - 1;
          if (pageIdx < 0 || pageIdx >= pages.length) return;
          var page = pages[pageIdx];
          var pw = page.getWidth();
          var ph = page.getHeight();
          var words = (payload.pageWords || {})[iss.page || 1] || [];
          if (!words.length) return;
          var imgW = words[0].imgW || 1000;
          var imgH = words[0].imgH || 1414;
          var scX = pw / imgW;
          var scY = ph / imgH;
          var col = colorMap[iss.type] || colorMap.spelling;
          var s = (iss.original || '').trim();

          // Find matching word rects (same logic as frontend)
          var rects = [];
          for (var i = 0; i < words.length; i++) {
            if (words[i].text === s) { rects.push(words[i]); if (rects.length >= 5) break; }
          }
          if (!rects.length) {
            for (var i = 0; i < words.length; i++) {
              if (words[i].text.includes(s)) { rects.push(words[i]); if (rects.length >= 5) break; }
            }
          }
          if (!rects.length) {
            for (var i = 0; i < words.length; i++) {
              if (words[i].text.trim().length >= 2 && s.includes(words[i].text.trim())) {
                rects.push(words[i]); if (rects.length >= 8) break;
              }
            }
          }
          // Merge into single bbox if multiple
          if (rects.length > 1) {
            var mx=rects[0].x,my=rects[0].y,mr=rects[0].x+rects[0].w,mb=rects[0].y+rects[0].h;
            rects.forEach(function(r){mx=Math.min(mx,r.x);my=Math.min(my,r.y);mr=Math.max(mr,r.x+r.w);mb=Math.max(mb,r.y+r.h);});
            rects=[{x:mx,y:my,w:mr-mx,h:mb-my,imgW:words[0].imgW,imgH:words[0].imgH}];
          }

          rects.forEach(function(r) {
            var x = r.x * scX;
            // PDF coords: y=0 is bottom, so flip
            var y = ph - (r.y * scY) - (r.h * scY);
            var w = r.w * scX;
            var h = r.h * scY;
            if (w < 2 || h < 2) return;
            page.drawRectangle({
              x: x, y: y, width: w, height: h,
              color: rgb(col.r, col.g, col.b),
              opacity: 0.3,
              borderColor: rgb(col.r * 0.7, col.g * 0.7, col.b * 0.7),
              borderWidth: 1,
            });
          });
        });

        const outBytes = await pdfDoc.save();
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="proofed.pdf"',
          'Content-Length': outBytes.length,
        });
        res.end(Buffer.from(outBytes));
      } catch (err) {
        console.error('stamp-pdf error:', err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
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
