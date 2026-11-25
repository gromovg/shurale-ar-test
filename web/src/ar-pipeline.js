import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { getTargetPhysicalHeightM } from './config.js';

// XR8.Threejs.pipelineModule() requires global window.THREE
window.THREE = THREE;

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Keeps #camerafeed full-viewport across iOS Safari dynamic toolbars & orientation changes.
 */
export function createFullWindowCanvasModule() {
  let canvas = null;

  const resize = () => {
    if (!canvas) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  };

  return {
    name: 'full-window-canvas',
    onStart: ({ canvas: c }) => {
      canvas = c;
      resize();
      window.addEventListener('resize', resize);
      window.addEventListener('orientationchange', resize);
    },
    onDeviceOrientationChange: resize,
    onDetach: () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('orientationchange', resize);
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

  let isModelLoaded = false;
  let modelLoadMs = 0;
  let isAnchored = false;
  let isTargetVisible = false;
  let firstLockTimestamp = 0;
  let lockCount = 0;

  let lastPlaquePose = null; // { position: Vector3, quaternion: Quaternion, scale: number }
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

    tmpDesiredScale.setScalar(unitsPerMeter);

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
            isTargetVisible ? 'tracking' : 'slam',
            isTargetVisible
              ? 'Табличка в кадре — Шурале на земле'
              : 'SLAM-удержание — обходите на 360°',
          );
        } else {
          onStatusChange?.('searching', 'Наведите камеру на табличку А4');
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

  function handleImageFound({ detail }) {
    isTargetVisible = true;
    lockCount += 1;

    const pose = {
      position: new THREE.Vector3(detail.position.x, detail.position.y, detail.position.z),
      quaternion: new THREE.Quaternion(
        detail.rotation.x,
        detail.rotation.y,
        detail.rotation.z,
        detail.rotation.w,
      ),
      scale: detail.scale || 0.26,
    };
    lastPlaquePose = pose;
    updatePlaqueOutline(detail);

    if (!isAnchored) {
      // First lock: snap immediately onto the ground beside the plaque in SLAM world space
      firstLockTimestamp = performance.now();
      applyPoseToAnchor(pose, { snap: true });
      isAnchored = true;
      if (isModelLoaded) {
        shuraleAnchor.visible = true;
      }
    } else {
      // Re-acquired plaque after walking around: gentle smooth re-alignment
      applyPoseToAnchor(pose, { snap: false, alpha: 0.12 });
    }

    onStatusChange?.(
      'tracking',
      isModelLoaded ? 'Табличка в кадре (довыравнивание)' : 'Табличка найдена, ждём модель...',
    );
  }

  function handleImageUpdated({ detail }) {
    isTargetVisible = true;
    const pose = {
      position: new THREE.Vector3(detail.position.x, detail.position.y, detail.position.z),
      quaternion: new THREE.Quaternion(
        detail.rotation.x,
        detail.rotation.y,
        detail.rotation.z,
        detail.rotation.w,
      ),
      scale: detail.scale || 0.26,
    };
    lastPlaquePose = pose;
    updatePlaqueOutline(detail);

    const elapsedSinceFirstLock = performance.now() - firstLockTimestamp;
    // Fast initial settle (first 1s), then gentle smooth re-alignment
    const alpha = elapsedSinceFirstLock < 1000 ? 0.25 : 0.08;
    applyPoseToAnchor(pose, { snap: false, alpha });
  }

  function handleImageLost() {
    isTargetVisible = false;
    if (plaqueOutline) {
      plaqueOutline.visible = false;
    }
    // CRITICAL: Do NOT hide shuraleAnchor! It remains anchored in SLAM world coordinates.
    if (isAnchored) {
      onStatusChange?.('slam', 'SLAM-удержание — обходите на 360°');
    } else {
      onStatusChange?.('searching', 'Наведите камеру на табличку А4');
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

      // Track FPS & push compact telemetry ~4 times/sec
      fpsAccumulator += dt;
      fpsFrames += 1;
      if (fpsAccumulator >= 0.5) {
        currentFps = Math.round(fpsFrames / fpsAccumulator);
        fpsAccumulator = 0;
        fpsFrames = 0;
      }

      if (now - lastTelemetryPush > 250) {
        lastTelemetryPush = now;
        const settings = getSettings();
        const uPerM = lastPlaquePose
          ? computeUnitsPerMeter(lastPlaquePose.scale, settings)
          : 1.0;
        const camDist =
          isAnchored && camera && shuraleAnchor
            ? camera.position.distanceTo(shuraleAnchor.position) / Math.max(uPerM, 0.01)
            : null;
        onTelemetry?.({
          fps: currentFps,
          isModelLoaded,
          modelLoadMs,
          isAnchored,
          isTargetVisible,
          lockCount,
          targetScale: lastPlaquePose ? lastPlaquePose.scale : null,
          unitsPerMeter: uPerM,
          camDistM: camDist,
          anchorPos: isAnchored && shuraleAnchor ? shuraleAnchor.position : null,
        });
      }
    },
    listeners: [
      { event: 'reality.imagefound', process: handleImageFound },
      { event: 'reality.imageupdated', process: handleImageUpdated },
      { event: 'reality.imagelost', process: handleImageLost },
    ],
  };

  return {
    pipelineModule,
    applySettingsLive() {
      const settings = getSettings();
      if (plaqueOutline) {
        plaqueOutline.visible = Boolean(isTargetVisible && settings.showPlaqueDebug);
      }
      if (isAnchored && lastPlaquePose) {
        applyPoseToAnchor(lastPlaquePose, { snap: true });
      }
    },
    resetAnchor() {
      isAnchored = false;
      isTargetVisible = false;
      lastPlaquePose = null;
      if (shuraleAnchor) shuraleAnchor.visible = false;
      if (plaqueOutline) plaqueOutline.visible = false;
      try {
        window.XR8?.XrController?.recenter();
      } catch (err) {
        console.warn('recenter warning:', err);
      }
      onStatusChange?.('searching', 'Сброшено — наведите на табличку А4');
    },
  };
}
