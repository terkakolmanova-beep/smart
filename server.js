/**
 * SMART akcelerátor+ II PK – PDF server
 *
 * Spuštění:  npm install && npm start
 * Otevřít:   http://localhost:3000
 *
 * Endpointy:
 *   GET /          – webová stránka (index.html)
 *   GET /api/pdf   – vygeneruje a stáhne PDF (Puppeteer, landscape A4)
 *   GET /api/events – SSE stream; pošle "change" kdykoli se změní index.html
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;
const HTML_FILE = path.join(__dirname, 'index.html');
const PDF_FILE  = path.join(__dirname, 'SMART_akcelerator_II_PK.pdf');

// ── SSE: seznam aktivních klientů čekajících na change-eventy ──────────────
const sseClients = new Set();

function broadcastChange() {
  for (const res of sseClients) {
    res.write('data: change\n\n');
  }
}

// ── Hlídač souboru index.html ──────────────────────────────────────────────
let fsWatchDebounce = null;
fs.watch(HTML_FILE, () => {
  clearTimeout(fsWatchDebounce);
  fsWatchDebounce = setTimeout(() => {
    console.log('[watch] index.html změněn – notifikuji klienty');
    broadcastChange();
  }, 300);
});

// ── PDF generování (Puppeteer) ─────────────────────────────────────────────
let pdfGenerating = false;

async function generatePdf() {
  if (pdfGenerating) return null;
  pdfGenerating = true;
  console.log('[pdf] Spouštím Puppeteer…');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();

    // Renderovat jako screen – zachová všechny CSS barvy, gradienty a grid layouty
    await page.emulateMediaType('screen');
    await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });

    // Přeskočit heslo: nastavit sessionStorage před načtením stránky
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('smart_auth', '1');
    });

    // Použít file:// URL – správně načte CDN (Chart.js) i všechny inline styly
    await page.goto(`file://${HTML_FILE}`, {
      waitUntil: 'networkidle0',
      timeout: 30_000,
    });

    // Počkat na vykreslení Chart.js a usazení stránky
    await new Promise(r => setTimeout(r, 2500));

    // Minimální PDF-specifické styly – POUZE layout, ŽÁDNÉ přepisy barev
    await page.addStyleTag({ content: `
      #pwd-overlay, #top-bar { display: none !important; }
      body { padding: 0 !important; }
      .page {
        max-width: 100% !important;
        margin: 0 0 0 0 !important;
        box-shadow: none !important;
        page-break-after: always !important;
        break-after: page !important;
      }
      .page:last-of-type {
        page-break-after: avoid !important;
        break-after: avoid !important;
      }
      .band {
        display: grid !important;
        grid-template-columns: 260px 34px 1fr !important;
        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }
      .pos, .card, .eval, .pilot, .col
        { break-inside: avoid; page-break-inside: avoid; }
      h2, h3, h4, h5 { break-after: avoid; page-break-after: avoid; }
    ` });

    const pdf = await page.pdf({
      format: 'A4',
      landscape: true,
      margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
      printBackground: true,
      displayHeaderFooter: false,
      scale: 0.63,
    });

    fs.writeFileSync(PDF_FILE, pdf);
    console.log(`[pdf] Uloženo: ${PDF_FILE} (${(pdf.length / 1024).toFixed(0)} kB)`);
    return pdf;

  } finally {
    await browser.close();
    pdfGenerating = false;
  }
}

// ── HTTP server ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── GET /api/pdf ─────────────────────────────────────────────────────────
  if (url.pathname === '/api/pdf') {
    try {
      const pdf = await generatePdf();
      if (!pdf) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('PDF se právě generuje, zkuste za chvíli.');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="SMART_akcelerator_II_PK.pdf"',
        'Content-Length': pdf.length,
        'Cache-Control': 'no-store',
      });
      res.end(pdf);
    } catch (err) {
      console.error('[pdf] Chyba:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Chyba při generování PDF: ' + err.message);
    }
    return;
  }

  // ── GET /api/events (SSE) ─────────────────────────────────────────────────
  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // ── GET / nebo /index.html ────────────────────────────────────────────────
  const filePath = (url.pathname === '/' || url.pathname === '/index.html')
    ? HTML_FILE
    : path.join(__dirname, url.pathname);

  const ext = path.extname(filePath);
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css',
    '.js':   'application/javascript',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
  }[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n✅  Server běží na http://localhost:${PORT}`);
  console.log(`   PDF:    http://localhost:${PORT}/api/pdf`);
  console.log(`   Watch:  index.html je sledován – změny oznamuje klientům\n`);
});
