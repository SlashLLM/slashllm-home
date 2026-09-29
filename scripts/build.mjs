// Static build for slashllm.com → dist/
//
// The page files stay the source of truth: each React page keeps its inline
// <script type="text/babel"> JSX. This script compiles that JSX ahead of time,
// renders every page to HTML with react-dom/server inside a node:vm sandbox (no
// browser needed, so it runs on Vercel), and ships React production builds that
// hydrate the pre-rendered markup. It also emits one page per case study, the
// sitemap, and copies static assets.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { transform } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const SITE = 'https://slashllm.com';
const VENDOR = 'vendor/react-18.3.1';

// Source file → public URL path.
const REACT_PAGES = [
  ['index.html', '/'],
  ['services/index.html', '/services'],
  ['industries/index.html', '/industries'],
  ['about/index.html', '/about'],
  ['products/index.html', '/products'],
  ['solutions/index.html', '/solutions'],
  ['case-studies/index.html', '/case-studies'],
];
const STATIC_PAGES = [
  ['blog/index.html', '/blog'],
  ['blog/from-prompt-to-production-what-it-actually-takes/index.html', '/blog/from-prompt-to-production-what-it-actually-takes'],
];
const STATIC_FILES = ['uploads', 'favicon.ico', 'favicon.png', 'robots.txt', 'llms.txt'];
const EXCLUDED_UPLOADS = ['slashllm_carousel_full_series.html'];

const MOUNT_FROM = "ReactDOM.createRoot(document.getElementById('root')).render(";
const MOUNT_TO = "ReactDOM.hydrateRoot(document.getElementById('root'), ";

const read = (p) => readFile(join(ROOT, p), 'utf8');
const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 10);

async function out(urlPath, html) {
  const file = urlPath === '/' ? 'index.html' : `${urlPath.slice(1)}/index.html`;
  await mkdir(dirname(join(DIST, file)), { recursive: true });
  await writeFile(join(DIST, file), html);
}

function lastmod(src) {
  try {
    return execFileSync('git', ['log', '-1', '--format=%cs', '--', src], { cwd: ROOT, encoding: 'utf8' }).trim() || today();
  } catch {
    return today();
  }
}
const today = () => new Date().toISOString().slice(0, 10);

// ── Compile ────────────────────────────────────────────────────────────────

const BABEL_RE = /<script type="text\/babel">([\s\S]*?)<\/script>/g;
const VENDOR_RE = /\s*<script src="https:\/\/unpkg\.com\/[^"]+"[^>]*><\/script>/g;

async function compilePage(src, html) {
  const blocks = [...html.matchAll(BABEL_RE)].map((m) => m[1]);
  if (!blocks.length) throw new Error(`${src}: no text/babel blocks`);
  const joined = blocks.join('\n;\n');
  if (!joined.includes(MOUNT_FROM)) throw new Error(`${src}: mount call not found`);
  const { code } = await transform(joined.replace(MOUNT_FROM, MOUNT_TO), {
    loader: 'jsx', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment',
    minify: true, target: 'es2019',
  });
  return code;
}

// ── Server render ──────────────────────────────────────────────────────────

const vendorSrc = {
  react: await read(`${VENDOR}/react.production.min.js`),
  server: await read(`${VENDOR}/react-dom-server-legacy.browser.production.min.js`),
};

