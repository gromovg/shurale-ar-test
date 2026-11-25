import {
  DEFAULT_SETTINGS,
  PRESET_FULL_FLOOR,
  PRESET_DESK_MINI,
  saveSettings,
} from './config.js';

export function createUIController({
  settings,
  onSettingsChanged,
  onReset,
  onToggleTorch,
  onRetry,
}) {
  const el = {
    statusPill: document.getElementById('status-pill'),
    statusText: document.getElementById('status-text'),
    scanHint: document.getElementById('scan-hint'),
    directionHint: document.getElementById('direction-hint'),
    btnPresetFull: document.getElementById('btn-preset-full'),
    btnPresetDesk: document.getElementById('btn-preset-desk'),
    btnTelemetry: document.getElementById('btn-telemetry'),
    telemetryBox: document.getElementById('telemetry-box'),
    telemetryLines: document.getElementById('telemetry-lines'),
    btnReset: document.getElementById('btn-reset'),
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

  function showToast(msg, durationMs = 2600) {
    el.toast.textContent = msg;
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.classList.add('hidden');
    }, durationMs);
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

  // Action bar buttons
  el.btnReset.addEventListener('click', () => {
    onReset?.();
    showToast('Позиция сброшена — наведите на табличку');
  });

  el.btnTorch.addEventListener('click', async () => {
    const res = await onToggleTorch?.();
    if (res && !res.ok && res.reason) {
      showToast(res.reason, 3600);
    }
  });

  const setDrawerOpen = (open) => {
    el.settingsDrawer.classList.toggle('hidden', !open);
    el.btnSettings.setAttribute('aria-pressed', String(open));
  };

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
    el.telemetryBox.classList.toggle('hidden');
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

  return {
    setStatus(mode, text) {
      el.statusPill.className = `status-pill status-${mode}`;
      el.statusText.textContent = text;
      el.scanHint.classList.toggle('hidden', mode !== 'searching');
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
      el.torchLabel.textContent = isOn ? 'Фонарик ВКЛ' : 'Фонарик';
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
      el.telemetryLines.textContent = [
        `Режим: ${stateStr} | SLAM: ${info.trackingStatus} | FPS: ${info.fps}`,
        `Модель GLB: ${modelStr} | До Шурале: ${distStr}`,
        `Target scale: ${scaleStr} | Рамка: ${settings.targetWidthMm} мм`,
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
