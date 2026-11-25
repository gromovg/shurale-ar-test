import './styles.css';
import { loadSettings } from './config.js';
import {
  syncCanvasBufferSize,
  createFullWindowCanvasModule,
  createTorchModule,
  createShuralePipeline,
} from './ar-pipeline.js';
import {
  createCaptureController,
  isVideoRecordingSupported,
} from './capture.js';
import { createUIController } from './ui.js';

const settings = loadSettings();

/**
 * Locks the WebAR screen rigidly to the mobile phone's visible viewport:
 * - Syncs --app-vw / --app-vh to visualViewport so HUD & camera stay edge-to-edge
 *   even as iOS Safari's dynamic address bar expands/collapses.
 * - Blocks accidental pinch-zoom, double-tap zoom, and elastic page bounce
 *   while preserving scrolling inside #settings-drawer and welcome sheet.
 */
function lockMobileViewport() {
  const syncViewportVars = () => {
    if (window.scrollX !== 0 || window.scrollY !== 0) {
      window.scrollTo(0, 0);
    }
    const vv = window.visualViewport;
    const vw = Math.round(vv ? vv.width : window.innerWidth);
    const vh = Math.round(vv ? vv.height : window.innerHeight);
    if (vw > 0 && vh > 0) {
      document.documentElement.style.setProperty('--app-vw', `${vw}px`);
      document.documentElement.style.setProperty('--app-vh', `${vh}px`);
    }
    const canvas = document.getElementById('camerafeed');
    if (canvas) syncCanvasBufferSize(canvas);
  };

  syncViewportVars();
  window.addEventListener('resize', syncViewportVars, { passive: true });
  window.addEventListener('orientationchange', () => setTimeout(syncViewportVars, 120), { passive: true });
  window.visualViewport?.addEventListener('resize', syncViewportVars, { passive: true });
  window.visualViewport?.addEventListener('scroll', syncViewportVars, { passive: true });

  // Block iOS Safari proprietary pinch gestures (Safari ignores viewport user-scalable=no)
  const blockGesture = (e) => e.preventDefault();
  document.addEventListener('gesturestart', blockGesture, { passive: false });
  document.addEventListener('gesturechange', blockGesture, { passive: false });
  document.addEventListener('gestureend', blockGesture, { passive: false });

  // Block multi-touch pinch zoom and rubber-band page drag outside scrollable drawers
  document.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length > 1) {
        e.preventDefault();
        return;
      }
      if (!e.target.closest?.('#settings-drawer, .welcome-card, .modal-card')) {
        e.preventDefault();
      }
    },
    { passive: false },
  );

  // Block double-tap zoom on empty AR canvas areas without interfering with button taps
  let lastTapTime = 0;
  document.addEventListener(
    'touchend',
    (e) => {
      const now = Date.now();
      if (
        now - lastTapTime <= 320 &&
        e.touches.length === 0 &&
        !e.target.closest?.('button, a, input, label, video, #settings-drawer')
      ) {
        e.preventDefault();
      }
      lastTapTime = now;
    },
    { passive: false },
  );
}

lockMobileViewport();

let arController = null;
let torchModule = null;
let captureController = null;
let cachedXR8 = null;
let cachedTargetData = null;
let currentMode = 'slam'; // 'slam' | 'image-only'
let hasTriedFallback = false;

const startOverlay = document.getElementById('start-overlay');
const btnStartAr = document.getElementById('btn-start-ar');

const ui = createUIController({
  settings,
  videoSupported: isVideoRecordingSupported(),
  onSettingsChanged: () => arController?.applySettingsLive(),
  onReset: () => arController?.resetAnchor(),
  onDevSkip: () => arController?.devSkipToPlace(),
  onPlaceHere: () => arController?.placeHere(),
  onStartRelocate: () => arController?.startRelocate(),
  onCancelRelocate: () => arController?.cancelRelocate(),
  onToggleTorch: () => torchModule?.toggle(),
  onTakePhoto: async () => {
    if (!captureController) {
      return { ok: false, reason: 'Камера ещё не запущена' };
    }
    try {
      const result = await captureController.capturePhoto();
      return { ok: true, media: result };
    } catch (err) {
      console.error('Capture photo failed:', err);
      return { ok: false, reason: err?.message || 'Не удалось сделать фото' };
    }
  },
  onStartVideo: () => {
    if (!captureController) {
      return { ok: false, reason: 'Камера ещё не запущена' };
    }
    return captureController.startVideoRecording();
  },
  onStopVideo: () => {
    captureController?.stopVideoRecording();
  },
  onRetry: () => window.location.reload(),
});

function detectInAppBrowser() {
  const ua = navigator.userAgent || '';
  if (/Telegram/i.test(ua)) return 'Telegram';
  if (/Instagram/i.test(ua)) return 'Instagram';
  if (/FBAN|FBAV/i.test(ua)) return 'Facebook';
  if (/VKAndroidApp|VKClient/i.test(ua)) return 'VK';
  if (/WhatsApp/i.test(ua)) return 'WhatsApp';
  return null;
}