// Just enough browser surface for the pages' top-level code and render
// functions. Effects never run during renderToString, so they can use the
// real DOM freely on the client.
function createSandbox(pathname, extraGlobals = {}) {
  const noop = () => {};
  const el = () => ({ style: {}, classList: { add: noop, remove: noop }, addEventListener: noop, removeEventListener: noop, appendChild: noop });
  const ctx = {
    console, TextEncoder, setTimeout, clearTimeout, setInterval, clearInterval,
    location: { pathname, hash: '', search: '', href: SITE + pathname },
    navigator: { userAgent: 'node' },
    innerWidth: 1280, innerHeight: 800, scrollY: 0,
    addEventListener: noop, removeEventListener: noop, scrollTo: noop,
    matchMedia: () => ({ matches: false, addListener: noop, removeListener: noop, addEventListener: noop, removeEventListener: noop }),
    document: {
      getElementById: el, querySelector: () => null, querySelectorAll: () => [],
      createElement: el, addEventListener: noop, removeEventListener: noop,
      body: el(), documentElement: el(),
    },
    ...extraGlobals,
  };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(vendorSrc.react, ctx);
  vm.runInContext(vendorSrc.server, ctx);
  let element = null;
  ctx.ReactDOM = { hydrateRoot: (_el, e) => { element = e; }, createRoot: () => ({ render: (e) => { element = e; } }) };
  return { ctx, rendered: () => element };
}

function renderPage(src, code, pathname, extraGlobals) {
  const { ctx, rendered } = createSandbox(pathname, extraGlobals);
  try {
    vm.runInContext(code, ctx, { filename: src });
  } catch (e) {
    throw new Error(`${src} (${pathname}): page script threw during server render: ${e.message}`);
  }
  if (!rendered()) throw new Error(`${src}: no element passed to ReactDOM`);
  const html = ctx.ReactDOMServer.renderToString(rendered());
  if (html.replace(/<[^>]+>/g, '').trim().length < 200) throw new Error(`${src} (${pathname}): rendered almost no text`);
  return { html, ctx };
}

// ── Assemble ───────────────────────────────────────────────────────────────

function assemble(html, { rootHtml, scriptPath, preScript = '' }) {
  const withoutBabel = html.replace(BABEL_RE, '').replace(VENDOR_RE, '');
  const scripts =
    `\n  <script src="/vendor/react.production.min.js" defer></script>` +
    `\n  <script src="/vendor/react-dom.production.min.js" defer></script>` +
    (preScript ? `\n  <script>${preScript}</script>` : '') +
    `\n  <script src="${scriptPath}" defer></script>\n</head>`;
  const root = '<div id="root"></div>';
  if (!withoutBabel.includes(root)) throw new Error('empty #root not found');
  return withoutBabel.replace('</head>', scripts).replace(root, `<div id="root">${rootHtml}</div>`);
}

function setHead(html, { title, description, canonical, jsonLd }) {
  const swap = (re, value) => {
    if (!re.test(html)) throw new Error(`head tag not found: ${re}`);
    html = html.replace(re, value);
  };
  const t = escapeAttr(title), d = escapeAttr(description);
  swap(/<title>[^<]*<\/title>/, `<title>${t}</title>`);
  swap(/<meta name="description"[^>]*>/, `<meta name="description" content="${d}">`);
  swap(/<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${canonical}">`);
  swap(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="${t}">\n  <meta property="og:url" content="${canonical}">\n  <meta property="og:type" content="article">`);
  swap(/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${d}">`);
  return html.replace('</head>', `  <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>\n</head>`);
}

function checkHead(urlPath, html) {
  for (const [name, re] of [
    ['title', /<title>[^<]+<\/title>/],
    ['meta description', /<meta name="description"\s+content="[^"]{50,}"/],
    ['canonical', /<link rel="canonical" href="https:\/\/slashllm\.com[^"]*"/],
  ]) {
    if (!re.test(html)) throw new Error(`${urlPath}: missing ${name}`);
  }
}

// Clip to a sentence-ish boundary within the 160-char meta description limit.
function describe(...parts) {
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (text.length <= 160) return text;
  const cut = text.slice(0, 157);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:.\s]+$/, '') + '…';
}

// ── Main ───────────────────────────────────────────────────────────────────

await rm(DIST, { recursive: true, force: true });
await mkdir(join(DIST, 'assets/js'), { recursive: true });
await mkdir(join(DIST, 'vendor'), { recursive: true });

