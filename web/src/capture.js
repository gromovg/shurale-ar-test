/**
 * Cross-platform WebAR Photo & Video Capture module for iPhone Safari + Android Chrome.
 *
 * Design notes:
 * - Hooks into XR8 camera pipeline AFTER GlTextureRenderer + Threejs via `onRender`,
 *   capturing the freshly composited camera + 3D Shurale frame (with HTML HUD excluded).
 * - Uses a dedicated 2D compositor canvas with even H.264 dimensions (max 1280px for video,
 *   max 1920px for JPEG photos) so hardware encoders on iOS Safari & Android Chrome stay crisp
 *   and never crash on odd/Retina sizes or Safari viewport address-bar resizes.
 * - Attaches a silent Web Audio track (Oscillator -> Gain(0) -> MediaStreamDestination) during
 *   video recording WITHOUT requesting microphone permission:
 *     1) Prevents iOS Safari's known video-only MP4 moov-atom bug that breaks "Save Video" to Photos.
 *     2) Avoids calling getUserMedia({ audio: true }) mid-session, which can kill the active iOS camera feed.
 * - Strips `;codecs=...` parameters from final File MIME types (`video/mp4`, `image/jpeg`) so
 *   `navigator.canShare({ files })` & `navigator.share({ files })` reliably offer "Save to Photos".
 */

export const MAX_VIDEO_DURATION_MS = 30_000;
const PHOTO_MAX_DIMENSION = 1920;
const PHOTO_JPEG_QUALITY = 0.92;
const VIDEO_MAX_DIMENSION = 1280;
const VIDEO_FPS = 30;
const VIDEO_BITRATE = 4_000_000; // 4 Mbps: crisp HD, well below iOS Safari's 10 Mbps RAM-crash default
const AUDIO_BITRATE = 128_000;

export function isIOSDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function isAndroidDevice() {
  if (typeof navigator === 'undefined') return false;
  return /Android/i.test(navigator.userAgent || '');
}

export function isVideoRecordingSupported() {
  return (
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function'
  );
}

export function canShareFile(file) {
  if (!file || typeof navigator === 'undefined') return false;
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') {
    return false;
  }
  try {
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export async function shareMediaFile(file) {
  if (!canShareFile(file)) {
    return { ok: false, unsupported: true };
  }
  try {
    // CRITICAL for iOS Safari: pass ONLY `{ files: [file] }` (no `text`/`title`/`url`),
    // otherwise Safari may reject or hide "Save Image" / "Save Video".
    await navigator.share({ files: [file] });
    return { ok: true };
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { ok: false, aborted: true };
    }
    console.warn('Web Share error:', err);
    return { ok: false, error: err };
  }
}

export function downloadMediaFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 15_000);
}

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 КБ';
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function buildFilename(ext) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `shurale-ar-${stamp}.${ext}`;
}

function computeFitSize(srcW, srcH, maxDim, makeEven = false) {
  if (!srcW || !srcH) return { width: 720, height: 1280 };
  const scale = Math.min(maxDim / srcW, maxDim / srcH, 1);
  let width = Math.max(2, Math.round(srcW * scale));
  let height = Math.max(2, Math.round(srcH * scale));
  if (makeEven) {
    width = Math.max(2, Math.round(width / 2) * 2);
    height = Math.max(2, Math.round(height / 2) * 2);
  }
  return { width, height };
}

/**
 * Draws `srcCanvas` onto `dstCanvas` using "cover" crop so minor viewport/address-bar
 * height changes during video recording never distort aspect ratio or add black bars.
 */
