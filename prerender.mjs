// Pre-render: execute the in-browser React for each page and bake the rendered
// HTML into <div id="root"> so crawlers receive real content. Client scripts
// are left intact so React re-mounts and interactivity still works.
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = process.cwd();
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Users/mridhul/.cache/puppeteer/chrome/mac_arm-149.0.7827.22/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const CHROME = CHROME_CANDIDATES.find(p => existsSync(p));
const PAGES = [
  'index.html',
  'Services.html',
  'Industries.html',
  'About.html',
  'services/index.html',
  'industries/index.html',
  'about/index.html',
  'blog/index.html',
  'blog/from-prompt-to-production-what-it-actually-takes/index.html',
];

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.ico': 'image/x-icon' };

// Static file server over the working directory
const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/' || p === '') p = '/index.html';
    const buf = await readFile(join(ROOT, p));
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});

await new Promise(r => server.listen(0, r));
const port = server.address().port;
console.log('serving on', port);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox'] });

for (const file of PAGES) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://localhost:${port}/${file}`,
    { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Wait until React has actually populated #root
  await page.waitForFunction(
    () => { const r = document.getElementById('root'); return r && r.children.length > 0 && r.innerText.trim().length > 10; },
    { timeout: 60000 });
  const rendered = await page.$eval('#root', el => el.innerHTML);

  // Idempotent bake: replace #root's entire current contents (empty or
  // previously prerendered) with the fresh render. The script section that
  // follows always starts with the "<!-- ═══" marker, which never appears
  // inside rendered content, so it is a safe right boundary.
  const src = await readFile(join(ROOT, file), 'utf8');
  const start = src.indexOf('<div id="root">');
  const marker = src.indexOf('<!--', start);
  if (start === -1 || marker === -1) {
    console.warn('!! could not locate #root boundaries in', file);
    await page.close();
    continue;
  }
  const out = src.slice(0, start) +
    `<div id="root">${rendered}</div>\n  ` +
    src.slice(marker);
  await writeFile(join(ROOT, file), out);
  console.log(`prerendered ${file}: ${rendered.length} bytes${errors.length ? ' (page errors: ' + errors.join('; ') + ')' : ''}`);
  await page.close();
}

await browser.close();
server.close();
console.log('done');
