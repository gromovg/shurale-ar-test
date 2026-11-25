import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { getTargetPhysicalHeightM } from './config.js';

// XR8.Threejs.pipelineModule() requires global window.THREE
window.THREE = THREE;

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Keeps #camerafeed pixel buffer (width/height) synced to its real full-viewport CSS box × DPR
 * so 8th Wall renders crisp Retina HD with 1:1 aspect ratio.
 *
 * CRITICAL for iOS Safari: XR8.Threejs internally calls renderer.setSize(canvasWidth, canvasHeight)
 * with updateStyle=true, which stamps inline `style="width: 786px; height: 1704px"` (2x screen!)
 * and triggers iOS Safari auto-zoom-out & dark borders. We let CSS `width: 100% !important; height: 100% !important`
 * control display size and strip any inline pixel styles immediately.
 */
export function syncCanvasBufferSize(canvas) {
  if (!canvas) return;
  if (canvas.style.width) canvas.style.width = '';
  if (canvas.style.height) canvas.style.height = '';

  const rect = canvas.getBoundingClientRect();
  const w = Math.round(rect.width || window.visualViewport?.width || window.innerWidth);
  const h = Math.round(rect.height || window.visualViewport?.height || window.innerHeight);
  if (w <= 0 || h <= 0) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
}

export function createFullWindowCanvasModule() {
  let canvas = null;

  const resize = () => syncCanvasBufferSize(canvas);

  return {
    name: 'full-window-canvas',
    onStart: ({ canvas: c }) => {
      canvas = c;
      resize();
      window.addEventListener('resize', resize);
      window.addEventListener('orientationchange', resize);
      window.visualViewport?.addEventListener('resize', resize);
    },
    onCanvasSizeChange: resize,
    onVideoSizeChange: resize,
    onDeviceOrientationChange: resize,
    onUpdate: resize,
    onRender: () => {
      if (!canvas) return;
      if (canvas.style.width) canvas.style.width = '';
      if (canvas.style.height) canvas.style.height = '';
    },
    onDetach: () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('orientationchange', resize);
      window.visualViewport?.removeEventListener('resize', resize);
    },
  };
}

/**
 * Controls device rear flashlight (torch) via MediaStreamTrack.applyConstraints
 * (Android Chrome & iOS 17.5+ Safari).
 */
export function createTorchModule({ onTorchStateChange }) {
  let videoTrack = null;
  let supported = false;
  let isOn = false;

  const inspectTrack = (stream) => {
    if (!stream) return;
    const tracks = stream.getVideoTracks ? stream.getVideoTracks() : [];
    if (!tracks.length) return;
    videoTrack = tracks[0];
    try {
      const caps = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
      supported = Boolean(caps && 'torch' in caps);
    } catch {
      supported = false;
    }
    onTorchStateChange?.({ supported, isOn });
  };

  return {
    name: 'torch-controller',
    onCameraStatusChange: ({ status, stream }) => {
      if (status === 'hasStream' || status === 'hasVideo') {
        inspectTrack(stream);
      }
    },
    async toggle() {
      if (!videoTrack) {
        return { ok: false, reason: 'Камера ещё не активна' };
      }
      const next = !isOn;
      try {
        await videoTrack.applyConstraints({
          advanced: [{ torch: next }],
        });
        isOn = next;
        supported = true;
        onTorchStateChange?.({ supported, isOn });
        return { ok: true, isOn };
      } catch (err) {
        console.warn('Torch constraint failed:', err);
        return {
          ok: false,
          reason: supported
            ? 'Не удалось переключить фонарик'
            : 'Фонарик в браузере не поддерживается на этом устройстве/версии iOS (нужен iOS 17.5+ или Android Chrome)',
        };
      }
    },
    getState() {
      return { supported, isOn };
    },
  };
}

/**
 * Generates a soft radial ambient-occlusion contact shadow texture for Shurale's feet.
 */
function createContactShadowTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size * 0.48);
  grad.addColorStop(0, 'rgba(8, 14, 24, 0.55)');
  grad.addColorStop(0.55, 'rgba(8, 14, 24, 0.22)');
  grad.addColorStop(1, 'rgba(8, 14, 24, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Builds a high-visibility Kyshky Akiyat floor target ring (ink outline + snow ring + crimson dot)
 * that remains clearly legible on both bright snow and indoor floors.
 */
function createFloorReticle() {
  const group = new THREE.Group();

  const outerGeo = new THREE.RingGeometry(0.24, 0.28, 48);
  outerGeo.rotateX(-Math.PI / 2);
  const outerMat = new THREE.MeshBasicMaterial({
    color: 0x0e182a,
    transparent: true,
    opacity: 0.88,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  group.add(new THREE.Mesh(outerGeo, outerMat));

  const mainGeo = new THREE.RingGeometry(0.18, 0.24, 48);
  mainGeo.rotateX(-Math.PI / 2);
  const mainMat = new THREE.MeshBasicMaterial({
    color: 0xf7f6f2,
    transparent: true,
    opacity: 0.96,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  group.add(new THREE.Mesh(mainGeo, mainMat));

  const innerGeo = new THREE.CircleGeometry(0.055, 32);
  innerGeo.rotateX(-Math.PI / 2);
  const innerMat = new THREE.MeshBasicMaterial({
    color: 0xc9382b,
    transparent: true,
    opacity: 0.95,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const innerDot = new THREE.Mesh(innerGeo, innerMat);
  innerDot.position.y = 0.001;
  group.add(innerDot);

  group.visible = false;
  return group;
}

function easeOutBack(t) {
  const c1 = 1.45;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/**
 * Guided 5-stage WebAR pipeline for Shurale ("Кышкы Әкият", Innopolis):
 *   1. loading        -> Load 3D Shurale model
 *   2. calibrating    -> Interactive horizontal pan coaching with live progress bar (waits for SLAM NORMAL)
 *   3. scanning       -> Point camera at the printed A4 plaque (unlocks Shurale & calibrates floorY)
 *   4. ready_to_place -> Live floor aiming reticle + single prominent "Поставить" CTA
 *   5. placed         -> Shurale pops in & locks in SLAM world (360° walk + Photo/Video + "Переставить")
 */
export function createShuralePipeline({
  getSettings,
  imageOnly = false,
  onStageChange,
  onCalibrationProgress,
  onStatusChange,
  onDirectionHint,
  onTelemetry,
  onError,
}) {
  let scene = null;
  let renderer = null;
  let camera = null;

  let shuraleAnchor = null;
  let shuraleModel = null;
  let mixer = null;
  let dirLight = null;
  let plaqueOutline = null;
  let floorReticle = null;

  // Core guided stage machine: 'loading' | 'calibrating' | 'scanning' | 'ready_to_place' | 'placed'
  let stage = 'loading';
  let isRelocating = false;
  let plaqueUnlocked = false;
  let plaqueFoundBannerTimer = null;

  let isModelLoaded = false;
  let modelLoadMs = 0;
  let isAnchored = false;
  let isLocked = false;
  let isManualPlaced = false;
  let isTargetVisible = false;
  let isSlamReady = Boolean(imageOnly);
  let isCaptureMode = false;
  let lockCount = 0;
  let trackingStatus = imageOnly ? 'IMAGE_ONLY' : 'INITIALIZING';

  // Interactive calibration motion tracking
  let motionProgress = 0;       // 0..1 accumulated from real gentle movement
  let displayedCalib = 0;       // smoothed 0..1 sent to UI progress bar
  let calibCompleting = false;  // true once SLAM is NORMAL and bar is finishing to 100%
  let calibDoneTimer = null;
  let highMotionSince = 0;      // safety valve timestamp for featureless snow/walls
  let tooFastUntil = 0;
  let hasPrevCamPose = false;
  const prevCamPos = new THREE.Vector3();
  const prevCamQuat = new THREE.Quaternion();
  let lastDeviceAlpha = null;
  let pendingOrientationDelta = 0;

  // Pop-in spawn animation state
  let popAnimStart = 0;
  let popTargetScale = 1.0;
  let popActive = false;

  // Saved anchor transform for Cancel during relocation
  let savedAnchorState = null;

  const PLAQUE_UNLOCK_FRAMES = 5;
  let poseSamples = [];
  let lockedPlaquePose = null;
  let lastPlaquePose = null;
  let lastFrameTime = performance.now();
  let fpsAccumulator = 0;
  let fpsFrames = 0;
  let currentFps = 0;
  let lastTelemetryPush = 0;
  let lastCalibPush = 0;

  // Reusable math temporaries
  const tmpForward = new THREE.Vector3();
  const tmpRight = new THREE.Vector3();
  const tmpDesiredPos = new THREE.Vector3();
  const tmpDesiredQuat = new THREE.Quaternion();
  const tmpDesiredScale = new THREE.Vector3();
  const tmpCheckPoint = new THREE.Vector3();
  const tmpCamSpace = new THREE.Vector3();
  const tmpCamInv = new THREE.Matrix4();
  const raycaster = new THREE.Raycaster();
  const CENTER_NDC = new THREE.Vector2(0, 0);
  const tmpFloorPlane = new THREE.Plane();
  const tmpHit = new THREE.Vector3();
  const tmpCamDir = new THREE.Vector3();

  // Secondary orientation listener to make calibration bar ultra-responsive on iOS/Android
  // even before XR8 SLAM finishes first position updates
  const handleDeviceOrientation = (ev) => {
    if (stage !== 'calibrating') return;
    if (typeof ev.alpha !== 'number') return;
    if (lastDeviceAlpha != null) {
      let diff = Math.abs(ev.alpha - lastDeviceAlpha);
      if (diff > 180) diff = 360 - diff;
      // Ignore tiny jitter (< 0.25 deg) and huge wrap glitches (> 35 deg)
      if (diff > 0.25 && diff < 35) {
        pendingOrientationDelta += diff;
      }
    }
    lastDeviceAlpha = ev.alpha;
  };

  function emitStage(nextStage, meta = {}) {
    stage = nextStage;
    onStageChange?.(nextStage, {
      imageOnly,
      isRelocating,
      plaqueUnlocked,
      ...meta,
    });
  }

  function computeUnitsPerMeter(detailScale, settings) {
    if (!settings.useTargetScaleCalibration && !imageOnly) {
      return 1.0;
    }
    const physHeightM = getTargetPhysicalHeightM(settings);
    if (!detailScale || detailScale <= 0.001 || physHeightM <= 0.01) {
      return 1.0;
    }
    const ratio = detailScale / physHeightM;
    return THREE.MathUtils.clamp(ratio, 0.15, 8.0);
  }

  function computeDesiredTransform(pose, settings) {
    const unitsPerMeter = computeUnitsPerMeter(pose.scale, settings);

    tmpForward.set(0, 0, 1).applyQuaternion(pose.quaternion);
    tmpForward.y = 0;
    if (tmpForward.lengthSq() < 1e-4) {
      tmpForward.set(0, 0, 1);
    } else {
      tmpForward.normalize();
    }

    tmpRight.crossVectors(WORLD_UP, tmpForward).normalize();

    tmpDesiredPos.copy(pose.position)
      .addScaledVector(tmpRight, settings.offsetRightM * unitsPerMeter)
      .addScaledVector(tmpForward, settings.offsetForwardM * unitsPerMeter)
      .addScaledVector(WORLD_UP, -settings.mountHeightM * unitsPerMeter);

    const baseYaw = Math.atan2(tmpForward.x, tmpForward.z);
    const totalYaw = baseYaw + THREE.MathUtils.degToRad(settings.yawOffsetDeg);
    tmpDesiredQuat.setFromAxisAngle(WORLD_UP, totalYaw);

    const modelScale = settings.modelScale ?? 1.0;
    tmpDesiredScale.setScalar(unitsPerMeter * modelScale);

    return {
      position: tmpDesiredPos,
      quaternion: tmpDesiredQuat,
      scale: tmpDesiredScale,
      unitsPerMeter,
    };
  }

  function applyPoseToAnchor(pose, { snap = false, alpha = 0.08 } = {}) {
    if (!shuraleAnchor || !pose) return;
    const settings = getSettings();
    const { position, quaternion, scale } = computeDesiredTransform(pose, settings);

    if (snap || !isAnchored) {
      shuraleAnchor.position.copy(position);
      shuraleAnchor.quaternion.copy(quaternion);
      shuraleAnchor.scale.copy(scale);
    } else {
      const jumpDist = shuraleAnchor.position.distanceTo(position);
      if (jumpDist > 2.5 * scale.x) return;
      shuraleAnchor.position.lerp(position, alpha);
      shuraleAnchor.quaternion.slerp(quaternion, alpha);
      shuraleAnchor.scale.lerp(scale, alpha);
    }
  }

  function updatePlaqueOutline(detail) {
    if (!plaqueOutline) return;
    const settings = getSettings();
    plaqueOutline.visible = Boolean(
      !isCaptureMode &&
      isTargetVisible &&
      settings.showPlaqueDebug &&
      (stage === 'scanning' || stage === 'placed'),
    );
    if (!detail) return;
    plaqueOutline.position.set(detail.position.x, detail.position.y, detail.position.z);
    plaqueOutline.quaternion.set(detail.rotation.x, detail.rotation.y, detail.rotation.z, detail.rotation.w);
    const s = detail.scale || 1;
    const sw = detail.scaledWidth || 0.75;
    const sh = detail.scaledHeight || 1.0;
    plaqueOutline.scale.set(sw * s, sh * s, s);
  }

  function enterScanningStage() {
    clearTimeout(calibDoneTimer);
    calibDoneTimer = null;
    emitStage('scanning');
    onStatusChange?.('searching', 'Найдите табличку «Кышкы Әкият»');
  }

  function enterReadyToPlaceStage({ relocating = false } = {}) {
    isRelocating = Boolean(relocating);
    if (isRelocating && shuraleAnchor && isAnchored) {
      savedAnchorState = {
        position: shuraleAnchor.position.clone(),
        quaternion: shuraleAnchor.quaternion.clone(),
        scale: shuraleAnchor.scale.clone(),
      };
      // Hide Shurale briefly while choosing the new spot so the floor reticle is crystal clear
      shuraleAnchor.visible = false;
    } else {
      savedAnchorState = null;
    }

    emitStage('ready_to_place', { isRelocating });
    onStatusChange?.(
      'searching',
      isRelocating ? 'Выберите новое место на полу' : 'Наведите круг на пол и нажмите «Поставить»',
    );
  }

  function startCalibrationStage() {
    clearTimeout(calibDoneTimer);
    calibDoneTimer = null;
    motionProgress = 0;
    displayedCalib = 0;
    calibCompleting = false;
    highMotionSince = 0;
    hasPrevCamPose = false;
    lastDeviceAlpha = null;
    pendingOrientationDelta = 0;
    tooFastUntil = 0;

    if (imageOnly) {
      isSlamReady = true;
      enterScanningStage();
      return;
    }

    emitStage('calibrating');
    onStatusChange?.('calibrating', 'Медленно ведите телефон вбок');
    onCalibrationProgress?.({ progress: 0, tooFast: false, done: false });
  }

  function buildSceneObjects() {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const hemi = new THREE.HemisphereLight(0xe4f1ff, 0x8ea3b8, 1.35);
    hemi.position.set(0, 6, 0);
    scene.add(hemi);

    shuraleAnchor = new THREE.Group();
    shuraleAnchor.name = 'shurale-world-anchor';
    shuraleAnchor.visible = false;
    scene.add(shuraleAnchor);

    dirLight = new THREE.DirectionalLight(0xfff4e4, 1.65);
    dirLight.position.set(1.6, 3.6, 2.2);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(1024, 1024);
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 9.0;
    const d = 1.6;
    dirLight.shadow.camera.left = -d;
    dirLight.shadow.camera.right = d;
    dirLight.shadow.camera.top = d;
    dirLight.shadow.camera.bottom = -d;
    dirLight.shadow.bias = -0.0005;
    dirLight.shadow.normalBias = 0.02;
    shuraleAnchor.add(dirLight);
    shuraleAnchor.add(dirLight.target);
    dirLight.target.position.set(0, 0.8, 0);

    const shadowPlaneGeo = new THREE.PlaneGeometry(3.2, 3.2);
    shadowPlaneGeo.rotateX(-Math.PI / 2);
    const shadowPlaneMat = new THREE.ShadowMaterial({ opacity: 0.42 });
    const shadowPlane = new THREE.Mesh(shadowPlaneGeo, shadowPlaneMat);
    shadowPlane.position.y = 0;
    shadowPlane.receiveShadow = true;
    shuraleAnchor.add(shadowPlane);

    const aoGeo = new THREE.PlaneGeometry(0.95, 0.95);
    aoGeo.rotateX(-Math.PI / 2);
    const aoMat = new THREE.MeshBasicMaterial({
      map: createContactShadowTexture(),
      transparent: true,
      depthWrite: false,
      opacity: 0.65,
    });
    const aoMesh = new THREE.Mesh(aoGeo, aoMat);
    aoMesh.position.set(0, 0.002, -0.05);
    shuraleAnchor.add(aoMesh);

    const edges = new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1));
    const lineMat = new THREE.LineBasicMaterial({ color: 0x1e4d4b, linewidth: 2 });
    plaqueOutline = new THREE.LineSegments(edges, lineMat);
    plaqueOutline.visible = false;
    scene.add(plaqueOutline);

    floorReticle = createFloorReticle();
    scene.add(floorReticle);

    const t0 = performance.now();
    const loader = new GLTFLoader();
    emitStage('loading');
    onStatusChange?.('loading', 'Зовём Шурале...');

    loader.load(
      './models/Shurale_Happy_Idle_opt.glb',
      (gltf) => {
        modelLoadMs = Math.round(performance.now() - t0);
        shuraleModel = gltf.scene;
        shuraleModel.traverse((obj) => {
          if (obj.isMesh) {
            obj.castShadow = true;
            obj.receiveShadow = false;
            obj.frustumCulled = false;
          }
        });
        shuraleAnchor.add(shuraleModel);

        if (gltf.animations && gltf.animations.length > 0) {
          mixer = new THREE.AnimationMixer(shuraleModel);
          const clip =
            gltf.animations.find((c) => c.name === 'Happy_Idle') || gltf.animations[0];
          const action = mixer.clipAction(clip);
          action.play();
        }

        isModelLoaded = true;
        if (stage === 'loading') {
          startCalibrationStage();
        } else if (stage === 'placed' && shuraleAnchor) {
          shuraleAnchor.visible = true;
        }
      },
      (evt) => {
        if (evt.total > 0) {
          const pct = Math.min(99, Math.round((evt.loaded / evt.total) * 100));
          onStatusChange?.('loading', `Зовём Шурале: ${pct}%`);
        }
      },
      (err) => {
        console.error('Failed to load Shurale GLB:', err);
        onError?.(
          'Ошибка загрузки 3D-модели',
          'Не удалось загрузить Shurale_Happy_Idle_opt.glb. Проверьте сеть 4G и обновите страницу.',
        );
      },
    );
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5;
  }

  function extractPose(detail) {
    return {
      position: new THREE.Vector3(detail.position.x, detail.position.y, detail.position.z),
      quaternion: new THREE.Quaternion(
        detail.rotation.x,
        detail.rotation.y,
        detail.rotation.z,
        detail.rotation.w,
      ),
      scale: detail.scale || 0.26,
    };
  }

  function computeMedianPose(samples) {
    const mx = median(samples.map((s) => s.x));
    const my = median(samples.map((s) => s.y));
    const mz = median(samples.map((s) => s.z));
    const ms = median(samples.map((s) => s.scale));
    let sumFx = 0;
    let sumFz = 0;
    for (const s of samples) {
      sumFx += s.fx;
      sumFz += s.fz;
    }
    const len = Math.hypot(sumFx, sumFz) || 1;
    const yaw = Math.atan2(sumFx / len, sumFz / len);
    const quat = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, yaw);
    return {
      position: new THREE.Vector3(mx, my, mz),
      quaternion: quat,
      scale: ms,
    };
  }

  function recordPlaqueSample(pose) {
    tmpForward.set(0, 0, 1).applyQuaternion(pose.quaternion);
    tmpForward.y = 0;
    if (tmpForward.lengthSq() < 1e-4) tmpForward.set(0, 0, 1);
    else tmpForward.normalize();

    poseSamples.push({
      x: pose.position.x,
      y: pose.position.y,
      z: pose.position.z,
      fx: tmpForward.x,
      fz: tmpForward.z,
      scale: pose.scale,
    });

    const medPose = computeMedianPose(poseSamples);
    lockedPlaquePose = medPose;

    // In image-only fallback mode (no gyroscope/SLAM), place Shurale directly beside the plaque
    if (imageOnly) {
      applyPoseToAnchor(medPose, { snap: !isAnchored, alpha: 0.28 });
      isAnchored = true;
      isLocked = true;
      plaqueUnlocked = true;
      if (isModelLoaded && shuraleAnchor) shuraleAnchor.visible = true;
      if (stage !== 'placed') {
        emitStage('placed', { canRelocate: false });
        onStatusChange?.('slam', 'Шурале стоит здесь');
      }
      return;
    }

    // Standard SLAM guided flow: scanning plaque unlocks Step 4 (floor reticle + "Поставить" button)
    if (poseSamples.length >= PLAQUE_UNLOCK_FRAMES && !plaqueUnlocked) {
      plaqueUnlocked = true;
      onStatusChange?.('tracking', 'Табличка найдена!');
      emitStage('scanning', { plaqueMatched: true });
      clearTimeout(plaqueFoundBannerTimer);
      plaqueFoundBannerTimer = setTimeout(() => {
        if (stage === 'scanning') {
          enterReadyToPlaceStage({ relocating: false });
        }
      }, 420);
    } else if (!plaqueUnlocked) {
      onStatusChange?.('tracking', 'Узнаём табличку...');
    }
  }

  function handleImageFound({ detail }) {
    isTargetVisible = true;
    lockCount += 1;
    const pose = extractPose(detail);
    lastPlaquePose = pose;
    updatePlaqueOutline(detail);

    if (stage === 'scanning' || (imageOnly && stage === 'placed')) {
      recordPlaqueSample(pose);
    }
  }

  function handleImageUpdated({ detail }) {
    isTargetVisible = true;
    const pose = extractPose(detail);
    lastPlaquePose = pose;
    updatePlaqueOutline(detail);

    if (stage === 'scanning') {
      recordPlaqueSample(pose);
      return;
    }

    if (imageOnly && stage === 'placed') {
      lockedPlaquePose = pose;
      applyPoseToAnchor(pose, { snap: false, alpha: 0.25 });
    }
  }

  function handleImageLost() {
    isTargetVisible = false;
    if (plaqueOutline) plaqueOutline.visible = false;

    if (stage === 'scanning' && poseSamples.length > 0 && !plaqueUnlocked && !imageOnly) {
      // User already scanned plaque briefly before moving phone away -> unlock right away!
      plaqueUnlocked = true;
      enterReadyToPlaceStage({ relocating: false });
    }
  }

  function getCurrentFloorAndScale() {
    const settings = getSettings();
    const activePose = lockedPlaquePose || lastPlaquePose;
    if (activePose) {
      const unitsPerMeter = computeUnitsPerMeter(activePose.scale, settings);
      const floorY = activePose.position.y - settings.mountHeightM * unitsPerMeter;
      return { floorY, unitsPerMeter, calibratedByPlaque: true };
    }
    return { floorY: 0, unitsPerMeter: 1.0, calibratedByPlaque: false };
  }

  function raycastFloorPoint() {
    if (!camera) return null;
    camera.updateMatrixWorld();
    const { floorY, unitsPerMeter, calibratedByPlaque } = getCurrentFloorAndScale();
    tmpFloorPlane.set(WORLD_UP, -floorY);
    raycaster.setFromCamera(CENTER_NDC, camera);
    const hit = raycaster.ray.intersectPlane(tmpFloorPlane, tmpHit);
    const minDist = 0.45 * unitsPerMeter;
    const maxDist = 10.0 * unitsPerMeter;

    if (hit) {
      const dist = camera.position.distanceTo(tmpHit);
      if (dist >= minDist && dist <= maxDist) {
        return { point: tmpHit.clone(), floorY, unitsPerMeter, calibratedByPlaque, exactRay: true };
      }
    }

    camera.getWorldDirection(tmpCamDir);
    tmpCamDir.y = 0;
    if (tmpCamDir.lengthSq() < 1e-4) tmpCamDir.set(0, 0, -1);
    else tmpCamDir.normalize();
    const fallback = camera.position.clone().addScaledVector(tmpCamDir, 1.8 * unitsPerMeter);
    fallback.y = floorY;
    return { point: fallback, floorY, unitsPerMeter, calibratedByPlaque, exactRay: false };
  }

  function handleTrackingStatus({ detail }) {
    if (!detail) return;
    trackingStatus = detail.reason && detail.reason !== 'UNDEFINED'
      ? `${detail.status}/${detail.reason}`
      : (detail.status || 'UNKNOWN');

    if (detail.status === 'NORMAL' && !isSlamReady) {
      isSlamReady = true;
    }
  }

  function updateCalibrationProgress(now, dt) {
    if (stage !== 'calibrating' || !camera) return;

    // Measure live real camera pan (angle + lateral translation + gyro fallback)
    let frameMotion = 0;
    let angSpeed = 0;
    if (hasPrevCamPose && dt > 0.001) {
      const angDelta = camera.quaternion.angleTo(prevCamQuat); // radians
      const posDelta = camera.position.distanceTo(prevCamPos); // meters
      angSpeed = angDelta / dt;

      // Smooth gentle motion fills the bar; violent shaking shows "Чуть медленнее"
      if (angSpeed > 3.5 && angDelta < 1.0) {
        tooFastUntil = now + 800;
        frameMotion += Math.min(angDelta, 0.015) * 0.4;
      } else if (angDelta > 0.0025 || posDelta > 0.002) {
        frameMotion += angDelta * 1.15 + posDelta * 1.8;
      }
    }
    prevCamPos.copy(camera.position);
    prevCamQuat.copy(camera.quaternion);
    hasPrevCamPose = true;

    if (pendingOrientationDelta > 0) {
      const deg = pendingOrientationDelta;
      pendingOrientationDelta = 0;
      const degSpeed = deg / Math.max(dt, 0.016);
      if (degSpeed > 165) {
        tooFastUntil = now + 900;
      } else {
        frameMotion += (deg / 45) * 0.55;
      }
    }

    if (!calibCompleting) {
      // Real movement fills bar up to 88% while waiting for SLAM NORMAL
      motionProgress = Math.min(0.88, motionProgress + frameMotion);

      if (motionProgress >= 0.85 && !highMotionSince) {
        highMotionSince = now;
      }

      // Complete immediately on SLAM NORMAL, or after 4s of sustained motion on featureless white snow
      const snowFallbackReady = highMotionSince > 0 && now - highMotionSince > 4000;
      if (isSlamReady || snowFallbackReady) {
        calibCompleting = true;
      }
    }

    if (calibCompleting) {
      // Zip cleanly to 100% without slow asymptotic crawl near 98%
      displayedCalib = Math.min(1.0, displayedCalib + Math.max((1.0 - displayedCalib) * dt * 6.5, dt * 0.75));
    } else {
      displayedCalib += (motionProgress - displayedCalib) * Math.min(1, dt * 8.5);
    }

    const tooFast = now < tooFastUntil && !calibCompleting;
    const isDone = calibCompleting && displayedCalib >= 1.0;

    if (now - lastCalibPush > 45 || isDone) {
      lastCalibPush = now;
      onCalibrationProgress?.({
        progress: displayedCalib,
        tooFast,
        done: isDone,
      });
    }

    if (isDone && !calibDoneTimer) {
      onStatusChange?.('tracking', 'Готово!');
      calibDoneTimer = setTimeout(() => {
        if (stage === 'calibrating') {
          enterScanningStage();
        }
      }, 340);
    }
  }

  const pipelineModule = {
    name: 'shurale-slam-handoff',
    onStart: () => {
      const xrScene = window.XR8.Threejs.xrScene();
      scene = xrScene.scene;
      renderer = xrScene.renderer;
      camera = xrScene.camera;

      camera.position.set(0, 1.4, 0);
      window.XR8.XrController.updateCameraProjectionMatrix({
        origin: camera.position,
        facing: camera.quaternion,
      });

      window.addEventListener('deviceorientation', handleDeviceOrientation, { passive: true });
      buildSceneObjects();
    },
    onDetach: () => {
      window.removeEventListener('deviceorientation', handleDeviceOrientation);
      clearTimeout(calibDoneTimer);
      clearTimeout(plaqueFoundBannerTimer);
    },
    onUpdate: () => {
      const now = performance.now();
      const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
      lastFrameTime = now;

      if (mixer && shuraleAnchor && shuraleAnchor.visible) {
        mixer.update(dt);
      }

      // Smooth spring pop-in animation when Shurale is placed
      if (popActive && shuraleAnchor) {
        const t = Math.min(1, (now - popAnimStart) / 300);
        const eased = Math.max(0.05, easeOutBack(t));
        shuraleAnchor.scale.setScalar(popTargetScale * eased);
        if (t >= 1) {
          shuraleAnchor.scale.setScalar(popTargetScale);
          popActive = false;
        }
      }

      // Step 2 live motion progress bar
      if (stage === 'calibrating') {
        updateCalibrationProgress(now, dt);
      }

      // Step 4 floor aiming ring (visible ONLY in ready_to_place stage)
      if (floorReticle && camera) {
        if (stage === 'ready_to_place' && !isCaptureMode) {
          const aim = raycastFloorPoint();
          if (aim) {
            floorReticle.position.copy(aim.point);
            floorReticle.position.y += 0.005 * aim.unitsPerMeter;
            const pulse = 1 + Math.sin(now * 0.0055) * 0.06;
            floorReticle.scale.setScalar(aim.unitsPerMeter * pulse);
            floorReticle.visible = true;
          } else {
            floorReticle.visible = false;
          }
        } else {
          floorReticle.visible = false;
        }
      }

      // Track FPS & telemetry
      fpsAccumulator += dt;
      fpsFrames += 1;
      if (fpsAccumulator >= 0.5) {
        currentFps = Math.round(fpsFrames / fpsAccumulator);
        fpsAccumulator = 0;
        fpsFrames = 0;
      }

      if (now - lastTelemetryPush > 200) {
        lastTelemetryPush = now;
        const settings = getSettings();
        const activePose = lockedPlaquePose || lastPlaquePose;
        const uPerM = activePose
          ? computeUnitsPerMeter(activePose.scale, settings)
          : 1.0;
        const camDist =
          isAnchored && camera && shuraleAnchor
            ? camera.position.distanceTo(shuraleAnchor.position) / Math.max(uPerM, 0.01)
            : null;

        let dirHint = null;
        if (
          stage === 'placed' &&
          isAnchored &&
          isModelLoaded &&
          camera &&
          shuraleAnchor &&
          shuraleAnchor.visible
        ) {
          camera.updateMatrixWorld();
          tmpCheckPoint.copy(shuraleAnchor.position);
          tmpCheckPoint.y += 0.8 * shuraleAnchor.scale.y;
          tmpCamInv.copy(camera.matrixWorld).invert();
          tmpCamSpace.copy(tmpCheckPoint).applyMatrix4(tmpCamInv);
          const proj = tmpCheckPoint.clone().project(camera);
          const inFront = tmpCamSpace.z < -0.05;
          const onScreen = inFront && Math.abs(proj.x) <= 0.95 && Math.abs(proj.y) <= 0.95;
          if (!onScreen) {
            const parts = [];
            if (tmpCamSpace.x > 0.12) parts.push('правее →');
            else if (tmpCamSpace.x < -0.12) parts.push('← левее');
            if (tmpCamSpace.y < -0.12) parts.push('ниже ↓');
            else if (tmpCamSpace.y > 0.12) parts.push('выше ↑');
            if (!inFront && !parts.length) parts.push('позади ↺');
            const distLabel = camDist != null ? ` (${camDist.toFixed(1)} м)` : '';
            dirHint = `Шурале: ${parts.join(' ')}${distLabel}`;
          }
        }
        onDirectionHint?.(dirHint);

        onTelemetry?.({
          fps: currentFps,
          stage,
          isModelLoaded,
          modelLoadMs,
          isAnchored,
          isLocked,
          isSlamReady,
          plaqueUnlocked,
          sampleCount: poseSamples.length,
          trackingStatus,
          isTargetVisible,
          lockCount,
          targetScale: activePose ? activePose.scale : null,
          unitsPerMeter: uPerM,
          shuraleScale: shuraleAnchor ? shuraleAnchor.scale.x : 1.0,
          camY: camera ? camera.position.y : null,
          camDistM: camDist,
          anchorPos: isAnchored && shuraleAnchor ? shuraleAnchor.position : null,
        });
      }
    },
    listeners: [
      { event: 'reality.imagefound', process: handleImageFound },
      { event: 'reality.imageupdated', process: handleImageUpdated },
      { event: 'reality.imagelost', process: handleImageLost },
      { event: 'reality.trackingstatus', process: handleTrackingStatus },
    ],
  };

  return {
    pipelineModule,
    getStage: () => stage,
    placeHere() {
      if (!shuraleAnchor || !camera) {
        return { ok: false, reason: 'Камера ещё не готова' };
      }
      const aim = raycastFloorPoint();
      if (!aim) {
        return { ok: false, reason: 'Наведите круг на пол' };
      }
      const settings = getSettings();
      const modelScale = settings.modelScale ?? 1.0;

      const yaw =
        Math.atan2(camera.position.x - aim.point.x, camera.position.z - aim.point.z) +
        THREE.MathUtils.degToRad(settings.yawOffsetDeg);

      shuraleAnchor.position.copy(aim.point);
      shuraleAnchor.quaternion.setFromAxisAngle(WORLD_UP, yaw);

      popTargetScale = aim.unitsPerMeter * modelScale;
      popAnimStart = performance.now();
      popActive = true;
      shuraleAnchor.scale.setScalar(popTargetScale * 0.08);

      isAnchored = true;
      isLocked = true;
      isManualPlaced = true;
      isRelocating = false;
      savedAnchorState = null;
      if (floorReticle) floorReticle.visible = false;
      if (isModelLoaded) {
        shuraleAnchor.visible = true;
      }

      emitStage('placed', { canRelocate: !imageOnly });
      onStatusChange?.('slam', 'Шурале стоит здесь');
      return {
        ok: true,
        calibratedByPlaque: aim.calibratedByPlaque,
        isSlamReady,
      };
    },
    startRelocate() {
      if (imageOnly) {
        return { ok: false, reason: 'В упрощённом режиме Шурале привязан к табличке' };
      }
      enterReadyToPlaceStage({ relocating: true });
      return { ok: true };
    },
    cancelRelocate() {
      if (!isRelocating) return;
      isRelocating = false;
      if (savedAnchorState && shuraleAnchor) {
        shuraleAnchor.position.copy(savedAnchorState.position);
        shuraleAnchor.quaternion.copy(savedAnchorState.quaternion);
        shuraleAnchor.scale.copy(savedAnchorState.scale);
        if (isModelLoaded) shuraleAnchor.visible = true;
      }
      savedAnchorState = null;
      if (floorReticle) floorReticle.visible = false;
      emitStage('placed', { canRelocate: !imageOnly });
      onStatusChange?.('slam', 'Шурале стоит здесь');
    },
    // Hidden dev helper (only reachable from triple-tap dev toolbar) to test without a physical plaque
    devSkipToPlace() {
      isSlamReady = true;
      plaqueUnlocked = true;
      clearTimeout(calibDoneTimer);
      clearTimeout(plaqueFoundBannerTimer);
      enterReadyToPlaceStage({ relocating: false });
    },
    applySettingsLive() {
      const settings = getSettings();
      if (plaqueOutline) {
        plaqueOutline.visible = Boolean(
          !isCaptureMode &&
          isTargetVisible &&
          settings.showPlaqueDebug &&
          (stage === 'scanning' || stage === 'placed'),
        );
      }
      if (isManualPlaced && isAnchored && shuraleAnchor) {
        const { floorY, unitsPerMeter } = getCurrentFloorAndScale();
        const modelScale = settings.modelScale ?? 1.0;
        shuraleAnchor.position.y = floorY;
        popTargetScale = unitsPerMeter * modelScale;
        if (!popActive) {
          shuraleAnchor.scale.setScalar(popTargetScale);
        }
        return;
      }
      const activePose = lockedPlaquePose || lastPlaquePose;
      if (isAnchored && activePose) {
        applyPoseToAnchor(activePose, { snap: true });
      }
    },
    setCaptureMode(active) {
      isCaptureMode = Boolean(active);
      if (isCaptureMode) {
        if (plaqueOutline) plaqueOutline.visible = false;
        if (floorReticle) floorReticle.visible = false;
      } else {
        const settings = getSettings();
        if (plaqueOutline) {
          plaqueOutline.visible = Boolean(
            isTargetVisible &&
            settings.showPlaqueDebug &&
            (stage === 'scanning' || stage === 'placed'),
          );
        }
      }
    },
    resetAnchor() {
      clearTimeout(calibDoneTimer);
      clearTimeout(plaqueFoundBannerTimer);
      calibDoneTimer = null;
      plaqueFoundBannerTimer = null;

      isAnchored = false;
      isLocked = false;
      isManualPlaced = false;
      isRelocating = false;
      plaqueUnlocked = false;
      savedAnchorState = null;
      popActive = false;
      isTargetVisible = false;
      isSlamReady = Boolean(imageOnly);
      trackingStatus = imageOnly ? 'IMAGE_ONLY' : 'INITIALIZING';
      poseSamples = [];
      lockedPlaquePose = null;
      lastPlaquePose = null;
      if (shuraleAnchor) shuraleAnchor.visible = false;
      if (plaqueOutline) plaqueOutline.visible = false;
      if (floorReticle) floorReticle.visible = false;
      try {
        window.XR8?.XrController?.recenter();
      } catch (err) {
        console.warn('recenter warning:', err);
      }
      onDirectionHint?.(null);
      startCalibrationStage();
    },
  };
}
