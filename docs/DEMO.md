# The demo site, the link card, and releases

Three build artifacts and three workflows, all of them zero-dependency like everything
else here.

| What | Built by | Where it goes |
|---|---|---|
| `site/index.html` — the live demo | `tools/build-demo.mjs` | GitHub Pages |
| `site/og.png` — the 1200×630 link preview | `tools/make-og.mjs` | GitHub Pages, next to the page |
| the npm package | `.github/workflows/release.yml` | npm, with provenance |

Neither `site/` artifact needs to be committed — Pages rebuilds both on every push to
`main`. `.gitignore` already swallows `site/index.html` via its blanket `*.html` rule;
adding a `site/` line would be tidier, but nothing breaks without it.

---

## 1. Build it locally

```sh
node tools/make-og.mjs       # writes site/og.png   (~125 KB)
node tools/build-demo.mjs    # writes site/index.html (~226 KB)
open site/index.html
```

Both are pure Node with no arguments required. Order matters only in that
`build-demo.mjs` writes the `og:image` *URL*, not the image — it never reads `og.png`,
so you can rebuild either one alone.

### Options

```
node tools/build-demo.mjs [--out site/index.html] [--base-url https://…] [--quiet]
node tools/make-og.mjs    [--out site/og.png] [--seed 36] [--quiet] [--verify]
```

`--base-url` sets the origin used for `og:image`, `og:url` and `<link rel=canonical>`.
It also reads `$CODEPEND_SITE_URL`, and defaults to
`https://shatzibitten.github.io/codepend`. **In CI nothing is hardcoded** — the Pages
workflow passes `steps.pages.outputs.base_url`, which is the real deployed origin
whatever it turns out to be (project path, user page, custom domain).

`--verify` on `make-og.mjs` skips rendering and only re-checks the file already on disk.

---

## 2. The `package.json` scripts block to merge

`package.json` is owned elsewhere, so this has not been applied. Replace the existing
`"scripts"` block with this one — the four existing entries are unchanged, three are new:

```json
  "scripts": {
    "start": "node bin/codepend.js",
    "test": "node --test",
    "lint": "node tools/syntax-check.mjs",
    "check": "npm run lint && npm test",
    "demo": "node tools/make-og.mjs && node tools/build-demo.mjs",
    "demo:og": "node tools/make-og.mjs",
    "demo:page": "node tools/build-demo.mjs"
  },
```

Then `npm run demo` builds both.

> **Also worth a look:** `"files"` currently includes all of `tools/`, so `build-demo.mjs`
> and `make-og.mjs` (~45 KB of build tooling nobody installing the CLI will run) ship
> inside the npm tarball. Narrowing it to `"tools/syntax-check.mjs"` keeps `npx
> codepend` smaller. Not changed here, since `package.json` is not mine to edit.

---

## 3. How Pages deploys

`.github/workflows/pages.yml`, on every push to `main` (and on demand).

1. `actions/configure-pages@v5` → yields the real `base_url`.
2. `node tools/make-og.mjs` then `node tools/build-demo.mjs --base-url <base_url>`.
3. The artifact is sanity-checked: both files non-empty, the demo badge present, an
   `og:image` present.
4. `touch site/.nojekyll`, `actions/upload-pages-artifact@v3`, `actions/deploy-pages@v4`.

Permissions are `pages: write` and `id-token: write`; a `concurrency: pages` group stops
two deploys racing, with `cancel-in-progress: false` so a superseded run finishes rather
than leaving Pages half-updated.

### ⚠️ One-time click, or every run fails

**Settings → Pages → Build and deployment → Source → "GitHub Actions".**

If this is left on "Deploy from a branch", `deploy-pages` fails with a 404 that does not
explain itself. There is no way to set it from a workflow.

`ci.yml` also builds both artifacts on every pull request, so a break is caught on the PR
rather than discovered live — Pages deploys from `main` without review.

---

## 4. Cutting a release (tag → provenance publish)

```sh
# 1. bump the version in package.json  (e.g. 0.1.0 → 0.1.1)
# 2. commit it
git commit -am "v0.1.1"
# 3. tag it — the tag must match package.json exactly, minus the leading v
git tag v0.1.1
git push origin main --tags
```

`.github/workflows/release.yml` then lints, tests, checks the tag against
`package.json`, prints `npm pack --dry-run`, and runs:

```sh
npm publish --provenance --access public
```

A mismatched tag fails the run *before* publishing — npm versions cannot be republished
or meaningfully taken back, so this check is the only thing standing between a typo and a
permanent bad version.

`workflow_dispatch` runs the same job with `dry_run: true` by default: everything except
the publish. Use it to rehearse.

### What provenance needs, and whether it holds

`--provenance` makes npm display a verified link from the published tarball back to this
exact commit and workflow run. Three preconditions:

| Requirement | Status |
|---|---|
| `id-token: write` on the job | ✅ set in `release.yml` |
| `repository` field in `package.json` | ✅ present — `git+https://github.com/shatzibitten/codepend.git` |
| the repository is **public** | ⚠️ **unverified — see below** |

