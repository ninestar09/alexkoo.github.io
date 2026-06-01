# Default spatial scenes

The INTERACTIVE 3D page auto-loads a scene on refresh.

## Primary default (same origin — Git LFS)

`3D_WEB_VIEW/assets/models/sample_exported.ply` is loaded first when present (recommended: track with **Git LFS** — see `docs/GIT_LFS_SAMPLE_SCENE.md`).

After a successful load, the scene is cached in **IndexedDB** in the browser.

## Google Drive fallback

If the local file is missing or only a Git LFS pointer is served (e.g. some static hosts), the app tries to download from Google Drive:

https://drive.google.com/file/d/15QSTS5HamtzGEi8ChxoGiX1nf15ITDzn/view?usp=drive_link

The Drive file must be shared as **Anyone with the link can view** for that path to work.

## Smaller local fallbacks

If both fail, the viewer tries (in order):

1. `assets/spatial/default.splat`
2. `assets/spatial/default.ply`
3. `assets/spatial/default.ksplat`
4. `assets/spatial/sample.splat`

Supported formats: `.ply`, `.splat`, `.ksplat`

## Browser memory

Once loaded, the scene (including transform settings) is saved in IndexedDB. Use **Load Sample Data** to fetch the default again.
