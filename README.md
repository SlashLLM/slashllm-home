# slashllm-home

Marketing site for [slashllm.com](https://slashllm.com), deployed on Vercel.

## Build

Each page keeps its React code inline as `<script type="text/babel">` JSX. `npm run build` (`scripts/build.mjs`) turns that into a static site in `dist/`:

- compiles the JSX with esbuild and ships React 18 production builds (vendored in `vendor/react-18.3.1/`);
- pre-renders every page to HTML so crawlers get real content, then hydrates it on the client;
- generates one page per case study (`/case-studies/<id>`) from `CASE_STUDIES` in `case-studies/index.html`;
- writes `sitemap.xml` and copies static assets.

To add a page, list its source file in `REACT_PAGES` or `STATIC_PAGES` in `scripts/build.mjs`. Routing, redirects and caching live in `vercel.json`.
