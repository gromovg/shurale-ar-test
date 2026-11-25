import './styles.css';
import { loadSettings } from './config.js';
import {
  syncCanvasBufferSize,
  createFullWindowCanvasModule,
  createTorchModule,
  createShuralePipeline,
} from './ar-pipeline.js';
import { createUIController } from './ui.js';

const settings = loadSettings();

let arController = null;
let torchModule = null;
let cachedXR8 = null;
let cachedTargetData = null;

const startOverlay = document.getElementById('start-overlay');
const btnStartAr = document.getElementById('btn-start-ar');

const ui = createUIController({
  settings,
  onSettingsChanged: () => arController?.applySettingsLive(),
  onReset: () => arController?.resetAnchor(),
  onPlaceHere: () => arController?.placeHere(),
  onToggleTorch: () => torchModule?.toggle(),
  onRetry: () => window.location.reload(),
});

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
 * Request iOS 13+ Safari motion & orientation permissions inside a user click gesture
 * so 8th Wall SLAM + absolute scale gets full IMU sensor fusion.
 */
async function requestIOSMotionPermissions() {
  try {
    if (
      typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function'
    ) {
      await DeviceMotionEvent.requestPermission();
    }
  } catch (err) {
    console.warn('DeviceMotionEvent permission warning:', err);
  }
  try {
    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function'
    ) {
      await DeviceOrientationEvent.requestPermission();
    }
  } catch (err) {
    console.warn('DeviceOrientationEvent permission warning:', err);
  }
}

async function startARSession() {
  if (!cachedXR8 || !cachedTargetData) return;

  btnStartAr.disabled = true;
  btnStartAr.textContent = 'Запуск камеры...';

  await requestIOSMotionPermissions();

  startOverlay.classList.add('hidden');
  ui.setStatus('loading', 'Запуск камеры и SLAM...');

  try {
    const XR8 = cachedXR8;

    // Configure 8th Wall: Image Target + World Tracking (SLAM).
    // Use scale: 'responsive' so SLAM freezes world scale on frame 1 (no mid-walk scale jumps),
    // while our physical 195x260 mm A4 plaque calibrates exact real-world meters!
    XR8.XrController.configure({
      imageTargetData: [cachedTargetData],
      disableWorldTracking: false,
      scale: 'responsive',
    });

    torchModule = createTorchModule({
      onTorchStateChange: (state) => ui.setTorchState(state),
    });

    arController = createShuralePipeline({
      getSettings: () => settings,
      onStatusChange: (mode, text) => ui.setStatus(mode, text),
      onDirectionHint: (text) => ui.setDirectionHint(text),
      onTelemetry: (info) => ui.updateTelemetry(info),
      onError: (title, message) => {
        ui.setStatus('error', title);
        ui.showError(title, message);
      },
    });

    const cameraErrorModule = {
      name: 'camera-error-handler',
      onException: (err) => {
        console.error('XR8 exception:', err);
        const msg = err?.message || '';
        if (msg.includes('No valid session manager')) {
          ui.setStatus('error', 'Откройте на смартфоне');
          ui.showError(
            'Откройте ссылку на iPhone или Android',
            'Режим SLAM + Image Target требует камеру и датчики движения смартфона (iOS Safari или Android Chrome).',
          );
          return;
        }
        ui.setStatus('error', 'Ошибка AR-движка');
        ui.showError(
          'Ошибка запуска AR',
          msg || 'Проверьте разрешение на камеру и датчики движения в настройках Safari.',
        );
      },
      onCameraStatusChange: ({ status }) => {
        if (status === 'failed') {
          ui.setStatus('error', 'Нет доступа к камере');
          ui.showError(
            'Доступ к камере отклонён',
            'Разрешите доступ к камере для этого сайта в Safari / Chrome и нажмите «Попробовать снова».',
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
    ]);

    const canvas = document.getElementById('camerafeed');
    // Critical: size canvas drawing buffer to viewport × DPR BEFORE XR8.run()
    syncCanvasBufferSize(canvas);
    XR8.run({
      canvas,
      allowedDevices: XR8.XrConfig.device().ANY,
      cameraConfig: {
        direction: XR8.XrConfig.camera().BACK,
      },
    });
  } catch (err) {
    console.error('Start AR error:', err);
    ui.setStatus('error', 'Ошибка запуска AR');
    ui.showError('Ошибка запуска AR-прототипа', err?.message || String(err));
  }
}

async function preload() {
  if (!window.isSecureContext) {
    startOverlay.classList.add('hidden');
    ui.setStatus('error', 'Требуется HTTPS');
    ui.showError(
      'Нужен HTTPS для доступа к камере',
      'iOS Safari и Android Chrome блокируют камеру на обычном HTTP. Откройте прототип по HTTPS-ссылке (Cloudflare Pages / GitHub Pages / туннель).',
    );
    return;
  }

  ui.setStatus('loading', 'Загрузка движка SLAM и маркера...');

  try {
    const [XR8, targetData] = await Promise.all([waitForXR8(), fetchImageTarget()]);
    cachedXR8 = XR8;
    cachedTargetData = targetData;

    ui.setStatus('searching', 'Готово к запуску');
    btnStartAr.disabled = false;
    btnStartAr.textContent = 'Запустить AR-камеру';
    btnStartAr.addEventListener('click', startARSession, { once: true });
  } catch (err) {
    console.error('Preload error:', err);
    startOverlay.classList.add('hidden');
    ui.setStatus('error', 'Ошибка загрузки');
    ui.showError('Ошибка загрузки ресурсов', err?.message || String(err));
  }
}

preload();
