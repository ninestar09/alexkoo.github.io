/**
 * Spatialograph-style Gaussian splat viewer (portfolio INTERACTIVE 3D page).
 * Powered by @mkkellogg/gaussian-splats-3d — supports .ply, .splat, .ksplat
 */
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import * as THREE from 'three';

const DEFAULT_SCENE_FILE = 'punk_room.ply';
/** Same-origin default when the file is in the repo (e.g. tracked with Git LFS). */
const DEFAULT_SCENE_LOCAL_PATH = '3D_WEB_VIEW/assets/models/punk_room.ply';
/** Optional: comma- or space-separated absolute URLs (e.g. raw.githubusercontent.com) — see assets/spatial/README.md */
const DEFAULT_SCENE_FALLBACK_URLS = [
  'assets/spatial/default.splat',
  'assets/spatial/default.ply',
  'assets/spatial/default.ksplat',
  'assets/spatial/sample.splat',
];
const PREVIEW_SOURCES = {
  'cube-rain': { src: 'cube-rain-embed.html', title: 'Cube Rain' },
  orion: { src: 'orion3d-embed.html', title: 'Orion Preview' },
};

/** Site root (works for /interactive3d SPA paths and /repo/page.html deploys). */
function getSiteBaseUrl() {
  const cssAnchors = [
    'link[href*="assets/css/main.css"]',
    'link[href*="spatial-maker.css"]',
  ];
  for (const selector of cssAnchors) {
    const el = document.querySelector(selector);
    const href = el?.getAttribute('href');
    if (href) {
      return new URL('../../', new URL(href, window.location.href)).href;
    }
  }
  const mainJs = document.querySelector('script[src*="assets/js/main.js"]');
  const jsSrc = mainJs?.getAttribute('src');
  if (jsSrc) {
    return new URL('../../', new URL(jsSrc, window.location.href)).href;
  }
  const { origin, pathname } = window.location;
  if (pathname.endsWith('.html')) {
    return `${origin}${pathname.slice(0, pathname.lastIndexOf('/') + 1)}`;
  }
  return `${origin}/`;
}

function resolveSiteUrl(relativePath) {
  return new URL(relativePath, getSiteBaseUrl()).href;
}

function resolvePreviewUrl(relativePath) {
  return resolveSiteUrl(relativePath);
}
const IDB_NAME = 'spatial-maker';
const IDB_STORE = 'scene';
const IDB_KEY = 'default';
const SUPPORTED_EXT = new Set(['ply', 'splat', 'ksplat']);
const UNSUPPORTED_EXT_MSG = '.sog and .sgp are not supported yet. Use .ply, .splat, or .ksplat.';
const WORLD_UP = new THREE.Vector3(0, 1, 0);
/** Default orbit eye position (world). Paired with {@link DEFAULT_LOOK_AT} and sample transform. */
const DEFAULT_CAMERA_POSITION = new THREE.Vector3(0, 2, 6);
/** Default orbit target (world). */
const DEFAULT_LOOK_AT = new THREE.Vector3(0, 0, 0);
/** View axis from default look-at toward default camera (used for bundled `punk_room` framing). */
const SAMPLE_ORBIT_OFFSET = new THREE.Vector3().subVectors(DEFAULT_CAMERA_POSITION, DEFAULT_LOOK_AT);
const SAMPLE_ORBIT_RADIUS = SAMPLE_ORBIT_OFFSET.length();

let viewer = null;
let viewerStarted = false;
let layers = [];
let activeLayerId = null;
let disposeFns = [];
let threeScene = null;
let gridHelper = null;
let axesHelper = null;
let gridToggleRef = null;
let viewportRef = null;
let persistSceneTimer = null;

function openSceneDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