function drawCanvasCover(dstCtx, dstW, dstH, srcCanvas) {
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;
  if (!sw || !sh) return;

  const srcAspect = sw / sh;
  const dstAspect = dstW / dstH;
  let sx = 0;
  let sy = 0;
  let sWidth = sw;
  let sHeight = sh;

  if (Math.abs(srcAspect - dstAspect) > 0.005) {
    if (srcAspect > dstAspect) {
      sWidth = Math.round(sh * dstAspect);
      sx = Math.round((sw - sWidth) / 2);
    } else {
      sHeight = Math.round(sw / dstAspect);
      sy = Math.round((sh - sHeight) / 2);
    }
  }

  dstCtx.drawImage(srcCanvas, sx, sy, sWidth, sHeight, 0, 0, dstW, dstH);
}

function pickVideoMimeType(isIOS) {
  if (typeof window.MediaRecorder === 'undefined') return '';
  const isSupported =
    typeof window.MediaRecorder.isTypeSupported === 'function'
      ? (t) => {
          try {
            return window.MediaRecorder.isTypeSupported(t);
          } catch {
            return false;
          }
        }
      : () => false;

  if (isIOS) {
    // Returning '' lets iOS Safari choose its native hardware-optimal video/mp4 profile
    // (same strategy as 8th Wall's internal MediaRecorder).
    return '';
  }

  // Prefer native H.264 MP4 first (Android Chrome 126+ supports native MP4!),
  // then fall back cleanly to WebM on older Android/desktop browsers.
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1.4D401E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=h264,aac',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];

  for (const mime of candidates) {
    if (isSupported(mime)) return mime;
  }
  return '';
}