function waitForXR8(timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    if (window.XR8) {
      resolve(window.XR8);
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error('Таймаут загрузки 8th Wall xr.js. Проверьте интернет и обновите страницу.'));
    }, timeoutMs);

    window.addEventListener(
      'xrloaded',
      () => {
        clearTimeout(timer);
        resolve(window.XR8);
      },
      { once: true },
    );
  });
}

async function fetchImageTarget() {
  const res = await fetch('./image-targets/shurale-a4.json');
  if (!res.ok) {
    throw new Error(`Не удалось загрузить маркер shurale-a4.json (HTTP ${res.status})`);
  }
  return res.json();
}

/**
 * Trigger BOTH iOS Safari motion/orientation permission requests synchronously
 * inside the same click gesture tick (Promise.all) so the user-gesture
 * token never expires between the first and second prompt.
 */
async function requestIOSMotionPermissions() {
  const tasks = [];
  if (
    typeof DeviceMotionEvent !== 'undefined' &&
    typeof DeviceMotionEvent.requestPermission === 'function'
  ) {
    tasks.push(
      DeviceMotionEvent.requestPermission()
        .then((res) => ({ api: 'motion', state: res }))
        .catch((err) => ({ api: 'motion', state: 'error', err })),
    );
  }
  if (
    typeof DeviceOrientationEvent !== 'undefined' &&
    typeof DeviceOrientationEvent.requestPermission === 'function'
  ) {
    tasks.push(
      DeviceOrientationEvent.requestPermission()
        .then((res) => ({ api: 'orient', state: res }))
        .catch((err) => ({ api: 'orient', state: 'error', err })),
    );
  }
  if (!tasks.length) {
    return { granted: true, details: 'not-required' };
  }
  const results = await Promise.all(tasks);
  const denied = results.some((r) => r.state === 'denied' || r.state === 'error');
  const details = results.map((r) => `${r.api}:${r.state}`).join(', ');
  return { granted: !denied, details };
}

