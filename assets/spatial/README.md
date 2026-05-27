# Default spatial scenes

The INTERACTIVE 3D page auto-loads a scene on refresh.

## Primary default (Google Drive)

`sample_exported.ply` is downloaded from Google Drive on first visit:

https://drive.google.com/file/d/15QSTS5HamtzGEi8ChxoGiX1nf15ITDzn/view?usp=drive_link

The file must be shared as **Anyone with the link can view**. After a successful load, the scene is cached in **IndexedDB** so later visits do not re-download.

## Local fallbacks

If the Drive download fails, the viewer tries (in order):

1. `assets/spatial/default.splat`
2. `assets/spatial/default.ply`
3. `assets/spatial/default.ksplat`
4. `assets/spatial/sample.splat`

Supported formats: `.ply`, `.splat`, `.ksplat`

## Browser memory

Once loaded, the scene (including transform settings) is saved in IndexedDB. Use **Load Sample Data** to fetch the Drive file again.
