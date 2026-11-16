# Coven Castles documentation site

This is the standalone static documentation site for Coven Castles, deployed at https://castles.opencoven.ai. Issue [#15](https://github.com/OpenCoven/coven-castles/issues/15) owns `website/**`. It has no provider credentials, backend, sandbox connection or runtime integration. It does not change the operator package's dependencies or root scripts.

## Build and verify

Use Node.js 22 or newer. The website needs no dependency installation.

```sh
cd website
node build.mjs
node --test verify.test.mjs
node --check assets/site.js
node --check assets/theme.js
```

Generated output lives in ignored `dist/`. Serve that directory with any local static HTTP server for rendered checks. Verify desktop and narrow layouts, both themes, keyboard navigation, search, code copy, fragment links, previous/next links and the 404 page before deployment.

## Content contract

`content.mjs` contains the Castles-only pages and exact `sourceRevision`. Links point to the documented source revision, not a moving branch. Refresh the source revision and recheck every claim when adopting new operator behavior. The shared root documentation and CLI remain owned by their existing issue stewards.

`build.mjs` generates seven pages, a real 404, a local search index, sitemap, robots file and a public provenance receipt at `/build.json`. Search is entirely local to the published content. All code blocks are text, not executable playgrounds. `vercel.json` builds and checks the static output without dependency installation.

The tests validate internal links/fragments/assets, expected routes, document titles and the offline/live evidence boundary. They do not substitute for a rendered browser check. The operator suite remains separate and provides fixture evidence only.

## Style provenance

The layout is modeled on [OpenCoven/coven-docs](https://github.com/OpenCoven/coven-docs/tree/b7500de69e3e9b350e928d3c7dd4e1134fabf74c): dark neutral surfaces, violet accents, a 272px sidebar, EB Garamond display headings, Inter body text, JetBrains Mono code, source-contract labels and a section rail. The static implementation is original to this website; it does not copy the reference application's runtime, product manuals, API runner or platform controls.

Latin font files are reused from the reference repository at that revision. Their SIL Open Font License notices are included alongside the assets. The castle mark is an original SVG for this site.

## Deployment

The existing `0xbuns` Vercel team owns `opencoven.ai` and the reference docs project. The separate project is `coven-castles-docs`, using Node 24 with its Git Root Directory set to `website`. The production Git branch is `main`; deployment from a candidate branch must identify its exact commit. The first release can be created from that Git revision through Vercel's deployment API before the website PR merges. A deploy is not review or merge acceptance.

Only generated `website/dist/` is published. Never upload `.env.local`, operator artifacts or another worker's checkout. `website/.gitignore` and `.vercelignore` exclude deployment metadata, environment files and generated local output. With the monorepo Root Directory configured, use the Git integration rather than treating `website/` as a separate standalone repository for a CLI source upload.

The requested custom domain is `castles.opencoven.ai`. Its authoritative DNS is external to Vercel; use the exact DNS target reported for this project/domain. Confirm HTTPS, routes, response headers and `/build.json` at the custom domain after DNS is configured. A working deployment URL alone does not verify the custom domain.