function formatErrorDetail(err) {
  if (!err) return 'unknown';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return err.message || err.type || JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function launchXR8({ disableWorldTracking }) {
  const XR8 = cachedXR8;
  currentMode = disableWorldTracking ? 'image-only' : 'slam';
  ui.setCaptureAvailable(false);

  try {
    XR8.stop();
  } catch {
    // Not running yet
  }
  try {
    XR8.clearCameraPipelineModules();
  } catch {
    // Ignore if unavailable
  }

  XR8.XrController.configure({
    imageTargetData: [cachedTargetData],
    disableWorldTracking,
    scale: disableWorldTracking ? 'responsive' : 'absolute',
  });

  torchModule = createTorchModule({
    onTorchStateChange: (state) => ui.setTorchState(state),
  });

  arController = createShuralePipeline({
    getSettings: () => settings,
    imageOnly: disableWorldTracking,
    onStageChange: (stage, meta) => ui.setStage(stage, meta),
    onCalibrationProgress: (info) => ui.setCalibrationProgress(info),
    onStatusChange: (mode, text) => ui.setStatus(mode, text),
    onDirectionHint: (text) => ui.setDirectionHint(text),
    onTelemetry: (info) => ui.updateTelemetry(info),
    onError: (title, message) => {
      ui.setStatus('error', title);
      ui.showError(title, message);
    },
  });

  captureController = createCaptureController({
    onCaptureActiveChange: (active) => arController?.setCaptureMode(active),
    onRecordingStateChange: (state) => ui.setRecordingState(state),
    onRecordingProgress: (progress) => ui.setRecordingProgress(progress),
    onVideoReady: (media) => ui.showMediaPreview(media),
    onError: (message) => ui.showToast(message, 3600),
  });

  const cameraErrorModule = {
    name: 'camera-error-handler',
    onStart: () => {
      ui.setCaptureAvailable(true);
    },
    onException: (err) => {
      console.error('XR8 exception:', err);
      const detail = formatErrorDetail(err);

      // Automatic silent fallback: if full SLAM fails on a phone (e.g. blocked gyroscope),
      // retry once in pure Image-Target mode (needs ONLY camera, zero motion sensors!)
      if (!disableWorldTracking && !hasTriedFallback && !detail.includes('No valid session manager')) {
        hasTriedFallback = true;
        console.warn('SLAM failed, falling back to image-only AR mode:', detail);
        ui.showToast('Включён упрощённый режим (держите табличку в кадре)', 3600);
        setTimeout(() => launchXR8({ disableWorldTracking: true }), 150);
        return;
      }

      ui.setCaptureAvailable(false);

      if (detail.includes('No valid session manager')) {
        ui.setStatus('error', 'Откройте на смартфоне');
        ui.showError(
          'Откройте ссылку на iPhone или Android',
          'AR-режим требует камеру смартфона. Откройте эту ссылку в Safari (iPhone) или Chrome (Android).',
        );
        return;
      }

      ui.setStatus('error', 'Ошибка AR-движка');
      ui.showError(
        'Не удалось запустить AR-камеру',
        `Проверьте доступ к камере в Safari (иконка слева в адресной строке → Настройки веб-сайта → Камера: Разрешить) и закройте другие приложения с камерой.\n\nКод: ${detail}`,
      );
    },
    onCameraStatusChange: ({ status, reason }) => {
      if (status === 'hasVideo' || status === 'hasStream') {
        ui.setCaptureAvailable(true);
      } else if (status === 'failed') {
        ui.setCaptureAvailable(false);
        ui.setStatus('error', 'Нет доступа к камере');
        ui.showError(
          'Нужен доступ к камере',
          `Нажмите на иконку слева в адресной строке Safari → «Настройки веб-сайта» → «Камера: Разрешить», затем нажмите «Попробовать снова».${reason ? `\n\nКод: ${formatErrorDetail(reason)}` : ''}`,
        );
      }
    },
  };

  XR8.addCameraPipelineModules([
    XR8.GlTextureRenderer.pipelineModule(),
    XR8.Threejs.pipelineModule(),
    XR8.XrController.pipelineModule(),
    createFullWindowCanvasModule(),
    torchModule,
    cameraErrorModule,
    arController.pipelineModule,
    // Registered LAST so its onRender captures the completed camera + 3D Shurale frame
    captureController.pipelineModule,
  ]);

  const canvas = document.getElementById('camerafeed');
  syncCanvasBufferSize(canvas);
  XR8.run({
    canvas,
    allowedDevices: XR8.XrConfig.device().ANY,
    cameraConfig: {
      direction: XR8.XrConfig.camera().BACK,
    },
  });

  if (disableWorldTracking) {
    ui.setStatus('searching', 'Наведите камеру на табличку А4');
  }
}

async function startARSession() {
  if (!cachedXR8 || !cachedTargetData) return;

  btnStartAr.disabled = true;
  btnStartAr.textContent = 'Открываем камеру...';

  const motion = await requestIOSMotionPermissions();

  startOverlay.classList.add('hidden');
  document.body.classList.remove('is-welcome-open');
  ui.setStatus('loading', 'Включаем камеру...');

  try {
    if (!motion.granted) {
      // Instead of blocking the visitor with an error modal, seamlessly launch
      // camera-only Image Target mode so they STILL see Shurale without gyroscope!
      hasTriedFallback = true;
      ui.showToast('Датчики движения отключены — запущен режим по табличке', 3600);
      launchXR8({ disableWorldTracking: true });
      return;
    }

    launchXR8({ disableWorldTracking: false });
  } catch (err) {
    console.error('Start AR error:', err);
    ui.setStatus('error', 'Ошибка запуска AR');
    ui.showError('Ошибка запуска AR-прототипа', formatErrorDetail(err));
  }
}

async function preload() {
  if (!window.isSecureContext) {
    startOverlay.classList.add('hidden');
    document.body.classList.remove('is-welcome-open');
    ui.setStatus('error', 'Требуется HTTPS');
    ui.showError(
      'Нужен HTTPS для доступа к камере',
      'iOS Safari и Android Chrome блокируют камеру на обычном HTTP. Откройте прототип по HTTPS-ссылке.',
    );
    return;
  }

  const inApp = detectInAppBrowser();
  if (inApp) {
    startOverlay.classList.add('hidden');
    document.body.classList.remove('is-welcome-open');
    ui.setStatus('error', `Откройте в Safari / Chrome`);
    ui.showError(
      `Открыто внутри ${inApp}`,
      `Встроенный браузер ${inApp} часто блокирует AR-камеру. Нажмите меню (⋯ или «Поделиться») и выберите «Открыть в Safari» / «Открыть в Chrome».`,
    );
    return;
  }

  ui.setStatus('loading', 'Готовим камеру...');

  try {
    const [XR8, targetData] = await Promise.all([waitForXR8(), fetchImageTarget()]);
    cachedXR8 = XR8;
    cachedTargetData = targetData;

    ui.setStatus('searching', 'Можно начинать');
    btnStartAr.disabled = false;
    btnStartAr.textContent = 'Открыть камеру';
    btnStartAr.addEventListener('click', startARSession, { once: true });
  } catch (err) {
    console.error('Preload error:', err);
    startOverlay.classList.add('hidden');
    document.body.classList.remove('is-welcome-open');
    ui.setStatus('error', 'Ошибка загрузки');
    ui.showError('Ошибка загрузки ресурсов', formatErrorDetail(err));
  }
}

preload();