At the time of writing, `gh repo view shatzibitten/codepend` returns *"Could not
resolve to a Repository"* for an account with `repo` scope (which can see private repos).
That means **the repository does not exist yet**. When you create it, **create it
public** — provenance cannot be generated from a private repo, and `npm publish
--provenance` fails outright rather than degrading. `release.yml` checks
`github.event.repository.private` and fails early with a clear message if this is wrong.

### ⚠️ One-time secret

**Settings → Secrets and variables → Actions → New repository secret**

- Name: `NPM_TOKEN`
- Value: an npm **Automation** token (npmjs.com → your avatar → Access Tokens → Generate
  New Token → Classic → **Automation**).

Use Automation, not Publish: automation tokens bypass 2FA, which is what a CI publish
needs. Granular access tokens also work if scoped to the `codepend` package with
read-and-write permission.

`actions/setup-node` is configured with `registry-url: https://registry.npmjs.org`, which
is what writes the `.npmrc` that picks up `NODE_AUTH_TOKEN`. Without that `registry-url`
line the token is silently ignored and the publish 401s.

---

## 5. What the OG card can say

`tools/make-og.mjs` has no font renderer and no dependency that could provide one, so the
glyphs are a **stroke font defined in the file itself** — polylines on a unit em, drawn as
round-capped anti-aliased strokes.

**Bakeable:** `A–Z`, `a–z`, `0–9`, space, and `, . · + - — / : ' ! ? ( ) ×`

**Not bakeable:** anything else. No accents or diacritics, no non-Latin scripts, no
emoji, no smart quotes (`'` and `"`), no `&`, `@`, `#`, `%`, `*`, `=`, `[`, `]`, `_`, `~`,
`<`, `>`, `$`, `|`, `;`, `"`.

Missing glyphs **throw by name** rather than rendering blank — `measure()` collects them
and reports `no glyph for "~"` with the covered set. If you change the copy and the build
fails, that is why. Add the glyph to the `GLYPHS` table (each entry is
`[advanceWidth, ...polylines]`, `y` up, baseline `0`, cap height `1`) or reword.

The four strings live at the top of section 4 in `make-og.mjs`:

```js
const WORDMARK = 'codepend';
const PITCH    = 'YOUR AI AGENT HISTORY, AS A PHOTO ALBUM';
const SUB      = 'CLAUDE CODE + CODEX · RUNS LOCALLY · UPLOADS NOTHING';
const CTA      = 'npx codepend';
```

They are auto-fitted: each line shrinks until it fits an 830px column, so moderately
longer copy will still lay out — it just gets smaller. Keep it short anyway. A link
preview is rendered at roughly 500px wide in a timeline.

There is no kerning, shaping, hinting, bidi or line breaking, and there will not be. It
is a wordmark and two lines of display copy, not a text engine.

### The picture

The background is the `dune` family from `src/art.js` — layered horizons at last light —
**reimplemented directly into the pixel buffer**. `art.js` emits SVG, and rasterising SVG
in Node needs a dependency, so the geometry is rebuilt (same seeded palette via
`_internals.paletteFull`, same sum-of-three-sines ridges, same lightness-only aerial
perspective) rather than rendered.

Everything is deterministic: `--seed 36` in, the same bytes out. Seed 36 lands on the
`sky` hue anchor, which is why the card is the brand blue. Change `--seed` to reroll the
palette and the ridges together.

### The PNG

Hand-encoded: CRC32 + `zlib.deflateSync` over raw RGBA scanlines, each prefixed with
filter byte `0` (None), wrapped in IHDR/IDAT/IEND. Colour type 6, bit depth 8, no
interlacing.

Filter 0 is the specified, auditable choice and it costs real bytes on a smooth gradient —
a Sub or Up filter would compress better. It was not needed: **125 KB against a ~200 KB
budget.**

`make-og.mjs` verifies its own output by reading the file back through `decodePNG()`:
signature, chunk order, **every chunk CRC recomputed and compared**, IHDR dimensions and
fields, the inflated length against `height × (1 + 4 × width)`, a zero filter byte on
every scanline, and that every pixel is fully opaque (a fully transparent image would
otherwise pass every structural check). `ci.yml` re-reads the IHDR independently, so a
truncated file cannot pass both.

---

## 6. Maintainer checklist

- [ ] Create `shatzibitten/codepend` on GitHub — **public** (required for provenance).
- [ ] Settings → Pages → Source = **GitHub Actions**.
- [ ] Settings → Secrets and variables → Actions → add **`NPM_TOKEN`** (npm *Automation* token).
- [ ] Merge the `"scripts"` block from §2 into `package.json`.
- [ ] Push to `main` and confirm the `pages` workflow goes green.
- [ ] Paste the Pages URL into Slack or X and check the card renders — that is the only
      real test of the OG tags.
- [ ] Add the Pages URL to the repo's About → Website field, and to `README.md`.
