const STORAGE_KEY = 'shurale_ar_settings_v1';

export const DEFAULT_SETTINGS = {
  // Height of the physical plaque center above the floor/ground (meters)
  // Default 1.30 m matches PLAN.md (home test ~1.3 m, outdoor ~1.2-1.5 m)
  mountHeightM: 1.30,

  // Lateral offset to the right of the plaque (+X in plaque frame, meters)
  offsetRightM: 1.20,

  // Forward offset out from the plaque plane (+Z toward viewer, meters)
  offsetForwardM: 0.35,

  // Extra Y-axis rotation of Shurale relative to facing forward out of plaque (degrees)
  yawOffsetDeg: 0,

  // Actual tape-measured width of the black outer 3:4 tracking frame (mm)
  // Designed print size at 100% on A4 is 195 x 260 mm (aspect 3:4)
  targetWidthMm: 195,

  // Calibrate real-world meter scale directly from physical plaque size (detail.scale / targetHeightM)
  // Prevents wrong initial scale before SLAM absolute scale finishes converging!
  useTargetScaleCalibration: true,

  // Show green wireframe outline on the plaque while it is in view
  showPlaqueDebug: true,
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
