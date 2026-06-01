# Default spatial scenes

The INTERACTIVE 3D page auto-loads a scene on refresh.

## Primary default (same origin — Git LFS)

`3D_WEB_VIEW/assets/models/punk_room.ply` is loaded first when present (recommended: track with **Git LFS** — see `docs/GIT_LFS_SAMPLE_SCENE.md`).

After a successful load, the scene is cached in **IndexedDB** in the browser.

**GitHub Pages:** browsers cannot load the sample from Google Drive via `fetch` (CORS). Deploy the real file with **LFS checkout** — use `.github/workflows/github-pages.yml` in this repo (Pages source: *GitHub Actions*) or ensure your build step runs `actions/checkout` with `lfs: true`.

## Optional cross-origin URL (CORS-safe hosts only)

If the same-origin `.ply` is missing but the file is hosted where `fetch` is allowed (e.g. `raw.githubusercontent.com` for a **public** repo, or your own CDN), add to the page `<head>`:

```html
<meta name="spatial-sample-url" content="https://raw.githubusercontent.com/USER/REPO/BRANCH/3D_WEB_VIEW/assets/models/punk_room.ply">
```

You can list several URLs separated by commas or spaces; the first that returns valid data wins.

## Smaller local fallbacks

If the primary path and meta URLs fail, the viewer tries (in order):

1. `assets/spatial/default.splat`
2. `assets/spatial/default.ply`
3. `assets/spatial/default.ksplat`
4. `assets/spatial/sample.splat`

Supported formats: `.ply`, `.splat`, `.ksplat`

## Browser memory

Once loaded, the scene (including transform settings) is saved in IndexedDB. Use **Load Sample Data** to fetch the default again.
