const STORAGE_KEY = 'shurale_ar_settings_v3';

export const DEFAULT_SETTINGS = {
  // Height of the physical plaque/monitor center above the floor (meters)
  // Set to user's measured monitor center height: 1.01 m
  mountHeightM: 1.01,

  // Lateral offset to the right of the plaque (+X in plaque frame, meters)
  offsetRightM: 0.85,

  // Forward offset out from the plaque plane (+Z toward viewer, meters)
  offsetForwardM: 0.50,

  // Extra Y-axis rotation of Shurale relative to facing forward out of plaque (degrees)
  yawOffsetDeg: 0,

  // Character scale multiplier (1.0 = strict static 1.60 m height in absolute SLAM meters)
  modelScale: 1.0,

  // Actual tape-measured width of the black outer 3:4 tracking frame (mm)
  // Set to user's measured monitor frame width: 170 mm (17 cm)
  targetWidthMm: 170,

  // In scale: 'absolute' mode, SLAM already runs in true 1:1 meters, so keep scale strictly 1.0!
  useTargetScaleCalibration: false,

  // Show green wireframe outline on the plaque while it is in view
  showPlaqueDebug: true,

  // Keep Shurale hard-locked in SLAM world after initial calibration (prevents angle-jitter jumps).
  autoRealignOnPlaque: false,
};

export const PRESET_FULL_FLOOR = {
  mountHeightM: 1.30,
  offsetRightM: 1.20,
  offsetForwardM: 0.35,
  yawOffsetDeg: 0,
  modelScale: 1.0,
  targetWidthMm: 195,
};

export const PRESET_DESK_MINI = {
  mountHeightM: 0.13,
  offsetRightM: 0.22,
  offsetForwardM: 0.08,
  yawOffsetDeg: 0,
  modelScale: 0.22,
  targetWidthMm: 170,
};

export const TARGET_ASPECT_W_OVER_H = 3 / 4; // 0.75 (portrait 3:4)

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore private-mode storage errors
  }
}

export function getTargetPhysicalHeightM(settings) {
  const widthM = settings.targetWidthMm / 1000;
  return widthM / TARGET_ASPECT_W_OVER_H; // e.g. 0.195 / 0.75 = 0.260 m
}
