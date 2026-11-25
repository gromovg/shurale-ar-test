import {
  DEFAULT_SETTINGS,
  PRESET_FULL_FLOOR,
  PRESET_DESK_MINI,
  saveSettings,
} from './config.js';
import {
  MAX_VIDEO_DURATION_MS,
  isIOSDevice,
  isAndroidDevice,
  canShareFile,
  shareMediaFile,
  downloadMediaFile,
  formatFileSize,
  formatDuration,
} from './capture.js';

const RING_RADIUS = 36;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function createUIController({
  settings,
  videoSupported = true,
  onSettingsChanged,
  onReset,
  onPlaceHere,
  onToggleTorch,
  onTakePhoto,
  onStartVideo,
  onStopVideo,
  onRetry,
}) {
  const el = {
    statusPill: document.getElementById('status-pill'),
    statusText: document.getElementById('status-text'),
    devToolbar: document.getElementById('dev-toolbar'),
    btnCloseDev: document.getElementById('btn-close-dev'),
    scanHint: document.getElementById('scan-hint'),
    scanLabel: document.getElementById('scan-label'),
    directionHint: document.getElementById('direction-hint'),
    shutterFlash: document.getElementById('shutter-flash'),
    recIndicator: document.getElementById('rec-indicator'),
    recTimer: document.getElementById('rec-timer'),
    captureDock: document.getElementById('capture-dock'),
    btnModePhoto: document.getElementById('btn-mode-photo'),
    btnModeVideo: document.getElementById('btn-mode-video'),
    btnShutter: document.getElementById('btn-shutter'),
    shutterRingBar: document.getElementById('shutter-ring-bar'),

    previewModal: document.getElementById('capture-preview-modal'),
    previewMeta: document.getElementById('preview-meta'),
    previewImage: document.getElementById('preview-image'),
    previewVideo: document.getElementById('preview-video'),
    previewHint: document.getElementById('preview-hint'),
    btnPreviewClose: document.getElementById('btn-preview-close'),
    btnPreviewPrimary: document.getElementById('btn-preview-primary'),
    btnPreviewSecondary: document.getElementById('btn-preview-secondary'),
    btnPreviewRetake: document.getElementById('btn-preview-retake'),

    btnPresetFull: document.getElementById('btn-preset-full'),
    btnPresetDesk: document.getElementById('btn-preset-desk'),
    btnTelemetry: document.getElementById('btn-telemetry'),
    telemetryBox: document.getElementById('telemetry-box'),
    telemetryLines: document.getElementById('telemetry-lines'),
    btnReset: document.getElementById('btn-reset'),
    btnPlaceHere: document.getElementById('btn-place-here'),
    btnTorch: document.getElementById('btn-torch'),
    torchLabel: document.getElementById('torch-label'),
    btnSettings: document.getElementById('btn-settings'),
    settingsDrawer: document.getElementById('settings-drawer'),
    btnCloseSettings: document.getElementById('btn-close-settings'),
    btnResetDefaults: document.getElementById('btn-reset-defaults'),
    btnLicense: document.getElementById('btn-license'),
    licenseModal: document.getElementById('license-modal'),
    btnCloseLicense: document.getElementById('btn-close-license'),
    errorOverlay: document.getElementById('error-overlay'),
    errorTitle: document.getElementById('error-title'),
    errorMessage: document.getElementById('error-message'),
    btnRetry: document.getElementById('btn-retry'),
    toast: document.getElementById('toast'),

    inpMountHeight: document.getElementById('inp-mount-height'),
    valMountHeight: document.getElementById('val-mount-height'),
    inpOffsetRight: document.getElementById('inp-offset-right'),
    valOffsetRight: document.getElementById('val-offset-right'),
    inpOffsetForward: document.getElementById('inp-offset-forward'),
    valOffsetForward: document.getElementById('val-offset-forward'),
    inpYaw: document.getElementById('inp-yaw'),
    valYaw: document.getElementById('val-yaw'),
    inpTargetWidth: document.getElementById('inp-target-width'),
    valTargetWidth: document.getElementById('val-target-width'),
    chkTargetScale: document.getElementById('chk-target-scale'),
    chkShowPlaque: document.getElementById('chk-show-plaque'),
    chkAutoRealign: document.getElementById('chk-auto-realign'),
  };

  let toastTimer = null;
  let captureAvailable = false;
  let captureMode = 'photo'; // 'photo' | 'video'
  let isRecording = false;
  let isFinalizing = false;
  let isCapturingPhoto = false;

  // Triple-tap gesture state for hidden field-test toolbar
  let devTapCount = 0;
  let devTapTimer = null;
  let devBarOpen = new URLSearchParams(window.location.search).has('dev');

  let activeMedia = null;
  let activePreviewUrl = null;
  let primaryAction = null;
  let secondaryAction = null;

  if (el.shutterRingBar) {
    el.shutterRingBar.style.strokeDasharray = `${RING_CIRCUMFERENCE}`;
    el.shutterRingBar.style.strokeDashoffset = `${RING_CIRCUMFERENCE}`;
  }

  function showToast(msg, durationMs = 2600) {
    el.toast.textContent = msg;
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.classList.add('hidden');
    }, durationMs);
  }

  function setDrawerOpen(open) {
    el.settingsDrawer.classList.toggle('hidden', !open);
    el.btnSettings.setAttribute('aria-pressed', String(open));
    syncCaptureDockVisibility();
  }

  function setDevBarOpen(open) {
    devBarOpen = Boolean(open);
    el.devToolbar.classList.toggle('hidden', !devBarOpen);
    if (!devBarOpen) {
      el.telemetryBox.classList.add('hidden');
      el.btnTelemetry.setAttribute('aria-pressed', 'false');
      setDrawerOpen(false);
    }
  }

  // Reveal dev bar automatically if ?dev=1 is in URL
  if (devBarOpen) {
    el.devToolbar.classList.remove('hidden');
  }

  // Secret triple-tap on the top status pill reveals/hides the calibration toolbar
  el.statusPill.addEventListener('click', () => {
    devTapCount += 1;
    clearTimeout(devTapTimer);
    devTapTimer = setTimeout(() => {
      devTapCount = 0;
    }, 800);
    if (devTapCount >= 3) {
      devTapCount = 0;
      setDevBarOpen(!devBarOpen);
      showToast(devBarOpen ? 'Панель настройки открыта' : 'Панель настройки скрыта', 1800);
    }
  });

  el.btnCloseDev.addEventListener('click', () => setDevBarOpen(false));

  function triggerShutterFlash() {
    el.shutterFlash.classList.remove('flash-active');
    void el.shutterFlash.offsetWidth;
    el.shutterFlash.classList.add('flash-active');
    if (navigator.vibrate) {
      try {
        navigator.vibrate(18);
      } catch {
        // ignore
      }
    }
  }

  function syncCaptureDockVisibility() {
    const drawerOpen = !el.settingsDrawer.classList.contains('hidden');
    const previewOpen = !el.previewModal.classList.contains('hidden');
    const shouldShow = captureAvailable && !drawerOpen && !previewOpen;
    el.captureDock.classList.toggle('hidden', !shouldShow);
  }

  function updateShutterAppearance() {
    el.btnModePhoto.classList.toggle('is-active', captureMode === 'photo');
    el.btnModePhoto.setAttribute('aria-selected', String(captureMode === 'photo'));
    el.btnModeVideo.classList.toggle('is-active', captureMode === 'video');
    el.btnModeVideo.setAttribute('aria-selected', String(captureMode === 'video'));

    el.btnShutter.classList.toggle('mode-photo', captureMode === 'photo');
    el.btnShutter.classList.toggle('mode-video', captureMode === 'video');
    el.btnShutter.classList.toggle('is-recording', isRecording);
    el.btnShutter.classList.toggle('is-busy', isFinalizing || isCapturingPhoto);
    el.btnShutter.disabled = isFinalizing || isCapturingPhoto;

    if (captureMode === 'photo') {
      el.btnShutter.setAttribute('aria-label', 'Сделать фото');
    } else if (isRecording) {
      el.btnShutter.setAttribute('aria-label', 'Остановить запись видео');
    } else {
      el.btnShutter.setAttribute('aria-label', 'Начать запись видео');
    }
  }

  function setCaptureMode(mode) {
    if (isRecording || isFinalizing) return;
    if (mode === 'video' && !videoSupported) {
      showToast('Запись видео не поддерживается этим браузером. Откройте в Safari или Chrome.', 3600);
      return;
    }
    captureMode = mode;
    updateShutterAppearance();
  }

  function setRecordingProgress({ elapsedMs = 0, maxDurationMs = MAX_VIDEO_DURATION_MS }) {
    el.recTimer.textContent = formatDuration(elapsedMs);
    if (el.shutterRingBar) {
      const ratio = Math.min(1, Math.max(0, elapsedMs / Math.max(1, maxDurationMs)));
      const offset = RING_CIRCUMFERENCE * (1 - ratio);
      el.shutterRingBar.style.strokeDashoffset = `${offset}`;
    }
  }

  function setRecordingState({ isRecording: rec, isFinalizing: fin }) {
    isRecording = Boolean(rec);
    isFinalizing = Boolean(fin);
    document.body.classList.toggle('is-recording', isRecording);
    el.recIndicator.classList.toggle('hidden', !isRecording);

    if (!isRecording) {
      setRecordingProgress({ elapsedMs: 0, maxDurationMs: MAX_VIDEO_DURATION_MS });
    }
    if (isFinalizing) {
      showToast('Сохраняем видео...', 2000);
    }
    updateShutterAppearance();
  }

  function closeMediaPreview() {
    el.previewModal.classList.add('hidden');
    document.body.classList.remove('is-preview-open');
    el.previewImage.classList.add('hidden');
    el.previewImage.removeAttribute('src');

    el.previewVideo.pause();
    el.previewVideo.classList.add('hidden');
    el.previewVideo.removeAttribute('src');
    el.previewVideo.load();

    if (activePreviewUrl) {
      URL.revokeObjectURL(activePreviewUrl);
      activePreviewUrl = null;
    }
    activeMedia = null;
    primaryAction = null;
    secondaryAction = null;
    syncCaptureDockVisibility();
  }

  function showMediaPreview(media) {
    if (!media || !media.blob) return;

    clearTimeout(toastTimer);
    el.toast.classList.add('hidden');
    closeMediaPreview();
    activeMedia = media;
    activePreviewUrl = URL.createObjectURL(media.blob);

    const isPhoto = media.kind === 'photo';
    const sizeText = formatFileSize(media.blob.size);
    if (isPhoto) {
      el.previewMeta.textContent = `Фото готово · ${sizeText}`;
      el.previewImage.src = activePreviewUrl;
      el.previewImage.classList.remove('hidden');
    } else {
      const extUpper = (media.ext || 'mp4').toUpperCase();
      const durText = media.durationMs ? ` · ${formatDuration(media.durationMs)}` : '';
      el.previewMeta.textContent = `Видео ${extUpper}${durText} · ${sizeText}`;
      el.previewVideo.src = activePreviewUrl;
      el.previewVideo.muted = true;
      el.previewVideo.playsInline = true;
      el.previewVideo.classList.remove('hidden');
      el.previewVideo.play().catch(() => {});
    }

    const ios = isIOSDevice();
    const android = isAndroidDevice();
    const shareable = canShareFile(media.file);

    const runShare = async () => {
      if (!activeMedia?.file) return;
      const res = await shareMediaFile(activeMedia.file);
      if (res.ok) {
        showToast(
          isPhoto
            ? 'Готово! Фото в приложении «Фото»'
            : 'Готово! Видео в приложении «Фото»',
          3000,
        );
      } else if (!res.aborted) {
        downloadMediaFile(activeMedia.blob, activeMedia.filename);
        showToast('Файл скачан в «Загрузки»', 3000);
      }
    };

    const runDownload = () => {
      if (!activeMedia?.blob) return;
      downloadMediaFile(activeMedia.blob, activeMedia.filename);
      if (android) {
        showToast('Сохранено в Галерею и папку «Загрузки»', 3200);
      } else if (ios) {
        showToast('Отправлено в «Загрузки» Safari (приложение «Файлы»)', 3200);
      } else {
        showToast('Файл сохранён в «Загрузки»', 2800);
      }
    };

    if (ios && shareable) {
      el.btnPreviewPrimary.textContent = isPhoto
        ? 'Сохранить в «Фото»'
        : 'Сохранить видео в «Фото»';
      el.previewHint.textContent = isPhoto
        ? 'В меню iPhone выберите «Сохранить изображение» (или удерживайте фото пальцем).'
        : 'В меню iPhone выберите «Сохранить видео» — ролик попадёт прямо в «Фото».';
      primaryAction = runShare;

      el.btnPreviewSecondary.textContent = 'В «Файлы»';
      el.btnPreviewSecondary.classList.remove('hidden');
      secondaryAction = runDownload;
    } else if (ios && !shareable) {
      el.btnPreviewPrimary.textContent = 'Скачать файл';
      el.previewHint.textContent = isPhoto
        ? 'Удерживайте фото пальцем → «Сохранить в Фото», либо откройте ссылку в Safari.'
        : 'Чтобы сохранить видео прямо в «Фото», откройте эту ссылку в Safari.';
      primaryAction = runDownload;

      el.btnPreviewSecondary.classList.add('hidden');
      secondaryAction = null;
    } else {
      el.btnPreviewPrimary.textContent = android ? 'Сохранить в галерею' : 'Скачать файл';
      el.previewHint.textContent = android
        ? isPhoto
          ? 'Снимок сразу появится в Галерее и Google Фото.'
          : 'Видео сразу появится в Галерее и Google Фото.'
        : 'Файл сохранится в папку «Загрузки».';
      primaryAction = runDownload;

      if (shareable) {
        el.btnPreviewSecondary.textContent = 'Поделиться';
        el.btnPreviewSecondary.classList.remove('hidden');
        secondaryAction = runShare;
      } else {
        el.btnPreviewSecondary.classList.add('hidden');
        secondaryAction = null;
      }
    }

    el.previewModal.classList.remove('hidden');
    document.body.classList.add('is-preview-open');
    syncCaptureDockVisibility();
  }

  function formatSignedMeters(v) {
    const sign = v > 0 ? '+' : '';
    return `${sign}${v.toFixed(2)} м`;
  }

  function syncInputsFromSettings() {
    el.inpMountHeight.value = String(settings.mountHeightM);
    el.valMountHeight.textContent = `${settings.mountHeightM.toFixed(2)} м`;

    el.inpOffsetRight.value = String(settings.offsetRightM);
    el.valOffsetRight.textContent = formatSignedMeters(settings.offsetRightM);

    el.inpOffsetForward.value = String(settings.offsetForwardM);
    el.valOffsetForward.textContent = formatSignedMeters(settings.offsetForwardM);

    el.inpYaw.value = String(settings.yawOffsetDeg);
    el.valYaw.textContent = `${settings.yawOffsetDeg > 0 ? '+' : ''}${settings.yawOffsetDeg}°`;

    el.inpTargetWidth.value = String(settings.targetWidthMm);
    el.valTargetWidth.textContent = `${settings.targetWidthMm} мм`;

    el.chkTargetScale.checked = Boolean(settings.useTargetScaleCalibration);
    el.chkShowPlaque.checked = Boolean(settings.showPlaqueDebug);
    el.chkAutoRealign.checked = Boolean(settings.autoRealignOnPlaque);
  }

  function commitSettings() {
    saveSettings(settings);
    syncInputsFromSettings();
    onSettingsChanged?.();
  }

  // Camera capture controls
  el.btnModePhoto.addEventListener('click', () => setCaptureMode('photo'));
  el.btnModeVideo.addEventListener('click', () => setCaptureMode('video'));

  el.btnShutter.addEventListener('click', async () => {
    if (isFinalizing || isCapturingPhoto) return;

    if (captureMode === 'photo') {
      isCapturingPhoto = true;
      updateShutterAppearance();
      triggerShutterFlash();

      const res = await onTakePhoto?.();
      isCapturingPhoto = false;
      updateShutterAppearance();

      if (res && res.ok && res.media) {
        showMediaPreview(res.media);
      } else if (res && res.reason) {
        showToast(res.reason, 3200);
      }
      return;
    }

    if (!isRecording) {
      if (navigator.vibrate) {
        try {
          navigator.vibrate(20);
        } catch {
          // ignore
        }
      }
      const res = onStartVideo?.();
      if (res && !res.ok && res.reason) {
        showToast(res.reason, 3600);
      }
    } else {
      if (navigator.vibrate) {
        try {
          navigator.vibrate([15, 40, 15]);
        } catch {
          // ignore
        }
      }
      onStopVideo?.();
    }
  });

  // Preview modal actions (called directly in click handler for iOS Web Share gesture)
  el.btnPreviewPrimary.addEventListener('click', () => primaryAction?.());
  el.btnPreviewSecondary.addEventListener('click', () => secondaryAction?.());
  el.btnPreviewClose.addEventListener('click', closeMediaPreview);
  el.btnPreviewRetake.addEventListener('click', closeMediaPreview);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.previewModal.classList.contains('hidden')) {
      closeMediaPreview();
    }
  });

  // Bind sliders
  el.inpMountHeight.addEventListener('input', () => {
    settings.mountHeightM = parseFloat(el.inpMountHeight.value);
    commitSettings();
  });
  el.inpOffsetRight.addEventListener('input', () => {
    settings.offsetRightM = parseFloat(el.inpOffsetRight.value);
    commitSettings();
  });
  el.inpOffsetForward.addEventListener('input', () => {
    settings.offsetForwardM = parseFloat(el.inpOffsetForward.value);
    commitSettings();
  });
  el.inpYaw.addEventListener('input', () => {
    settings.yawOffsetDeg = parseInt(el.inpYaw.value, 10);
    commitSettings();
  });
  el.inpTargetWidth.addEventListener('input', () => {
    settings.targetWidthMm = parseInt(el.inpTargetWidth.value, 10);
    commitSettings();
  });
  el.chkTargetScale.addEventListener('change', () => {
    settings.useTargetScaleCalibration = el.chkTargetScale.checked;
    commitSettings();
  });
  el.chkShowPlaque.addEventListener('change', () => {
    settings.showPlaqueDebug = el.chkShowPlaque.checked;
    commitSettings();
  });
  el.chkAutoRealign.addEventListener('change', () => {
    settings.autoRealignOnPlaque = el.chkAutoRealign.checked;
    commitSettings();
  });

  // Bind ±5cm / ±10cm quick stepper buttons
  document.querySelectorAll('.btn-step').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.step;
      const delta = parseFloat(btn.dataset.delta);
      const bounds = {
        mountHeightM: [0.0, 2.3],
        offsetRightM: [-2.5, 2.5],
        offsetForwardM: [-1.0, 2.5],
      }[key];
      if (!bounds) return;
      const next = Math.round((settings[key] + delta) * 100) / 100;
      settings[key] = Math.min(bounds[1], Math.max(bounds[0], next));
      commitSettings();
    });
  });

  // Camera & Dev actions
  el.btnReset.addEventListener('click', () => {
    onReset?.();
    showToast('Позиция сброшена — наведите на табличку или нажмите «Поставить»');
  });

  el.btnPlaceHere.addEventListener('click', () => {
    const res = onPlaceHere?.();
    if (res && !res.ok && res.reason) {
      showToast(res.reason);
    } else if (res && res.ok) {
      showToast(
        res.isSlamReady
          ? 'Шурале поставлен сюда'
          : 'Поведите телефоном пару секунд и нажмите «Поставить» ещё раз',
        2600,
      );
    }
  });

  el.btnTorch.addEventListener('click', async () => {
    const res = await onToggleTorch?.();
    if (res && !res.ok && res.reason) {
      showToast(res.reason, 3600);
    }
  });

  el.btnSettings.addEventListener('click', () => {
    const isClosed = el.settingsDrawer.classList.contains('hidden');
    setDrawerOpen(isClosed);
  });

  el.btnCloseSettings.addEventListener('click', () => setDrawerOpen(false));

  el.btnPresetFull.addEventListener('click', () => {
    Object.assign(settings, PRESET_FULL_FLOOR);
    commitSettings();
    showToast('Режим: полный рост 1,6 м на полу');
  });

  el.btnPresetDesk.addEventListener('click', () => {
    Object.assign(settings, PRESET_DESK_MINI);
    commitSettings();
    showToast('Режим: мини-тест рядом с экраном (35 см)');
  });

  el.btnResetDefaults.addEventListener('click', () => {
    Object.assign(settings, DEFAULT_SETTINGS);
    commitSettings();
    showToast('Настройки возвращены по умолчанию');
  });

  el.btnTelemetry.addEventListener('click', () => {
    const nowHidden = el.telemetryBox.classList.toggle('hidden');
    el.btnTelemetry.setAttribute('aria-pressed', String(!nowHidden));
  });

  el.btnLicense.addEventListener('click', () => {
    el.licenseModal.classList.remove('hidden');
  });
  el.btnCloseLicense.addEventListener('click', () => {
    el.licenseModal.classList.add('hidden');
  });

  el.btnRetry.addEventListener('click', () => {
    el.errorOverlay.classList.add('hidden');
    onRetry?.();
  });

  syncInputsFromSettings();
  updateShutterAppearance();

  return {
    setCaptureAvailable(available) {
      captureAvailable = Boolean(available);
      syncCaptureDockVisibility();
    },
    setRecordingState,
    setRecordingProgress,
    showMediaPreview,
    setStatus(mode, text) {
      const cssMode = mode === 'calibrating' ? 'loading' : mode;
      el.statusPill.className = `status-pill status-${cssMode}`;
      el.statusText.textContent = text;
      const showHint = mode === 'searching' || mode === 'calibrating';
      el.scanHint.classList.toggle('hidden', !showHint);
      if (el.scanLabel) {
        el.scanLabel.textContent =
          mode === 'calibrating'
            ? 'Плавно поведите телефоном вбок'
            : 'Наведите на табличку или нажмите «Поставить»';
      }
    },
    setDirectionHint(text) {
      if (!text) {
        el.directionHint.classList.add('hidden');
      } else {
        el.directionHint.textContent = text;
        el.directionHint.classList.remove('hidden');
      }
    },
    setTorchState({ isOn }) {
      el.btnTorch.setAttribute('aria-pressed', String(Boolean(isOn)));
      el.torchLabel.textContent = isOn ? 'Свет вкл' : 'Свет';
    },
    updateTelemetry(info) {
      if (el.telemetryBox.classList.contains('hidden')) return;
      const modelStr = info.isModelLoaded
        ? `OK (${(info.modelLoadMs / 1000).toFixed(2)} с)`
        : 'загрузка...';
      const scaleStr =
        info.targetScale != null
          ? `${info.targetScale.toFixed(3)} (к-т ${info.unitsPerMeter.toFixed(2)}x)`
          : '—';
      const distStr = info.camDistM != null ? `${info.camDistM.toFixed(2)} м` : '—';
      const stateStr = info.isLocked
        ? 'HARD LOCK (SLAM)'
        : info.isTargetVisible
          ? `CALIBRATING (${info.sampleCount}/10)`
          : 'SEARCHING';
      const camYStr = info.camY != null ? `${info.camY.toFixed(2)} м` : '—';
      const shScaleStr = info.shuraleScale != null ? `${info.shuraleScale.toFixed(2)}x` : '1.00x';
      el.telemetryLines.textContent = [
        `Режим: ${stateStr} | SLAM: ${info.trackingStatus} | FPS: ${info.fps}`,
        `До Шурале: ${distStr} | Масштаб модели: ${shScaleStr} | CamY: ${camYStr}`,
        `GLB: ${modelStr} | Target scale: ${scaleStr}`,
      ].join('\n');
    },
    showError(title, message) {
      el.errorTitle.textContent = title;
      el.errorMessage.textContent = message;
      el.errorOverlay.classList.remove('hidden');
    },
    showToast,
  };
}
