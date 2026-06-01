# Git LFS for the large sample scene (`punk_room.ply`)

GitHub rejects blobs **larger than ~100 MB** in normal Git. Use **Git Large File Storage (LFS)** so the portfolio can still ship the default Gaussian splat while keeping the repo usable.

The INTERACTIVE 3D page loads the sample from this path first (same origin, no CORS issues):

`3D_WEB_VIEW/assets/models/punk_room.ply`

If that file is missing, invalid, or only an LFS pointer is served, the app tries optional **`<meta name="spatial-sample-url">`** URLs (CORS-safe hosts), then smaller files under `assets/spatial/`. **Google Drive is not used in the browser** — Drive does not send `Access-Control-Allow-Origin`, so `fetch` from your Pages domain always fails.

---

## One-time setup

1. Install [Git LFS](https://git-lfs.com/) and run once per machine:

   ```bash
   git lfs install
   ```

2. This repo already includes `.gitattributes` so that **only** `3D_WEB_VIEW/assets/models/punk_room.ply` is tracked by LFS. If you ever need to re-register it:

   ```bash
   git lfs track "3D_WEB_VIEW/assets/models/punk_room.ply"
   ```

---

## Add the large file and push

1. Put your exported file at exactly:

   `3D_WEB_VIEW/assets/models/punk_room.ply`

2. Stage and commit (LFS replaces the blob with a pointer in Git; the real bytes go to LFS storage):

   ```bash
   git add .gitattributes 3D_WEB_VIEW/assets/models/punk_room.ply
   git commit -m "Add punk_room.ply via Git LFS"
   ```

3. Push (first large push may take a while):

   ```bash
   git push origin HEAD
   ```

4. **Clone on another machine** — pull LFS objects so local preview works:

   ```bash
   git clone <your-repo-url>
   cd alexkoo
   git lfs pull
   ```

   If you already cloned without LFS files:

   ```bash
   git lfs pull
   ```

---

## Preview locally

From the repo root:

```bash
npx serve .
```

Open **INTERACTIVE 3D** (e.g. `http://localhost:3000/interactive3d.html`). The viewer fetches `3D_WEB_VIEW/assets/models/punk_room.ply` over HTTP; with `git lfs pull`, that path is the real `.ply` file.

---

## GitHub Pages and CI

- **Recommended:** enable **GitHub Actions** as the Pages source and use `.github/workflows/github-pages.yml` in this repo. It checks out **with `lfs: true`** and uploads the full tree so `3D_WEB_VIEW/assets/models/punk_room.ply` is the real file on the live site.

- **Pages from a branch / classic upload:** ensure the workflow (or build step) uses **checkout with LFS** so the published site contains the real file, not a pointer:

  ```yaml
  - uses: actions/checkout@v4
    with:
      lfs: true
  ```

- Without that, browsers may download the tiny LFS pointer text instead of the scene; fallbacks under `assets/spatial/` or `<meta name="spatial-sample-url">` apply.

---

## Quotas

GitHub LFS includes limited **storage and bandwidth** on free accounts. If you hit limits, options include: a smaller sample committed under `assets/spatial/`, paid LFS, or hosting the `.ply` on a CORS-enabled URL and pointing `spatial-sample-url` at it.
