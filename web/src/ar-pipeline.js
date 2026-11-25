import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { getTargetPhysicalHeightM } from './config.js';

// XR8.Threejs.pipelineModule() requires global window.THREE
window.THREE = THREE;

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Keeps #camerafeed full-viewport AND matches canvas pixel buffer (width/height)
 * to CSS viewport × DPR so 8th Wall camera feed renders crisp Retina HD with 1:1 aspect ratio.
 */
export function syncCanvasBufferSize(canvas) {
  if (!canvas) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
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
    onVideoSizeChange: resize,
    onDeviceOrientationChange: resize,
    onUpdate: resize,
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
 * Main WebAR scene pipeline:
 * - Image Target lock (`reality.imagefound`) -> hands off Shurale into SLAM world space
 * - Persistent SLAM hold on `reality.imagelost` so user can walk 360° around Shurale
 * - Gentle smooth re-alignment on `reality.imageupdated` when looking back at plaque
 * - Shadow catcher + AO contact shadow at Y = 0
 * - Live recalibration when sliders change in Settings drawer
 */
export function createShuralePipeline({
  getSettings,
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

  let isModelLoaded = false;
  let modelLoadMs = 0;
  let isAnchored = false;
  let isLocked = false;
  let isManualPlaced = false;
  let isTargetVisible = false;
  let isSlamReady = false;
  let lockCount = 0;
  let trackingStatus = 'INITIALIZING';

  const CALIBRATION_FRAMES = 10;
  let poseSamples = [];
  let lockedPlaquePose = null; // { position: Vector3, quaternion: Quaternion, scale: number }
  let lastPlaquePose = null;
  let lastFrameTime = performance.now();
  let fpsAccumulator = 0;
  let fpsFrames = 0;
  let currentFps = 0;
  let lastTelemetryPush = 0;

  // Reusable math temporaries (zero per-frame allocations)
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

  function computeUnitsPerMeter(detailScale, settings) {
    if (!settings.useTargetScaleCalibration) {
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

    // Plaque front normal (+Z in target local space), projected onto horizontal XZ plane
    tmpForward.set(0, 0, 1).applyQuaternion(pose.quaternion);
    tmpForward.y = 0;
    if (tmpForward.lengthSq() < 1e-4) {
      tmpForward.set(0, 0, 1);
    } else {
      tmpForward.normalize();
    }

    // Horizontal RIGHT of plaque from viewer's perspective: worldUp × forward
    tmpRight.crossVectors(WORLD_UP, tmpForward).normalize();

    // World anchor on the ground beside the plaque
    tmpDesiredPos.copy(pose.position)
      .addScaledVector(tmpRight, settings.offsetRightM * unitsPerMeter)
      .addScaledVector(tmpForward, settings.offsetForwardM * unitsPerMeter)
      .addScaledVector(WORLD_UP, -settings.mountHeightM * unitsPerMeter);

    // Shurale faces +Z in his local GLB space -> align to plaque forward + user yaw offset
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
      // Reject sudden single-frame tracking glitches (> 2.5m jump in one frame)
      const jumpDist = shuraleAnchor.position.distanceTo(position);
      if (jumpDist > 2.5 * scale.x) {
        return;
      }
      shuraleAnchor.position.lerp(position, alpha);
      shuraleAnchor.quaternion.slerp(quaternion, alpha);
      shuraleAnchor.scale.lerp(scale, alpha);
    }
  }

  function updatePlaqueOutline(detail) {
    if (!plaqueOutline) return;
    const settings = getSettings();
    plaqueOutline.visible = Boolean(isTargetVisible && settings.showPlaqueDebug);
    if (!detail) return;
    plaqueOutline.position.set(detail.position.x, detail.position.y, detail.position.z);
    plaqueOutline.quaternion.set(detail.rotation.x, detail.rotation.y, detail.rotation.z, detail.rotation.w);
    const s = detail.scale || 1;
    // 8th Wall planar 3:4 portrait target has scaledWidth = 0.75, scaledHeight = 1.0
    const sw = detail.scaledWidth || 0.75;
    const sh = detail.scaledHeight || 1.0;
    plaqueOutline.scale.set(sw * s, sh * s, s);
  }

  function buildSceneObjects() {
    // Configure renderer for crisp PBR + soft shadows
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Winter-friendly ambient + sky/snow hemisphere light
    const hemi = new THREE.HemisphereLight(0xe4f1ff, 0x8ea3b8, 1.35);
    hemi.position.set(0, 6, 0);
    scene.add(hemi);

    // Anchor group that lives in SLAM WORLD coordinates (never parented to transient target)
    shuraleAnchor = new THREE.Group();
    shuraleAnchor.name = 'shurale-world-anchor';
    shuraleAnchor.visible = false;
    scene.add(shuraleAnchor);

    // Directional streetlamp/sun light attached to anchor so shadow frustum stays tight on Shurale
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

    // 1) Real-time Shadow Catcher plane at Y = 0
    const shadowPlaneGeo = new THREE.PlaneGeometry(3.2, 3.2);
    shadowPlaneGeo.rotateX(-Math.PI / 2);
    const shadowPlaneMat = new THREE.ShadowMaterial({ opacity: 0.42 });
    const shadowPlane = new THREE.Mesh(shadowPlaneGeo, shadowPlaneMat);
    shadowPlane.position.y = 0;
    shadowPlane.receiveShadow = true;
    shuraleAnchor.add(shadowPlane);

    // 2) Subtle soft contact AO shadow right under Shurale's feet (works even in dim twilight)
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

    // Debug plaque outline (shows detected 3:4 frame on the wall while visible)
    const edges = new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1));
    const lineMat = new THREE.LineBasicMaterial({ color: 0x22c55e, linewidth: 2 });
    plaqueOutline = new THREE.LineSegments(edges, lineMat);
    plaqueOutline.visible = false;
    scene.add(plaqueOutline);

    // Subtle floor aiming ring shown before Shurale is placed so "Сюда" aiming is effortless
    const ringGeo = new THREE.RingGeometry(0.18, 0.24, 36);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.75,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    floorReticle = new THREE.Mesh(ringGeo, ringMat);
    floorReticle.visible = false;
    scene.add(floorReticle);

    // Load optimized Shurale GLB (1.60 m real-world height, feet at Y = 0)
    const t0 = performance.now();
    const loader = new GLTFLoader();
    onStatusChange?.('loading', 'Загрузка 3D-модели Шурале...');

    loader.load(
      './models/Shurale_Happy_Idle_opt.glb',
      (gltf) => {
        modelLoadMs = Math.round(performance.now() - t0);
        shuraleModel = gltf.scene;
        shuraleModel.traverse((obj) => {
          if (obj.isMesh) {
            obj.castShadow = true;
            obj.receiveShadow = false;
            // Critical for SkinnedMesh: prevent frustum culling pop-out when walking close
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
        if (isAnchored) {
          shuraleAnchor.visible = true;
          onStatusChange?.(
            'slam',
            'Зафиксирован (1,6 м) — обходите на 360°',
          );
        } else if (isSlamReady) {
          onStatusChange?.('searching', 'SLAM готов (1:1 м) — наведи на табличку или «Сюда»');
        } else {
          onStatusChange?.('calibrating', 'Поведите телефоном вбок (~40 см) — калибровка метров');
        }
      },
      (evt) => {
        if (evt.total > 0) {
          const pct = Math.min(99, Math.round((evt.loaded / evt.total) * 100));
          onStatusChange?.('loading', `Загрузка Шурале: ${pct}%`);
        }
      },
      (err) => {
        console.error('Failed to load Shurale GLB:', err);
        onError?.('Ошибка загрузки 3D-модели', 'Не удалось загрузить Shurale_Happy_Idle_opt.glb. Проверьте сеть 4G и обновите страницу.');
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
    // Circular mean for horizontal forward direction (fx, fz)
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

  function recordCalibrationSample(pose) {
    tmpForward.set(0, 0, 1).applyQuaternion(pose.quaternion);
    tmpForward.y = 0;
    if (tmpForward.lengthSq() < 1e-4) {
      tmpForward.set(0, 0, 1);
    } else {
      tmpForward.normalize();
    }
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
    applyPoseToAnchor(medPose, { snap: !isAnchored, alpha: 0.35 });
    isAnchored = true;
    if (isModelLoaded && shuraleAnchor) {
      shuraleAnchor.visible = true;
    }

    if (poseSamples.length >= CALIBRATION_FRAMES) {
      isLocked = true;
      applyPoseToAnchor(medPose, { snap: true });
      onStatusChange?.(
        'slam',
        isModelLoaded ? 'Зафиксирован в комнате — обходите на 360°' : 'Точка зафиксирована, ждём модель...',
      );
    } else {
      onStatusChange?.(
        'tracking',
        `Калибровка по табличке (${poseSamples.length}/${CALIBRATION_FRAMES})...`,
      );
    }
  }

  function handleImageFound({ detail }) {
    isTargetVisible = true;
    lockCount += 1;
    const pose = extractPose(detail);
    lastPlaquePose = pose;
    updatePlaqueOutline(detail);

    // Wait for absolute SLAM to finish metric scale calibration BEFORE locking Shurale,
    // so the world coordinate system won't rescale/jump later!
    if (!isSlamReady && !isAnchored) {
      onStatusChange?.('calibrating', 'Табличка видна — поведите телефоном вбок (~40 см)');
      return;
    }

    if (!isLocked) {
      recordCalibrationSample(pose);
      return;
    }

    // Already HARD-LOCKED in SLAM world: only gently realign if user explicitly enabled it
    const settings = getSettings();
    if (settings.autoRealignOnPlaque) {
      lockedPlaquePose = pose;
      applyPoseToAnchor(pose, { snap: false, alpha: 0.04 });
      onStatusChange?.('tracking', 'Табличка в кадре (мягкое довыравнивание)');
    }
  }

  function handleImageUpdated({ detail }) {
    isTargetVisible = true;
    const pose = extractPose(detail);
    lastPlaquePose = pose;
    updatePlaqueOutline(detail);

    if (!isSlamReady && !isAnchored) {
      return;
    }

    if (!isLocked) {
      recordCalibrationSample(pose);
      return;
    }

    // Hard-locked by default: ignore plaque jitter so Shurale NEVER wanders around the room!
    const settings = getSettings();
    if (settings.autoRealignOnPlaque) {
      lockedPlaquePose = pose;
      applyPoseToAnchor(pose, { snap: false, alpha: 0.04 });
    }
  }

  function handleImageLost() {
    isTargetVisible = false;
    if (plaqueOutline) {
      plaqueOutline.visible = false;
    }
    // CRITICAL: Do NOT hide shuraleAnchor! It remains anchored in SLAM world coordinates.
    if (isLocked) {
      onStatusChange?.('slam', 'Зафиксирован (1,6 м) — обходите на 360°');
    } else if (isAnchored) {
      // User moved camera away before 10 frames finished -> lock immediately on what we have!
      isLocked = true;
      onStatusChange?.('slam', 'Зафиксирован (1,6 м) — обходите на 360°');
    } else if (isSlamReady) {
      onStatusChange?.('searching', 'SLAM готов (1:1 м) — наведи на табличку или «Сюда»');
    } else {
      onStatusChange?.('calibrating', 'Поведите телефоном вбок (~40 см) — калибровка метров');
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
    // Pure SLAM fallback (before scanning plaque): floor is Y = 0, camera started at Y = 1.4
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

    // Fallback when phone is held level/upward: place 1.8 m ahead of camera on the floor
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
      if (!isAnchored && isModelLoaded) {
        onStatusChange?.('searching', 'SLAM готов (1:1 м) — наведи на табличку или «Сюда»');
      }
    }
  }

  const pipelineModule = {
    name: 'shurale-slam-handoff',
    onStart: () => {
      const xrScene = window.XR8.Threejs.xrScene();
      scene = xrScene.scene;
      renderer = xrScene.renderer;
      camera = xrScene.camera;

      // Place initial camera at realistic eye height; absolute SLAM overrides once converged
      camera.position.set(0, 1.4, 0);
      window.XR8.XrController.updateCameraProjectionMatrix({
        origin: camera.position,
        facing: camera.quaternion,
      });

      buildSceneObjects();
    },
    onUpdate: () => {
      const now = performance.now();
      const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
      lastFrameTime = now;

      if (mixer && shuraleAnchor && shuraleAnchor.visible) {
        mixer.update(dt);
      }

      // Show floor aiming ring when camera points at the floor and Shurale is not yet placed
      if (floorReticle && camera) {
        if (!isAnchored) {
          const aim = raycastFloorPoint();
          if (aim && aim.exactRay) {
            floorReticle.position.copy(aim.point);
            floorReticle.position.y += 0.004 * aim.unitsPerMeter;
            floorReticle.scale.setScalar(aim.unitsPerMeter);
            floorReticle.visible = true;
          } else {
            floorReticle.visible = false;
          }
        } else {
          floorReticle.visible = false;
        }
      }

      // Track FPS & push compact telemetry ~4 times/sec
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

        // Compute off-screen direction hint when Shurale is anchored but outside view
        let dirHint = null;
        if (isAnchored && isModelLoaded && camera && shuraleAnchor && shuraleAnchor.visible) {
          camera.updateMatrixWorld();
          tmpCheckPoint.copy(shuraleAnchor.position);
          tmpCheckPoint.y += 0.8 * shuraleAnchor.scale.y; // chest height
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
          isModelLoaded,
          modelLoadMs,
          isAnchored,
          isLocked,
          isSlamReady,
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
    placeHere() {
      if (!shuraleAnchor || !camera) {
        return { ok: false, reason: 'Камера ещё не готова' };
      }
      const aim = raycastFloorPoint();
      if (!aim) {
        return { ok: false, reason: 'Не удалось определить точку на полу' };
      }
      const settings = getSettings();
      const modelScale = settings.modelScale ?? 1.0;

      // Turn Shurale to face the user horizontally
      const yaw = Math.atan2(
        camera.position.x - aim.point.x,
        camera.position.z - aim.point.z,
      ) + THREE.MathUtils.degToRad(settings.yawOffsetDeg);

      shuraleAnchor.position.copy(aim.point);
      shuraleAnchor.quaternion.setFromAxisAngle(WORLD_UP, yaw);
      shuraleAnchor.scale.setScalar(aim.unitsPerMeter * modelScale);

      isAnchored = true;
      isLocked = true;
      isManualPlaced = true;
      if (floorReticle) floorReticle.visible = false;
      if (isModelLoaded) {
        shuraleAnchor.visible = true;
      }

      onStatusChange?.(
        'slam',
        isSlamReady
          ? 'Зафиксирован (1:1 м) — обходите на 360°'
          : 'Поставлен (SLAM ещё калибруется)',
      );
      return {
        ok: true,
        calibratedByPlaque: aim.calibratedByPlaque,
        isSlamReady,
      };
    },
    applySettingsLive() {
      const settings = getSettings();
      if (plaqueOutline) {
        plaqueOutline.visible = Boolean(isTargetVisible && settings.showPlaqueDebug);
      }
      if (isManualPlaced && isAnchored && shuraleAnchor) {
        const { floorY, unitsPerMeter } = getCurrentFloorAndScale();
        const modelScale = settings.modelScale ?? 1.0;
        shuraleAnchor.position.y = floorY;
        shuraleAnchor.scale.setScalar(unitsPerMeter * modelScale);
        return;
      }
      const activePose = lockedPlaquePose || lastPlaquePose;
      if (isAnchored && activePose) {
        applyPoseToAnchor(activePose, { snap: true });
      }
    },
    resetAnchor() {
      isAnchored = false;
      isLocked = false;
      isManualPlaced = false;
      isTargetVisible = false;
      isSlamReady = false;
      trackingStatus = 'INITIALIZING';
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
      onStatusChange?.('calibrating', 'Сброшено — поведите телефоном вбок (~40 см)');
    },
  };
}