for (const f of STATIC_FILES) {
  await cp(join(ROOT, f), join(DIST, f), { recursive: true, filter: (p) => !EXCLUDED_UPLOADS.some((x) => p.endsWith(x)) });
}
for (const f of ['react.production.min.js', 'react-dom.production.min.js', 'LICENSE']) {
  await cp(join(ROOT, VENDOR, f), join(DIST, 'vendor', f === 'LICENSE' ? 'react-LICENSE' : f));
}

const sitemap = [];

for (const [src, urlPath] of REACT_PAGES) {
  const html = await read(src);
  const code = await compilePage(src, html);
  const name = urlPath === '/' ? 'home' : urlPath.slice(1).replace(/\//g, '-');
  const scriptPath = `/assets/js/${name}.${hash(code)}.js`;
  await writeFile(join(DIST, scriptPath), code);

  const { html: rootHtml, ctx } = renderPage(src, code, urlPath);
  const page = assemble(html, { rootHtml, scriptPath });
  checkHead(urlPath, page);
  await out(urlPath, page);
  sitemap.push({ loc: urlPath, lastmod: lastmod(src) });
  console.log(`rendered ${urlPath.padEnd(16)} ${(rootHtml.length / 1024).toFixed(0)} KB`);

  // One standalone page per case study, rendered from the same source.
  if (src === 'case-studies/index.html') {
    const studies = vm.runInContext('CASE_STUDIES', ctx);
    for (const cs of studies) {
      const csPath = `/case-studies/${cs.id}`;
      const preScript = `window.__CASE_STUDY_ID__=${JSON.stringify(cs.id)}`;
      const { html: csRoot } = renderPage(src, code, csPath, { __CASE_STUDY_ID__: cs.id });
      const canonical = SITE + csPath;
      // Titles run long ("X & Y"), so keep the leading clause for the <title>.
      const title = `${cs.client}: ${cs.title.split(/ & | – | — /)[0]} | SlashLLM`;
      const description = describe(`${cs.client} case study:`, cs.oneliner);
      let csPage = assemble(html, { rootHtml: csRoot, scriptPath, preScript });
      csPage = setHead(csPage, {
        title, description, canonical,
        jsonLd: {
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'Article',
              headline: cs.title,
              description,
              url: canonical,
              mainEntityOfPage: canonical,
              about: cs.industry,
              keywords: cs.techStack.join(', '),
              author: { '@type': 'Organization', name: 'SlashLLM', url: SITE },
              publisher: { '@type': 'Organization', name: 'SlashLLM', url: SITE, logo: { '@type': 'ImageObject', url: `${SITE}/uploads/LOGO%202.png` } },
            },
            {
              '@type': 'BreadcrumbList',
              itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
                { '@type': 'ListItem', position: 2, name: 'Case Studies', item: `${SITE}/case-studies` },
                { '@type': 'ListItem', position: 3, name: cs.client, item: canonical },
              ],
            },
          ],
        },
      });
      checkHead(csPath, csPage);
      await out(csPath, csPage);
      sitemap.push({ loc: csPath, lastmod: lastmod(src) });
    }
    console.log(`rendered ${studies.length} case study pages`);
  }
}

for (const [src, urlPath] of STATIC_PAGES) {
  const html = await read(src);
  checkHead(urlPath, html);
  await out(urlPath, html);
  sitemap.push({ loc: urlPath, lastmod: lastmod(src) });
}
await writeFile(join(DIST, '404.html'), await read('404.html'));

const priority = (loc) => (loc === '/' ? '1.0' : loc.split('/').length > 2 ? '0.6' : '0.8');
await writeFile(join(DIST, 'sitemap.xml'),
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  sitemap.map(({ loc, lastmod }) =>
    `  <url>\n    <loc>${SITE}${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <priority>${priority(loc)}</priority>\n  </url>`).join('\n') +
  '\n</urlset>\n');

console.log(`sitemap: ${sitemap.length} URLs\ndone → dist/`);
