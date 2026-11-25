import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { getDefaultCrop } from '../node_modules/@8thwall/image-target-cli/src/crop.js';
import { applyCrop } from '../node_modules/@8thwall/image-target-cli/src/apply.js';

const SOURCE_IMAGE = path.resolve('targets/shurale-a4/shurale-a4-source-3x4.png');
const OUTPUT_DIR = path.resolve('targets/shurale-a4/compiled');
const TARGET_NAME = 'shurale-a4';

// Exact physical dimensions of the 3:4 tracked rectangle printed at 100% on A4
// (195.07 mm x 260.10 mm = 2304 x 3072 px @ 300 DPI)
const PHYSICAL_META = {
  targetName: TARGET_NAME,
  aspectRatio: '3:4',
  physicalWidthMm: 195,
  physicalHeightMm: 260,
  physicalWidthMeters: 0.195,
  physicalHeightMeters: 0.260,
  printPaper: 'A4 (210 x 297 mm) at 100% scale, matte paper, no lamination',
  note: 'Measure black outer tracking frame width with a tape measure after printing and update physicalWidthMeters in the WebAR app if printer scaling differs.',
};

async function main() {
  const image = sharp(SOURCE_IMAGE);
  const metadata = await image.metadata();
  const isLandscape = metadata.width >= metadata.height;
  const cropGeometry = getDefaultCrop(metadata, isLandscape);

  console.log('Source metadata:', { width: metadata.width, height: metadata.height, format: metadata.format });
  console.log('Computed 8th Wall planar crop:', cropGeometry);

  const { dataPath } = await applyCrop(
    image,
    { type: 'PLANAR', geometry: cropGeometry },
    OUTPUT_DIR,
    TARGET_NAME,
    true, // overwriteFiles
  );

  // Also create target.json alias/copy with metadata field populated for convenient import
  // while keeping the exact CLI-generated shurale-a4.json untouched!
  const rawJson = JSON.parse(await fs.readFile(dataPath, 'utf8'));
  rawJson.metadata = PHYSICAL_META;
  const targetJsonPath = path.join(OUTPUT_DIR, 'target.json');
  await fs.writeFile(targetJsonPath, `${JSON.stringify(rawJson, null, 2)}\n`);

  console.log('Compiled 8th Wall image target JSON:', dataPath);
  console.log('Written target.json with physical metadata:', targetJsonPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