async function readSceneFromDB() {
  try {
    const db = await openSceneDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function writeSceneToDB(record) {
  const db = await openSceneDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(record, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function isPlyArrayBuffer(data) {
  if (!data || data.byteLength < 64) return false;
  const head = new TextDecoder().decode(new Uint8Array(data, 0, Math.min(16, data.byteLength)));
  return head.startsWith('ply');
}

/** True if the response is a Git LFS pointer (clone without `git lfs pull`, or some CI builds). */
function isGitLfsPointerArrayBuffer(data) {
  if (!data || data.byteLength > 4096) return false;
  const head = new TextDecoder().decode(new Uint8Array(data, 0, data.byteLength));
  return head.includes('git-lfs.github.com/spec');
}

/** Absolute URLs from <meta name="spatial-sample-url" content="..."> (comma/space separated). */
function getMetaSampleUrls() {
  const el = document.querySelector('meta[name="spatial-sample-url"]');
  const raw = el?.getAttribute('content');
  if (!raw?.trim()) return [];
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

function sceneRecordFromFetchedUrl(url, data) {
  const fileName = url.split('/').pop()?.split('?')[0] || 'scene.dat';
  const ext = getExt(fileName);
  if (isGitLfsPointerArrayBuffer(data)) return null;
  if (ext === 'ply') {
    if (!isPlyArrayBuffer(data)) return null;
    return { fileName, data, source: url };
  }
  if (ext === 'splat' || ext === 'ksplat') {
    if (data.byteLength < 32) return null;
    return { fileName, data, source: url };
  }
  return null;
}

async function tryFetchSceneUrl(url) {
  const absolute = /^https?:\/\//i.test(url) ? url : resolveSiteUrl(url);
  try {
    const res = await fetch(absolute, { mode: 'cors' });
    if (!res.ok) return null;
    const data = await res.arrayBuffer();
    return sceneRecordFromFetchedUrl(absolute, data);
  } catch {
    return null;
  }
}

async function fetchBundledDefaultScene() {
  try {
    const res = await fetch(resolveSiteUrl(DEFAULT_SCENE_LOCAL_PATH));
    if (res.ok) {
      const data = await res.arrayBuffer();
      if (isPlyArrayBuffer(data) && !isGitLfsPointerArrayBuffer(data)) {
        return { fileName: DEFAULT_SCENE_FILE, data, source: DEFAULT_SCENE_LOCAL_PATH };
      }
    }
  } catch {
    /* try meta + fallbacks */
  }

  for (const url of getMetaSampleUrls()) {
    const rec = await tryFetchSceneUrl(url);
    if (rec) return rec;
  }

  for (const rel of DEFAULT_SCENE_FALLBACK_URLS) {
    const rec = await tryFetchSceneUrl(resolveSiteUrl(rel));
    if (rec) return rec;
  }
  return null;
}

function getExt(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function formatForExt(ext) {
  const GS = GaussianSplats3D;
  if (ext === 'ply') return GS.SceneFormat.Ply;
  if (ext === 'splat') return GS.SceneFormat.Splat;
  if (ext === 'ksplat') return GS.SceneFormat.KSplat;
  return null;
}

const EULER_ORDER = 'XYZ';

function normalizeDeg(deg) {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return Math.round(d * 100) / 100;
}

function degToQuaternion(degX, degY, degZ) {
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(degX),
    THREE.MathUtils.degToRad(degY),
    THREE.MathUtils.degToRad(degZ),
    EULER_ORDER
  );
  return new THREE.Quaternion().setFromEuler(euler);
}

function quaternionToEulerDeg(qx, qy, qz, qw) {
  const euler = new THREE.Euler().setFromQuaternion(
    new THREE.Quaternion(qx, qy, qz, qw),
    EULER_ORDER
  );
  return [
    normalizeDeg(THREE.MathUtils.radToDeg(euler.x)),
    normalizeDeg(THREE.MathUtils.radToDeg(euler.y)),
    normalizeDeg(THREE.MathUtils.radToDeg(euler.z)),
  ];
}

function defaultTransform() {
  return { position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: [1, 1, 1] };
}

const SAMPLE_DEFAULT_POSITION = [0.05, 1.45, 5];
const SAMPLE_DEFAULT_ROTATION_DEG = [-20, 180, 180];
const SAMPLE_DEFAULT_SCALE = [1, 1, 1];

/** Default layer transform for bundled sample (`punk_room.ply` framing). */
function defaultSampleTransform() {
  return {
    position: [...SAMPLE_DEFAULT_POSITION],
    rotationDeg: [...SAMPLE_DEFAULT_ROTATION_DEG],
    scale: [...SAMPLE_DEFAULT_SCALE],
  };
}

function isDefaultSampleRecord(record) {
  return record?.fileName === DEFAULT_SCENE_FILE;
}

function transformForSampleRecord(record) {
  if (!isDefaultSampleRecord(record)) {
    return record?.transform || defaultTransform();
  }
  const t = record?.transform
    ? {
        position: [...record.transform.position],
        rotationDeg: getRotationDeg(record.transform),
        scale: [...record.transform.scale],
      }
    : defaultSampleTransform();
  t.rotationDeg = t.rotationDeg.map(normalizeDeg);
  return t;
}

function getRotationDeg(transform) {
  if (transform.rotationDeg) {
    return transform.rotationDeg.map(normalizeDeg);
  }
  if (transform.rotation?.length === 4) {
    return quaternionToEulerDeg(
      transform.rotation[0],
      transform.rotation[1],
      transform.rotation[2],
      transform.rotation[3]
    );
  }
  return [0, 0, 0];
}

function transformToQuaternion(transform) {
  const deg = getRotationDeg(transform);
  return degToQuaternion(deg[0], deg[1], deg[2]);
}

function bind(el, event, fn) {
  if (!el) return;
  el.addEventListener(event, fn);
  disposeFns.push(() => el.removeEventListener(event, fn));
}

export function init() {
  const root = document.getElementById('spatial-maker');
  if (!root) return () => {};

  let disposed = false;

  const viewport = document.getElementById('sm-viewport');
  const canvasHost = document.getElementById('sm-canvas-host');
  const layerList = document.getElementById('sm-layer-list');
  const importFileBtn = document.getElementById('sm-import-file');
  const statusEl = document.getElementById('sm-status');
  const gridToggle = document.getElementById('sm-grid');
  viewportRef = viewport;
  gridToggleRef = gridToggle;
  const loadSampleBtn = document.getElementById('sm-load-sample');
  const fileInput = document.getElementById('sm-file-input');
  const previewHost = document.getElementById('sm-preview-host');
  const previewFrame = document.getElementById('sm-preview-frame');
  const previewButtons = root.querySelectorAll('[data-sm-preview]');
  const cubeRainSoundBtn = document.getElementById('sm-cube-rain-sound');
  const cubeRainIntensityEl = document.getElementById('sm-cube-rain-intensity');
  const orionPresetsEl = document.getElementById('sm-orion-presets');
  const pageHeader = document.querySelector('.sm-page-header');
  let activePreview = null;
  let previewLoadHandler = null;
  /** OrbitControls `change` listener: keeps pan target inside scene bounds. */
  let navigationBoundsHandler = null;
  /** Re-fit bounds after progressive splat load expands the mesh AABB. */
  let navigationBoundsProgressTimer = null;

  const tf = {
    px: document.getElementById('sm-pos-x'),
    pxn: document.getElementById('sm-pos-x-n'),
    py: document.getElementById('sm-pos-y'),
    pyn: document.getElementById('sm-pos-y-n'),
    pz: document.getElementById('sm-pos-z'),
    pzn: document.getElementById('sm-pos-z-n'),
    rx: document.getElementById('sm-rot-x'),
    rxn: document.getElementById('sm-rot-x-n'),
    ry: document.getElementById('sm-rot-y'),
    ryn: document.getElementById('sm-rot-y-n'),
    rz: document.getElementById('sm-rot-z'),
    rzn: document.getElementById('sm-rot-z-n'),
    sx: document.getElementById('sm-scale-x'),
    sxn: document.getElementById('sm-scale-x-n'),
    sy: document.getElementById('sm-scale-y'),
    syn: document.getElementById('sm-scale-y-n'),
    sz: document.getElementById('sm-scale-z'),
    szn: document.getElementById('sm-scale-z-n'),
    su: document.getElementById('sm-scale-uniform'),
    sun: document.getElementById('sm-scale-uniform-n'),
  };

  function setStatus(msg, type = '') {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.dataset.type = type;
  }

  function hideDropOverlay() {
    viewport?.classList.add('sm-viewport--active');
  }

  function showDropOverlay() {
    if (layers.length === 0 && !activePreview) {
      viewport?.classList.remove('sm-viewport--active');
    }
  }

  function setPreviewButtonsActive(key) {
    previewButtons.forEach((btn) => {
      btn.classList.toggle('is-active', key != null && btn.dataset.smPreview === key);
    });
  }

  function setCubeRainUiActive(on) {
    viewport?.classList.toggle('sm-viewport--cube-rain', on);
    if (cubeRainSoundBtn) {
      if (on) cubeRainSoundBtn.removeAttribute('hidden');
      else cubeRainSoundBtn.setAttribute('hidden', '');
    }
    if (cubeRainIntensityEl) {
      if (on) cubeRainIntensityEl.removeAttribute('hidden');
      else cubeRainIntensityEl.setAttribute('hidden', '');
    }
    if (!on) {
      cubeRainSoundBtn?.classList.remove('is-active');
      cubeRainSoundBtn?.setAttribute('aria-pressed', 'false');
      viewport?.style.removeProperty('--sm-cube-rain-preview-top');
    } else {
      updateCubeRainPreviewLayout();
    }
  }

  function updateCubeRainPreviewLayout() {
    if (!viewport || !pageHeader || activePreview !== 'cube-rain') return;
    const viewportRect = viewport.getBoundingClientRect();
    const headerRect = pageHeader.getBoundingClientRect();
    const top = Math.max(0, headerRect.bottom - viewportRect.top + 10);
    viewport.style.setProperty('--sm-cube-rain-preview-top', `${top}px`);

    const leftDock = document.querySelector('.sm-dock--left');
    let left = 0;
    if (leftDock) {
      const dockRect = leftDock.getBoundingClientRect();
      left = Math.max(0, dockRect.right - viewportRect.left + 8);
    }
    viewport.style.setProperty('--sm-cube-rain-preview-left', `${left}px`);
  }

  function getCubeRainSoundEnabled() {
    try {
      const doc = previewFrame?.contentDocument;
      const listenBtn = doc?.querySelector('.hudButton');
      if (listenBtn) return listenBtn.classList.contains('active');
      const range = doc?.querySelector('.controlPanel input[type="range"]');
      return range ? Number(range.value) >= 1 : false;
    } catch {
      return false;
    }
  }

  function applyCubeRainSoundUi(on) {
    if (!cubeRainSoundBtn) return;
    cubeRainSoundBtn.classList.toggle('is-active', on);
    cubeRainSoundBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    cubeRainSoundBtn.setAttribute('aria-label', on ? 'Turn sound off' : 'Turn sound on');
    const labelOff = cubeRainSoundBtn.querySelector('.sm-cube-rain-sound__label-off');
    const labelOn = cubeRainSoundBtn.querySelector('.sm-cube-rain-sound__label-on');
    if (labelOff) labelOff.hidden = on;
    if (labelOn) labelOn.hidden = !on;
  }

  function syncCubeRainSoundButton() {
    if (!cubeRainSoundBtn || activePreview !== 'cube-rain') return;
    applyCubeRainSoundUi(getCubeRainSoundEnabled());
  }

  function setCubeRainSound(enabled) {
    try {
      const listenBtn = previewFrame?.contentDocument?.querySelector('.hudButton');
      const isOn = getCubeRainSoundEnabled();
      if (listenBtn && isOn !== enabled) listenBtn.click();
      applyCubeRainSoundUi(enabled);
      requestAnimationFrame(() => applyCubeRainSoundUi(getCubeRainSoundEnabled()));
    } catch {
      /* ignore */
    }
  }

  function toggleCubeRainSound() {
    const wantOn = !cubeRainSoundBtn?.classList.contains('is-active');
    setCubeRainSound(wantOn);
  }

  function getCubeRainIntensity() {
    try {
      const active = previewFrame?.contentDocument?.querySelector('.topControls .topButton.active');
      return active?.textContent?.trim().toLowerCase() || 'light';
    } catch {
      return 'light';
    }
  }

  function applyCubeRainIntensityUi(mode) {
    if (!cubeRainIntensityEl) return;
    cubeRainIntensityEl.querySelectorAll('[data-intensity]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.intensity === mode);
    });
  }

  function setCubeRainIntensity(mode) {
    try {
      const buttons = previewFrame?.contentDocument?.querySelectorAll('.topControls .topButton');
      if (!buttons?.length) return;
      for (const btn of buttons) {
        if (btn.textContent?.trim().toLowerCase() === mode) {
          if (!btn.classList.contains('active')) btn.click();
          applyCubeRainIntensityUi(mode);
          return;
        }
      }
    } catch {
      /* ignore */
    }
  }

  function syncCubeRainIntensityFromIframe() {
    if (!cubeRainIntensityEl || activePreview !== 'cube-rain') return;
    applyCubeRainIntensityUi(getCubeRainIntensity());
  }

  function hidePreview() {
    if (!previewHost || !previewFrame) return;
    if (previewLoadHandler) {
      previewFrame.removeEventListener('load', previewLoadHandler);
      previewLoadHandler = null;
    }
    setCubeRainUiActive(false);
    orionPresetsEl?.setAttribute('hidden', '');
    orionPresetsEl?.querySelectorAll('.sm-orion-preset__btn').forEach((b) => b.classList.remove('is-active'));
    previewHost.hidden = true;
    previewHost.setAttribute('aria-hidden', 'true');
    previewFrame.removeAttribute('src');
    previewFrame.title = '';
    activePreview = null;
    setPreviewButtonsActive(null);
    viewport?.classList.remove('sm-viewport--preview');
  }

  function notifyPreviewResize() {
    const win = previewFrame?.contentWindow;
    if (!win) return;
    const ping = () => win.dispatchEvent(new Event('resize'));
    ping();
    requestAnimationFrame(ping);
    setTimeout(ping, 100);
    setTimeout(ping, 350);
  }

  function previewHasCanvas() {
    try {
      const canvas = previewFrame?.contentDocument?.querySelector('canvas');
      return !!(canvas && canvas.width > 1 && canvas.height > 1);
    } catch {
      return true;
    }
  }

  function showPreview(key) {
    const cfg = PREVIEW_SOURCES[key];
    if (!cfg || !previewHost || !previewFrame) return;
    disposeViewerInstance();
    hidePreview();
    activePreview = key;
    viewport?.classList.add('sm-viewport--active', 'sm-viewport--preview');
    setCubeRainUiActive(key === 'cube-rain');
    orionPresetsEl?.setAttribute('hidden', '');
    orionPresetsEl?.querySelectorAll('.sm-orion-preset__btn').forEach((b) => b.classList.remove('is-active'));
    previewHost.hidden = false;
    previewHost.removeAttribute('aria-hidden');
    previewFrame.title = cfg.title;
    setPreviewButtonsActive(key);
    setStatus(`Loading ${cfg.title}…`, 'loading');

    if (previewLoadHandler) {
      previewFrame.removeEventListener('load', previewLoadHandler);
    }
    previewLoadHandler = () => {
      notifyPreviewResize();
      if (key === 'cube-rain') {
        updateCubeRainPreviewLayout();
        applyCubeRainSoundUi(false);
        previewFrame?.focus();
        setTimeout(() => {
          updateCubeRainPreviewLayout();
          notifyPreviewResize();
          syncCubeRainSoundButton();
          syncCubeRainIntensityFromIframe();
        }, 100);
      }
      if (key === 'orion') {
        orionPresetsEl?.removeAttribute('hidden');
      }
      setStatus(`Showing ${cfg.title}`);
      let checks = 0;
      const verifyLater = () => {
        if (!activePreview || activePreview !== key) return;
        if (previewHasCanvas()) return;
        checks += 1;
        if (checks < 10) {
          setTimeout(verifyLater, 200);
          return;
        }
        setStatus(`${cfg.title} failed to start — try refreshing the page`, 'error');
      };
      setTimeout(verifyLater, 250);
    };
    previewFrame.addEventListener('load', previewLoadHandler);
    previewFrame.removeAttribute('src');

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        previewFrame.src = resolvePreviewUrl(cfg.src);
      });
    });
  }

  function exitPreviewMode() {
    if (!activePreview) return;
    hidePreview();
    if (layers.length) {
      rebuildScenes();
    } else {
      showDropOverlay();
      setStatus('Ready');
    }
  }

  function isGridEnabled() {
    return gridToggleRef ? gridToggleRef.checked : true;
  }

  function createThreeScene() {
    threeScene = new THREE.Scene();
    const gridOn = isGridEnabled();
    gridHelper = new THREE.GridHelper(40, 40, 0x8a9bab, 0x2e3338);
    gridHelper.visible = gridOn;
    axesHelper = new THREE.AxesHelper(8);
    axesHelper.visible = gridOn;
    threeScene.add(gridHelper);
    threeScene.add(axesHelper);
  }

  function syncGridDisplay() {
    const on = isGridEnabled();
    if (gridHelper) gridHelper.visible = on;
    if (axesHelper) axesHelper.visible = on;
    if (viewportRef) {
      const useCssGrid = on && !viewerStarted;
      viewportRef.classList.toggle('sm-viewport--grid', useCssGrid);
    }
  }

  function detachNavigationBoundsListener(v) {
    if (v?.controls && navigationBoundsHandler) {
      v.controls.removeEventListener('change', navigationBoundsHandler);
    }
    navigationBoundsHandler = null;
  }

  function applyOrbitInteractionFlags(v, pan, zoom, rotate, controlsEnabled = true) {
    const apply = (ctrl) => {
      if (!ctrl) return;
      ctrl.enabled = controlsEnabled;
      ctrl.enablePan = pan;
      ctrl.enableZoom = zoom;
      ctrl.enableRotate = rotate;
      ctrl.update();
    };
    apply(v.perspectiveControls);
    apply(v.orthographicControls);
  }

  /** Single visible layer is the bundled punk_room sample. */
  function isBundledPunkRoomOnly() {
    const vis = layers.filter((l) => l.visible);
    return vis.length === 1 && vis[0].name === DEFAULT_SCENE_FILE;
  }

  /**
   * Bundled punk_room: initial pose — camera at world origin, orbit target at splat center (fallback if too near origin).
   * Wide min/max zoom so users can move through the scene; call {@link applyDefaultSampleZoomLimitsFromMesh} later without resetting pose.
   */
  function applyDefaultSampleOrbitFrame(v) {
    if (!v?.splatMesh || !v.controls || !v.camera) return;
    const box = new THREE.Box3().setFromObject(v.splatMesh);
    if (box.isEmpty()) return;
    const meshCenter = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 0.35);
    const worldOrigin = DEFAULT_LOOK_AT.clone();

    let target = meshCenter.clone();
    const r0 = worldOrigin.distanceTo(target);
    if (r0 < 0.12) {
      const lookDir = SAMPLE_ORBIT_OFFSET.clone().normalize();
      target = worldOrigin.clone().add(lookDir.multiplyScalar(Math.max(1.2, maxDim * 0.35)));
    }

    v.camera.up.copy(WORLD_UP);
    v.camera.position.copy(worldOrigin);
    v.camera.lookAt(target);

    applyDefaultSampleZoomLimitsFromMesh(v);

    const syncActive = (ctrl) => {
      if (!ctrl || ctrl.object !== v.camera) return;
      ctrl.target.copy(target);
      ctrl.update();
    };
    syncActive(v.perspectiveControls);
    syncActive(v.orthographicControls);
  }

  /** Updates dolly limits from current splat bounds without moving camera or target. */
  function applyDefaultSampleZoomLimitsFromMesh(v) {
    if (!v?.splatMesh || !v.controls || !v.camera) return;
    const box = new THREE.Box3().setFromObject(v.splatMesh);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 0.35);
    const minD = Math.max(0.04, maxDim * 0.04);
    const maxD = Math.max(minD * 3, maxDim * 25);
    const sync = (ctrl) => {
      if (!ctrl || ctrl.object !== v.camera) return;
      ctrl.minDistance = minD;
      ctrl.maxDistance = maxD;
      ctrl.update();
    };
    sync(v.perspectiveControls);
    sync(v.orthographicControls);
  }

  function installDefaultSampleOrbitControls(v) {
    detachNavigationBoundsListener(v);
    delete v._navBounds;
    delete v._navPivotSnapped;
    applyDefaultSampleOrbitFrame(v);
    applyOrbitInteractionFlags(v, true, true, true, true);
    configureVerticalOrbit(v);
    requestAnimationFrame(() => {
      if (viewer !== v || !isBundledPunkRoomOnly()) return;
      applyDefaultSampleZoomLimitsFromMesh(v);
      configureVerticalOrbit(v);
    });
  }

  function scheduleDefaultSampleOrbitRefresh(vInst) {
    if (navigationBoundsProgressTimer) {
      clearTimeout(navigationBoundsProgressTimer);
      navigationBoundsProgressTimer = null;
    }
    navigationBoundsProgressTimer = setTimeout(() => {
      navigationBoundsProgressTimer = null;
      if (viewer === vInst && isBundledPunkRoomOnly() && vInst?.splatMesh) {
        applyDefaultSampleZoomLimitsFromMesh(vInst);
        configureVerticalOrbit(vInst);
      }
    }, 1800);
  }

  /**
   * Keeps orbit target inside a padded axis-aligned box around the splat mesh and zoom between min/max distance.
   * First call snaps the orbit pivot to the mesh center while preserving the camera→target offset.
   */
  function installNavigationBounds(v, opts = {}) {
    const refreshOnly = !!opts.refreshOnly;
    detachNavigationBoundsListener(v);
    applyOrbitInteractionFlags(v, true, true, true, true);
    if (!v?.splatMesh || !v.controls) return;

    const box = new THREE.Box3().setFromObject(v.splatMesh);
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 0.35);
    const margin = Math.max(maxDim * 0.12, 0.12);
    const half = size.clone().multiplyScalar(0.5).addScalar(margin);
    const minT = center.clone().sub(half);
    const maxT = center.clone().add(half);
    v._navBounds = { minT, maxT, maxDim };

    if (!refreshOnly && !v._navPivotSnapped) {
      const offset = new THREE.Vector3().subVectors(v.camera.position, v.controls.target);
      v.controls.target.copy(center);
      v.camera.position.copy(center).add(offset);
      v._navPivotSnapped = true;
    } else {
      v.controls.target.clamp(minT, maxT);
    }

    const applyZoomLimits = (ctrl) => {
      if (!ctrl) return;
      ctrl.minDistance = Math.max(0.12, maxDim * 0.32);
      ctrl.maxDistance = Math.max(ctrl.minDistance * 1.25, maxDim * 4.2);
      ctrl.target.copy(v.controls.target);
      ctrl.update();
    };
    applyZoomLimits(v.perspectiveControls);
    applyZoomLimits(v.orthographicControls);

    navigationBoundsHandler = () => {
      if (!v.controls || !v._navBounds) return;
      v.controls.target.clamp(v._navBounds.minT, v._navBounds.maxT);
    };
    v.controls.addEventListener('change', navigationBoundsHandler);
    navigationBoundsHandler();
    configureVerticalOrbit(v);
  }

  function scheduleNavigationBoundsRefresh(vInst) {
    if (navigationBoundsProgressTimer) {
      clearTimeout(navigationBoundsProgressTimer);
      navigationBoundsProgressTimer = null;
    }
    navigationBoundsProgressTimer = setTimeout(() => {
      navigationBoundsProgressTimer = null;
      if (viewer === vInst && vInst?.splatMesh) {
        installNavigationBounds(vInst, { refreshOnly: true });
      }
    }, 1800);
  }

  function disposeViewerInstance() {
    if (navigationBoundsProgressTimer) {
      clearTimeout(navigationBoundsProgressTimer);
      navigationBoundsProgressTimer = null;
    }
    if (viewer) {
      detachNavigationBoundsListener(viewer);
      delete viewer._navPivotSnapped;
      delete viewer._navBounds;
      viewer.dispose();
      viewer = null;
    }
    navigationBoundsHandler = null;
    viewerStarted = false;
    threeScene = null;
    gridHelper = null;
    axesHelper = null;
    if (canvasHost) canvasHost.innerHTML = '';
    syncGridDisplay();
  }

  function configureVerticalOrbit(v) {
    if (!v) return;
    const apply = (controls) => {
      if (!controls) return;
      controls.object.up.copy(WORLD_UP);
      controls.maxPolarAngle = Math.PI - 0.08;
      controls.minPolarAngle = 0.08;
      controls.enableDamping = true;
      controls.dampingFactor = 0.05;
      controls.update();
    };
    apply(v.controls);
    apply(v.perspectiveControls);
    apply(v.orthographicControls);
    if (v.camera) {
      v.camera.up.copy(WORLD_UP);
    }
  }

  function resetCameraView(v) {
    if (!v?.camera) return;
    v.camera.up.copy(WORLD_UP);
    v.camera.position.copy(DEFAULT_CAMERA_POSITION);
    if (v.controls) {
      v.controls.target.copy(DEFAULT_LOOK_AT);
      configureVerticalOrbit(v);
    } else {
      v.camera.lookAt(DEFAULT_LOOK_AT);
    }
  }

  function ensureViewer() {
    if (viewer) return viewer;
    if (!threeScene) createThreeScene();
    viewer = new GaussianSplats3D.Viewer({
      rootElement: canvasHost,
      threeScene,
      cameraUp: [0, 1, 0],
      initialCameraPosition: DEFAULT_CAMERA_POSITION.toArray(),
      initialCameraLookAt: DEFAULT_LOOK_AT.toArray(),
      sharedMemoryForWorkers: false,
      gpuAcceleratedSort: false,
      selfDrivenMode: true,
      useBuiltInControls: true,
      dynamicScene: true,
      sceneRevealMode: GaussianSplats3D.SceneRevealMode.Instant,
      logLevel: GaussianSplats3D.LogLevel.None,
    });
    configureVerticalOrbit(viewer);
    syncGridDisplay();
    return viewer;
  }

  async function rebuildScenes() {
    const visible = layers.filter((l) => l.visible);
    if (!visible.length) {
      showDropOverlay();
      setStatus('Ready');
      return;
    }
    hideDropOverlay();
    setStatus('Loading scene…', 'loading');
    try {
      if (viewerStarted) {
        disposeViewerInstance();
      }
      if (!threeScene) createThreeScene();
      const v2 = ensureViewer();
      const scenes = visible.map((layer) => {
        const q = transformToQuaternion(layer.transform);
        return {
          path: layer.url,
          format: layer.format,
          splatAlphaRemovalThreshold: 5,
          progressiveLoad: true,
          position: layer.transform.position,
          rotation: [q.x, q.y, q.z, q.w],
          scale: layer.transform.scale,
        };
      });
      await v2.addSplatScenes(scenes);
      if (!viewerStarted) {
        v2.start();
        viewerStarted = true;
      }
      assignSceneIndices();
      applyAllLayerTransforms();
      if (isBundledPunkRoomOnly()) {
        installDefaultSampleOrbitControls(v2);
        scheduleDefaultSampleOrbitRefresh(v2);
      } else {
        installNavigationBounds(v2);
        scheduleNavigationBoundsRefresh(v2);
      }
      syncGridDisplay();
      setStatus(`${visible.length} layer${visible.length > 1 ? 's' : ''} loaded`);
    } catch (err) {
      console.error(err);
      setStatus('Failed to load scene. Check file format.', 'error');
    }
  }

  function renderLayerList() {
    if (!layerList) return;
    layerList.innerHTML = '';
    if (!layers.length) {
      layerList.innerHTML = '<li class="sm-layer-empty">No layers yet</li>';
      return;
    }
    layers.forEach((layer) => {
      const li = document.createElement('li');
      li.className = 'sm-layer-item' + (layer.id === activeLayerId ? ' is-active' : '');
      li.innerHTML = `
        <button type="button" class="sm-layer-item__select" data-id="${layer.id}">
          <span class="sm-layer-item__dot" aria-hidden="true"></span>
          <span class="sm-layer-item__name">${layer.name}</span>
        </button>
        <label class="sm-layer-item__vis" title="Toggle visibility">
          <input type="checkbox" data-vis="${layer.id}" ${layer.visible ? 'checked' : ''}>
          <i class="bi bi-eye${layer.visible ? '' : '-slash'}"></i>
        </label>
        <button type="button" class="sm-layer-item__remove" data-remove="${layer.id}" aria-label="Remove layer">
          <i class="bi bi-x-lg"></i>
        </button>
      `;
      layerList.appendChild(li);
    });

    layerList.querySelectorAll('.sm-layer-item__select').forEach((btn) => {
      bind(btn, 'click', () => selectLayer(btn.dataset.id));
    });
    layerList.querySelectorAll('[data-vis]').forEach((input) => {
      bind(input, 'change', () => {
        const layer = layers.find((l) => l.id === input.dataset.vis);
        if (layer) {
          layer.visible = input.checked;
          rebuildScenes();
        }
      });
    });
    layerList.querySelectorAll('[data-remove]').forEach((btn) => {
      bind(btn, 'click', () => removeLayer(btn.dataset.remove));
    });
  }

  function setFieldPair(range, number, value) {
    const str = String(value);
    if (range) range.value = str;
    if (number) number.value = str;
  }

  function fillTransformInputs(t) {
    if (!t) return;
    setFieldPair(tf.px, tf.pxn, t.position[0]);
    setFieldPair(tf.py, tf.pyn, t.position[1]);
    setFieldPair(tf.pz, tf.pzn, t.position[2]);
    const rot = getRotationDeg(t);
    setFieldPair(tf.rx, tf.rxn, rot[0]);
    setFieldPair(tf.ry, tf.ryn, rot[1]);
    setFieldPair(tf.rz, tf.rzn, rot[2]);
    const s = t.scale[0];
    setFieldPair(tf.sx, tf.sxn, t.scale[0]);
    setFieldPair(tf.sy, tf.syn, t.scale[1]);
    setFieldPair(tf.sz, tf.szn, t.scale[2]);
    setFieldPair(tf.su, tf.sun, s);
  }

  function readTransformInputs() {
    const u = parseFloat(tf.su?.value ?? tf.sun?.value) || 1;
    const rotationDeg = [
      normalizeDeg(parseFloat(tf.rx?.value ?? tf.rxn?.value) || 0),
      normalizeDeg(parseFloat(tf.ry?.value ?? tf.ryn?.value) || 0),
      normalizeDeg(parseFloat(tf.rz?.value ?? tf.rzn?.value) || 0),
    ];
    const q = degToQuaternion(rotationDeg[0], rotationDeg[1], rotationDeg[2]);
    return {
      position: [
        parseFloat(tf.px?.value ?? tf.pxn?.value) || 0,
        parseFloat(tf.py?.value ?? tf.pyn?.value) || 0,
        parseFloat(tf.pz?.value ?? tf.pzn?.value) || 0,
      ],
      rotationDeg,
      rotation: [q.x, q.y, q.z, q.w],
      scale: [
        parseFloat(tf.sx?.value ?? tf.sxn?.value) || u,
        parseFloat(tf.sy?.value ?? tf.syn?.value) || u,
        parseFloat(tf.sz?.value ?? tf.szn?.value) || u,
      ],
    };
  }

  function assignSceneIndices() {
    const visible = layers.filter((l) => l.visible);
    visible.forEach((layer, index) => {
      layer.sceneIndex = index;
    });
    layers.filter((l) => !l.visible).forEach((layer) => {
      layer.sceneIndex = undefined;
    });
  }

  function applyLayerTransform(layer) {
    if (!viewer?.splatMesh || layer.sceneIndex == null) return;
    const scene = viewer.splatMesh.getScene(layer.sceneIndex);
    if (!scene) return;
    const t = layer.transform;
    const q = transformToQuaternion(t);
    scene.position.set(t.position[0], t.position[1], t.position[2]);
    scene.quaternion.copy(q);
    scene.scale.set(t.scale[0], t.scale[1], t.scale[2]);
    scene.updateTransform(true);
    viewer.splatMesh.updateTransforms();
    t.rotation = [q.x, q.y, q.z, q.w];
    t.rotationDeg = getRotationDeg(t);
  }

  function applyAllLayerTransforms() {
    layers.filter((l) => l.visible && l.sceneIndex != null).forEach(applyLayerTransform);
  }

  function applyActiveTransformLive() {
    const layer = layers.find((l) => l.id === activeLayerId);
    if (!layer || !viewerStarted) return;
    layer.transform = readTransformInputs();
    applyLayerTransform(layer);
    fillTransformInputs(layer.transform);
    if (isBundledPunkRoomOnly() && viewer?.splatMesh) {
      applyDefaultSampleZoomLimitsFromMesh(viewer);
    }
    schedulePersistScene();
  }

  function syncLayerTransformFromScene(layer) {
    if (!layer || !viewer?.splatMesh || layer.sceneIndex == null) return;
    const scene = viewer.splatMesh.getScene(layer.sceneIndex);
    if (!scene) return;
    layer.transform.position = [scene.position.x, scene.position.y, scene.position.z];
    layer.transform.scale = [scene.scale.x, scene.scale.y, scene.scale.z];
    layer.transform.rotation = [
      scene.quaternion.x,
      scene.quaternion.y,
      scene.quaternion.z,
      scene.quaternion.w,
    ];
    layer.transform.rotationDeg = quaternionToEulerDeg(
      scene.quaternion.x,
      scene.quaternion.y,
      scene.quaternion.z,
      scene.quaternion.w
    );
  }

  function selectLayer(id) {
    activeLayerId = id;
    const layer = layers.find((l) => l.id === id);
    if (layer && viewerStarted) syncLayerTransformFromScene(layer);
    if (layer) fillTransformInputs(layer.transform);
    renderLayerList();
  }

  function removeLayer(id) {
    const layer = layers.find((l) => l.id === id);
    if (layer?.url?.startsWith('blob:')) URL.revokeObjectURL(layer.url);
    layers = layers.filter((l) => l.id !== id);
    if (activeLayerId === id) activeLayerId = layers[0]?.id || null;
    if (activeLayerId) fillTransformInputs(layers.find((l) => l.id === activeLayerId).transform);
    renderLayerList();
    if (layers.length) rebuildScenes();
    else {
      disposeViewerInstance();
      showDropOverlay();
      setStatus('Ready');
    }
  }

  async function importSceneRecord(record, statusMsg) {
    const ext = getExt(record.fileName);
    const format = formatForExt(ext);
    if (!format) {
      setStatus(`Unsupported file: ${record.fileName}`, 'error');
      return false;
    }
    const blob = new Blob([record.data]);
    const url = URL.createObjectURL(blob);
    const transform = record.transform
      ? {
          position: [...record.transform.position],
          rotationDeg: record.transform.rotationDeg
            ? [...record.transform.rotationDeg]
            : getRotationDeg(record.transform),
          scale: [...record.transform.scale],
        }
      : defaultTransform();

    layers.forEach((l) => {
      if (l.url?.startsWith('blob:')) URL.revokeObjectURL(l.url);
    });
    const id = crypto.randomUUID();
    layers = [{
      id,
      name: record.fileName,
      url,
      format,
      visible: true,
      transform,
    }];
    activeLayerId = id;
    fillTransformInputs(transform);
    renderLayerList();
    await rebuildScenes();
    if (statusMsg) setStatus(statusMsg);
    return true;
  }

  async function persistCurrentScene() {
    const layer = layers.find((l) => l.id === activeLayerId) || layers[0];
    if (!layer?.url) return;
    try {
      const res = await fetch(layer.url);
      const data = await res.arrayBuffer();
      await writeSceneToDB({
        fileName: layer.name,
        data,
        transform: {
          position: [...layer.transform.position],
          rotationDeg: getRotationDeg(layer.transform),
          scale: [...layer.transform.scale],
        },
        savedAt: Date.now(),
      });
    } catch (err) {
      console.warn('Could not persist scene', err);
    }
  }

  function schedulePersistScene() {
    if (persistSceneTimer) clearTimeout(persistSceneTimer);
    persistSceneTimer = setTimeout(() => {
      persistSceneTimer = null;
      persistCurrentScene();
    }, 400);
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    exitPreviewMode();
    const file = files[files.length - 1];
    const ext = getExt(file.name);
    if (ext === 'sog' || ext === 'sgp') {
      setStatus(UNSUPPORTED_EXT_MSG, 'error');
      return;
    }
    if (!formatForExt(ext)) {
      setStatus(`Unsupported file: ${file.name}`, 'error');
      return;
    }
    const data = await file.arrayBuffer();
    const ok = await importSceneRecord(
      { fileName: file.name, data, transform: defaultTransform() },
      `Loaded ${file.name}`
    );
    if (ok) await persistCurrentScene();
  }

  async function loadDefaultSceneOnInit() {
    if (disposed) return;
    setStatus('Loading default scene…', 'loading');
    try {
      const cached = await readSceneFromDB();
      if (cached?.data && cached.fileName === DEFAULT_SCENE_FILE) {
        const ok = await importSceneRecord(
          { ...cached, transform: transformForSampleRecord(cached) },
          `Loaded ${cached.fileName}`
        );
        if (ok) return;
      }
      setStatus('Downloading sample scene…', 'loading');
      const bundled = await fetchBundledDefaultScene();
      if (bundled) {
        const ok = await importSceneRecord(
          { fileName: bundled.fileName, data: bundled.data, transform: defaultSampleTransform() },
          `Loaded ${bundled.fileName}`
        );
        if (ok) {
          await persistCurrentScene();
          return;
        }
      }
      setStatus('Ready');
    } catch (err) {
      console.error(err);
      setStatus(
        'Could not load sample scene. Deploy the .ply with Git LFS on Pages, add assets/spatial/*.ply, set meta spatial-sample-url, or use Import file.',
        'error'
      );
    }
  }

  function setupPanels() {
    root.querySelectorAll('[data-sm-panel-toggle]').forEach((head) => {
      bind(head, 'click', () => {
        const panel = head.closest('.sm-panel');
        if (!panel) return;
        const open = panel.classList.toggle('sm-panel--open');
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
        const body = panel.querySelector('.sm-panel__body');
        body?.classList.toggle('sm-panel__body--collapsed', !open);
      });
    });
  }

  function setupDragDrop() {
    const onDrag = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((ev) => {
      bind(viewport, ev, onDrag);
    });
    bind(viewport, 'drop', (e) => {
      addFiles(e.dataTransfer?.files);
    });
    bind(importFileBtn, 'click', () => fileInput?.click());
    bind(fileInput, 'change', () => {
      addFiles(fileInput.files);
      fileInput.value = '';
    });
  }

  function clampToInput(el, value) {
    const min = el.min !== '' ? parseFloat(el.min) : -Infinity;
    const max = el.max !== '' ? parseFloat(el.max) : Infinity;
    return Math.min(max, Math.max(min, value));
  }

  function linkRangeNumber(range, number, onChange) {
    if (!range || !number) return;
    const syncFromRange = () => {
      number.value = range.value;
      onChange();
    };
    const syncFromNumber = () => {
      const v = clampToInput(range, parseFloat(number.value) || 0);
      range.value = v;
      number.value = v;
      onChange();
    };
    bind(range, 'input', syncFromRange);
    bind(number, 'input', syncFromNumber);
    bind(number, 'change', syncFromNumber);
  }

  function setupTransform() {
    const live = () => applyActiveTransformLive();

    linkRangeNumber(tf.px, tf.pxn, live);
    linkRangeNumber(tf.py, tf.pyn, live);
    linkRangeNumber(tf.pz, tf.pzn, live);
    linkRangeNumber(tf.rx, tf.rxn, live);
    linkRangeNumber(tf.ry, tf.ryn, live);
    linkRangeNumber(tf.rz, tf.rzn, live);
    linkRangeNumber(tf.sx, tf.sxn, live);
    linkRangeNumber(tf.sy, tf.syn, live);
    linkRangeNumber(tf.sz, tf.szn, live);

    const syncUniform = () => {
      const v = clampToInput(tf.su, parseFloat(tf.su?.value ?? tf.sun?.value) || 1);
      setFieldPair(tf.su, tf.sun, v);
      setFieldPair(tf.sx, tf.sxn, v);
      setFieldPair(tf.sy, tf.syn, v);
      setFieldPair(tf.sz, tf.szn, v);
      live();
    };
    if (tf.su) bind(tf.su, 'input', syncUniform);
    if (tf.sun) {
      bind(tf.sun, 'input', syncUniform);
      bind(tf.sun, 'change', syncUniform);
    }
  }

  previewButtons.forEach((btn) => {
    bind(btn, 'click', () => {
      const key = btn.dataset.smPreview;
      if (activePreview === key) return;
      showPreview(key);
    });
  });

  bind(cubeRainSoundBtn, 'click', toggleCubeRainSound);
  cubeRainIntensityEl?.querySelectorAll('[data-intensity]').forEach((btn) => {
    bind(btn, 'click', () => {
      if (activePreview !== 'cube-rain') return;
      setCubeRainIntensity(btn.dataset.intensity);
    });
  });
  bind(window, 'resize', () => {
    if (activePreview === 'cube-rain') updateCubeRainPreviewLayout();
  });

  function postOrionPartPreset(part) {
    try {
      previewFrame?.contentWindow?.postMessage({ type: 'alexkoo-orion-preset', part }, '*');
    } catch {
      /* ignore */
    }
  }

  orionPresetsEl?.querySelectorAll('[data-orion-preset]').forEach((btn) => {
    bind(btn, 'click', () => {
      if (activePreview !== 'orion') return;
      const part = btn.dataset.orionPreset;
      if (!part) return;
      const turningOff = btn.classList.contains('is-active');
      orionPresetsEl.querySelectorAll('.sm-orion-preset__btn').forEach((b) => b.classList.remove('is-active'));
      if (!turningOff) btn.classList.add('is-active');
      postOrionPartPreset(part);
    });
  });

  bind(loadSampleBtn, 'click', async () => {
    exitPreviewMode();
    setStatus('Downloading sample scene…', 'loading');
    try {
      const bundled = await fetchBundledDefaultScene();
      if (!bundled) {
        setStatus(
          'Sample scene not found on this host. Use Import file, deploy LFS asset, or set meta spatial-sample-url (see docs).',
          'error'
        );
        return;
      }
      const ok = await importSceneRecord(
        { fileName: bundled.fileName, data: bundled.data, transform: defaultSampleTransform() },
        `Loaded ${bundled.fileName}`
      );
      if (ok) await persistCurrentScene();
    } catch {
      setStatus('Could not load default scene file', 'error');
    }
  });

  setupPanels();
  setupDragDrop();
  setupTransform();
  renderLayerList();
  syncGridDisplay();
  loadDefaultSceneOnInit();

  return () => {
    disposed = true;
    if (persistSceneTimer) {
      clearTimeout(persistSceneTimer);
      persistSceneTimer = null;
    }
    disposeFns.forEach((fn) => fn());
    disposeFns = [];
    layers.forEach((l) => {
      if (l.url?.startsWith('blob:')) URL.revokeObjectURL(l.url);
    });
    layers = [];
    hidePreview();
    disposeViewerInstance();
    viewportRef = null;
    gridToggleRef = null;
  };
}