function createSafeMediaRecorder(stream, isIOS) {
  const preferredMime = pickVideoMimeType(isIOS);
  const attempts = [];

  if (isIOS) {
    attempts.push({ videoBitsPerSecond: VIDEO_BITRATE, audioBitsPerSecond: AUDIO_BITRATE });
    attempts.push({ mimeType: 'video/mp4', videoBitsPerSecond: VIDEO_BITRATE });
    attempts.push({ mimeType: 'video/mp4' });
    attempts.push(null);
  } else {
    if (preferredMime) {
      attempts.push({
        mimeType: preferredMime,
        videoBitsPerSecond: VIDEO_BITRATE,
        audioBitsPerSecond: AUDIO_BITRATE,
      });
      attempts.push({ mimeType: preferredMime });
    }
    attempts.push({ videoBitsPerSecond: VIDEO_BITRATE });
    attempts.push(null);
  }

  let lastErr = null;
  for (const opts of attempts) {
    try {
      const recorder = opts ? new MediaRecorder(stream, opts) : new MediaRecorder(stream);
      return { recorder, requestedMime: opts?.mimeType || preferredMime || '' };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('MediaRecorder не удалось инициализировать');
}

export function createCaptureController({
  onCaptureActiveChange,
  onRecordingStateChange,
  onRecordingProgress,
  onVideoReady,
  onError,
} = {}) {
  let xrCanvas = null;

  // Reusable photo canvas
  const photoCanvas = document.createElement('canvas');
  const photoCtx = photoCanvas.getContext('2d', { willReadFrequently: true });

  // Dedicated in-DOM 2D compositor canvas for MediaRecorder (hidden behind #camerafeed)
  let videoCanvas = null;
  let videoCtx = null;

  // Reusable single AudioContext to avoid Safari's AudioContext limit across recordings
  let sharedAudioCtx = null;

  // Photo state
  let pendingPhoto = null;

  // Video recording state
  let isRecording = false;
  let isFinalizing = false;
  let activeRecorder = null;
  let activeStream = null;
  let activeSilentAudioCleanup = null;
  let activeChunks = [];
  let activeRequestedMime = '';
  let recordStartTime = 0;
  let progressTimer = null;
  let stopTimeout = null;

  function ensureVideoCanvas() {
    if (videoCanvas && videoCtx) return;
    videoCanvas = document.createElement('canvas');
    videoCanvas.setAttribute('aria-hidden', 'true');
    videoCanvas.style.cssText =
      'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1;';
    document.body.appendChild(videoCanvas);
    videoCtx = videoCanvas.getContext('2d');
  }

  function acquireSilentAudioTrack() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return { track: null, cleanup: () => {} };

      if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
        sharedAudioCtx = new AudioCtx();
      }
      if (sharedAudioCtx.state === 'suspended') {
        sharedAudioCtx.resume().catch(() => {});
      }

      const osc = sharedAudioCtx.createOscillator();
      const gain = sharedAudioCtx.createGain();
      gain.gain.value = 0; // Digital silence (0.0 PCM) — guarantees valid AAC frames on iOS
      const dest = sharedAudioCtx.createMediaStreamDestination();
      osc.connect(gain);
      gain.connect(dest);
      osc.start();

      const tracks = dest.stream.getAudioTracks();
      const track = tracks[0] || null;
      const cleanup = () => {
        try {
          osc.stop();
        } catch {
          // ignore
        }
        try {
          osc.disconnect();
          gain.disconnect();
        } catch {
          // ignore
        }
        try {
          dest.stream.getTracks().forEach((t) => t.stop());
        } catch {
          // ignore
        }
      };
      return { track, cleanup };
    } catch (err) {
      console.warn('Silent audio track fallback:', err);
      return { track: null, cleanup: () => {} };
    }
  }

  function syncCaptureModeFlag() {
    const active = Boolean(isRecording || pendingPhoto);
    onCaptureActiveChange?.(active);
  }

  function processPendingPhoto() {
    if (!pendingPhoto || !xrCanvas) return;

    const req = pendingPhoto;
    const sw = xrCanvas.width;
    const sh = xrCanvas.height;
    if (!sw || !sh) return;

    const { width, height } = computeFitSize(sw, sh, PHOTO_MAX_DIMENSION, false);
    if (photoCanvas.width !== width || photoCanvas.height !== height) {
      photoCanvas.width = width;
      photoCanvas.height = height;
    }

    photoCtx.drawImage(xrCanvas, 0, 0, width, height);

    // Verify center pixel isn't blank/transparent (guards against race on first frame)
    let alpha = 255;
    try {
      alpha = photoCtx.getImageData(width >> 1, height >> 1, 1, 1).data[3];
    } catch {
      alpha = 255;
    }

    if (alpha === 0 && req.retries < 8) {
      req.retries += 1;
      return;
    }

    // Photo pixels are now safely copied into 2D canvas -> release capture lock immediately
    clearTimeout(req.timeoutId);
    pendingPhoto = null;
    syncCaptureModeFlag();

    photoCanvas.toBlob(
      (blob) => {
        if (!blob || blob.size === 0) {
          req.reject(new Error('Не удалось сохранить кадр с камеры'));
          return;
        }
        const filename = buildFilename('jpg');
        const file = new File([blob], filename, { type: 'image/jpeg' });
        req.resolve({
          kind: 'photo',
          blob,
          file,
          filename,
          mimeType: 'image/jpeg',
          width,
          height,
        });
      },
      'image/jpeg',
      PHOTO_JPEG_QUALITY,
    );
  }

  function capturePhoto() {
    return new Promise((resolve, reject) => {
      if (!xrCanvas || !xrCanvas.width || !xrCanvas.height) {
        reject(new Error('Камера ещё не запущена'));
        return;
      }
      if (pendingPhoto) {
        reject(new Error('Снимок уже выполняется'));
        return;
      }

      const timeoutId = setTimeout(() => {
        if (pendingPhoto) {
          pendingPhoto = null;
          syncCaptureModeFlag();
          reject(new Error('Таймаут съёмки фото. Попробуйте ещё раз.'));
        }
      }, 2500);

      pendingPhoto = { resolve, reject, retries: 0, timeoutId };
      // Hide debug meshes synchronously BEFORE next XR8 frame renders
      syncCaptureModeFlag();
    });
  }

  function cleanupRecordingResources() {
    clearInterval(progressTimer);
    progressTimer = null;
    clearTimeout(stopTimeout);
    stopTimeout = null;

    if (activeStream) {
      try {
        activeStream.getTracks().forEach((t) => t.stop());
      } catch {
        // ignore
      }
      activeStream = null;
    }
    if (activeSilentAudioCleanup) {
      activeSilentAudioCleanup();
      activeSilentAudioCleanup = null;
    }
    activeRecorder = null;
    activeChunks = [];
    isRecording = false;
    isFinalizing = false;
    syncCaptureModeFlag();
    onRecordingStateChange?.({ isRecording: false, isFinalizing: false });
  }

  function finalizeChunks(recorderMime, durationMs) {
    const chunks = activeChunks.slice();
    const requested = activeRequestedMime;
    const width = videoCanvas ? videoCanvas.width : 0;
    const height = videoCanvas ? videoCanvas.height : 0;
    const isIOS = isIOSDevice();

    cleanupRecordingResources();

    if (!chunks.length) {
      onError?.('Видео получилось пустым. Попробуйте записать минимум 1–2 секунды.');
      return;
    }

    const rawMime = recorderMime || requested || (isIOS ? 'video/mp4' : 'video/webm');
    const cleanMime = rawMime.split(';')[0].trim() || (isIOS ? 'video/mp4' : 'video/webm');
    const ext = cleanMime.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type: cleanMime });

    if (!blob.size) {
      onError?.('Не удалось сформировать видеофайл. Попробуйте ещё раз.');
      return;
    }

    const filename = buildFilename(ext);
    const file = new File([blob], filename, { type: cleanMime });
    onVideoReady?.({
      kind: 'video',
      blob,
      file,
      filename,
      mimeType: cleanMime,
      ext,
      durationMs,
      width,
      height,
    });
  }

  function startVideoRecording() {
    if (isRecording || isFinalizing) {
      return { ok: false, reason: 'Запись уже идёт' };
    }
    if (!xrCanvas || !xrCanvas.width || !xrCanvas.height) {
      return { ok: false, reason: 'Камера ещё не готова' };
    }
    if (!isVideoRecordingSupported()) {
      return {
        ok: false,
        reason: 'Запись видео не поддерживается этим браузером. Откройте в Safari (iOS 14.5+) или Chrome.',
      };
    }

    const isIOS = isIOSDevice();
    ensureVideoCanvas();

    const { width, height } = computeFitSize(
      xrCanvas.width,
      xrCanvas.height,
      VIDEO_MAX_DIMENSION,
      true,
    );
    videoCanvas.width = width;
    videoCanvas.height = height;

    // Hide debug visuals immediately & draw initial frame before MediaRecorder starts
    isRecording = true;
    syncCaptureModeFlag();
    drawCanvasCover(videoCtx, width, height, xrCanvas);

    try {
      const canvasStream = videoCanvas.captureStream(VIDEO_FPS);
      const videoTrack = canvasStream.getVideoTracks()[0];
      if (!videoTrack) {
        throw new Error('Не удалось создать видеопоток с экрана AR');
      }

      const silentAudio = acquireSilentAudioTrack();
      activeSilentAudioCleanup = silentAudio.cleanup;

      const combinedStream = new MediaStream();
      combinedStream.addTrack(videoTrack);
      if (silentAudio.track) {
        combinedStream.addTrack(silentAudio.track);
      }
      activeStream = combinedStream;

      const { recorder, requestedMime } = createSafeMediaRecorder(combinedStream, isIOS);
      activeRecorder = recorder;
      activeRequestedMime = requestedMime;
      activeChunks = [];
      recordStartTime = performance.now();

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          activeChunks.push(ev.data);
        }
      };

      recorder.onerror = (ev) => {
        console.error('MediaRecorder error:', ev?.error || ev);
        const msg = ev?.error?.message || 'Ошибка записи видео';
        cleanupRecordingResources();
        onError?.(msg);
      };

      recorder.onstop = () => {
        const elapsed = Math.max(500, performance.now() - recordStartTime);
        finalizeChunks(recorder.mimeType, elapsed);
      };

      // Timeslice 1000ms flushes chunks periodically (prevents iOS Safari buffer loss)
      recorder.start(1000);

      onRecordingStateChange?.({ isRecording: true, isFinalizing: false });
      onRecordingProgress?.({ elapsedMs: 0, maxDurationMs: MAX_VIDEO_DURATION_MS });

      progressTimer = setInterval(() => {
        if (!isRecording) return;
        const elapsedMs = performance.now() - recordStartTime;
        onRecordingProgress?.({
          elapsedMs: Math.min(elapsedMs, MAX_VIDEO_DURATION_MS),
          maxDurationMs: MAX_VIDEO_DURATION_MS,
        });
        if (elapsedMs >= MAX_VIDEO_DURATION_MS) {
          stopVideoRecording();
        }
      }, 100);

      return { ok: true };
    } catch (err) {
      console.error('Failed to start video recording:', err);
      cleanupRecordingResources();
      return {
        ok: false,
        reason: `Не удалось начать запись: ${err?.message || 'ошибка браузера'}`,
      };
    }
  }

  function stopVideoRecording() {
    if (!isRecording || isFinalizing) return;

    isRecording = false;
    isFinalizing = true;
    clearInterval(progressTimer);
    progressTimer = null;
    syncCaptureModeFlag();
    onRecordingStateChange?.({ isRecording: false, isFinalizing: true });

    // Tiny flush paint helps WebKit push the final frame before stop
    if (videoCtx && videoCanvas) {
      videoCtx.fillStyle = 'rgba(0,0,0,0.01)';
      videoCtx.fillRect(0, 0, 1, 1);
    }

    const recorder = activeRecorder;
    if (!recorder || recorder.state === 'inactive') {
      const elapsed = Math.max(500, performance.now() - recordStartTime);
      finalizeChunks(recorder?.mimeType, elapsed);
      return;
    }

    // Safety guard in case WebKit stalls onstop
    stopTimeout = setTimeout(() => {
      if (isFinalizing) {
        const elapsed = Math.max(500, performance.now() - recordStartTime);
        finalizeChunks(recorder.mimeType, elapsed);
      }
    }, 4000);

    try {
      recorder.stop();
    } catch (err) {
      console.warn('recorder.stop warning:', err);
      const elapsed = Math.max(500, performance.now() - recordStartTime);
      finalizeChunks(recorder.mimeType, elapsed);
    }
  }

  // Auto-stop cleanly if user backgrounds Safari / locks screen mid-recording
  const handleVisibilityChange = () => {
    if (document.hidden && isRecording) {
      stopVideoRecording();
    }
  };

  const pipelineModule = {
    name: 'shurale-media-capture',
    onAttach: ({ canvas }) => {
      xrCanvas = canvas;
      document.addEventListener('visibilitychange', handleVisibilityChange);
    },
    onStart: ({ canvas }) => {
      if (canvas) xrCanvas = canvas;
    },
    onRender: () => {
      if (!xrCanvas) return;

      if (isRecording && videoCtx && videoCanvas) {
        drawCanvasCover(videoCtx, videoCanvas.width, videoCanvas.height, xrCanvas);
      }

      if (pendingPhoto) {
        processPendingPhoto();
      }
    },
    onDetach: () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (isRecording) {
        stopVideoRecording();
      }
      if (pendingPhoto) {
        clearTimeout(pendingPhoto.timeoutId);
        pendingPhoto.reject(new Error('AR-сессия остановлена'));
        pendingPhoto = null;
      }
      if (videoCanvas) {
        videoCanvas.remove();
        videoCanvas = null;
        videoCtx = null;
      }
      xrCanvas = null;
    },
  };

  return {
    pipelineModule,
    capturePhoto,
    startVideoRecording,
    stopVideoRecording,
    isRecording: () => isRecording,
    isFinalizing: () => isFinalizing,
  };
}
