import fs from 'node:fs/promises';
import path from 'node:path';

const PUBLIC_DIR = path.resolve('web/public');

async function copyFileEnsure(src, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

async function main() {
  // 1. Copy 8th Wall XR Engine binary (SLAM chunk + core + LICENSE + powered-by.svg)
  const xrSrcDir = path.resolve('node_modules/@8thwall/engine-binary/dist');
  const xrDestDir = path.join(PUBLIC_DIR, 'external/xr');
  const xrFiles = [
    'xr.js',
    'xr-slam.js',
    'LICENSE',
    'resources/powered-by.svg',
  ];
  for (const rel of xrFiles) {
    await copyFileEnsure(path.join(xrSrcDir, rel), path.join(xrDestDir, rel));
  }

  // 2. Copy optimized Shurale 3D model
  await copyFileEnsure(
    path.resolve('3D/Shurale_Happy_Idle_opt.glb'),
    path.join(PUBLIC_DIR, 'models/Shurale_Happy_Idle_opt.glb'),
  );

  // 3. Copy compiled 8th Wall image target JSON + luminance/thumbnail images
  const targetSrcDir = path.resolve('targets/shurale-a4/compiled');
  const targetDestDir = path.join(PUBLIC_DIR, 'image-targets');
  const targetFiles = [
    'target.json',
    'shurale-a4.json',
    'shurale-a4_luminance.png',
    'shurale-a4_thumbnail.png',
  ];
  for (const fn of targetFiles) {
    await copyFileEnsure(path.join(targetSrcDir, fn), path.join(targetDestDir, fn));
  }

  console.log('Synced WebAR runtime assets into web/public/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
