import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMeshQuantization } from '@gltf-transform/extensions';
import { dedup, prune, textureCompress } from '@gltf-transform/functions';

const INPUT_PATH = path.resolve('3D/Shurale_Happy_Idle.glb');
const OUTPUT_PATH = path.resolve('3D/Shurale_Happy_Idle_opt.glb');

// Verified measurements from 3D/Shurale_Happy_Idle.glb:
// - Rest pose skinned bbox Y: [-0.0095054498 .. +0.0094874501], height = 0.0189929
// - Happy_Idle animated skinned bbox across all 49 frames:
//   Y_min = [-0.0000964 .. -0.0000915] (median -0.0000957)
//   Y_max = [+0.0191531 .. +0.0192925] (median +0.0192366)
//   Median animated height = 0.0193328
const TARGET_HEIGHT_METERS = 1.60;
const ANIM_MEDIAN_HEIGHT = 0.0193328;
const REST_Y_MIN = -0.00950544979423285;
const ANIM_Y_MIN = -0.0000964; // lowest vertex across all 49 frames so feet never dip below Y=0

const SCALE = TARGET_HEIGHT_METERS / ANIM_MEDIAN_HEIGHT;
const DY_BIND = -SCALE * REST_Y_MIN; // puts rest pose feet at Y = 0.0000
const DY_ANIM = -SCALE * ANIM_Y_MIN; // puts animated Happy_Idle feet at Y = 0.0000..+0.0004

async function main() {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(INPUT_PATH);
  const root = doc.getRoot();

  console.log(`Loaded ${INPUT_PATH}`);
  console.log(`Scale factor: ${SCALE.toFixed(6)} (target height ${TARGET_HEIGHT_METERS}m)`);
  console.log(`DY_BIND: ${DY_BIND.toFixed(6)}m, DY_ANIM: ${DY_ANIM.toFixed(6)}m`);

  // 1. Transform mesh POSITION attributes: p' = S * p + [0, DY_BIND, 0]
  //    Keep POSITION as native Float32 meters so bboxMin/bboxMax are exact meters
  //    in every viewer & Three.js frustum culling.
  //    Convert WEIGHTS_0 (Float32 -> Uint8 normalized, glTF 2.0 core) and
  //    TEXCOORD_0 (Float32 -> Uint16 normalized if within [0,1], glTF 2.0 core)
  //    for zero-decoder compatibility + compact size!
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const posAttr = prim.getAttribute('POSITION');
      if (posAttr) {
        const arr = posAttr.getArray();
        const next = new Float32Array(arr.length);
        for (let i = 0; i < arr.length; i += 3) {
          next[i] = arr[i] * SCALE;
          next[i + 1] = arr[i + 1] * SCALE + DY_BIND;
          next[i + 2] = arr[i + 2] * SCALE;
        }
        posAttr.setArray(next);
      }

      // Pack WEIGHTS_0 into glTF 2.0 core UNSIGNED_BYTE normalized (exact sum = 255 per vertex)
      const wAttr = prim.getAttribute('WEIGHTS_0');
      if (wAttr && wAttr.getArray() instanceof Float32Array) {
        const arr = wAttr.getArray();
        const packed = new Uint8Array(arr.length);
        for (let i = 0; i < arr.length; i += 4) {
          const w0 = Math.max(0, arr[i]);
          const w1 = Math.max(0, arr[i + 1]);
          const w2 = Math.max(0, arr[i + 2]);
          const w3 = Math.max(0, arr[i + 3]);
          const sum = w0 + w1 + w2 + w3 || 1;
          let b0 = Math.round((w0 / sum) * 255);
          let b1 = Math.round((w1 / sum) * 255);
          let b2 = Math.round((w2 / sum) * 255);
          let b3 = Math.round((w3 / sum) * 255);
          // Fix rounding drift on the largest component so sum == 255
          const diff = 255 - (b0 + b1 + b2 + b3);
          if (diff !== 0) {
            const vals = [b0, b1, b2, b3];
            let maxIdx = 0;
            for (let k = 1; k < 4; k++) if (vals[k] > vals[maxIdx]) maxIdx = k;
            vals[maxIdx] = Math.min(255, Math.max(0, vals[maxIdx] + diff));
            [b0, b1, b2, b3] = vals;
          }
          packed[i] = b0;
          packed[i + 1] = b1;
          packed[i + 2] = b2;
          packed[i + 3] = b3;
        }
        wAttr.setArray(packed).setNormalized(true);
      }

      // Pack NORMAL into KHR_mesh_quantization SHORT normalized (16-bit precision, saves ~400 KB)
      // while keeping POSITION as native Float32 meters so bboxMin/bboxMax stay exact meters!
      const nAttr = prim.getAttribute('NORMAL');
      if (nAttr && nAttr.getArray() instanceof Float32Array) {
        doc.createExtension(KHRMeshQuantization).setRequired(true);
        const arr = nAttr.getArray();
        const packed = new Int16Array(arr.length);
        for (let i = 0; i < arr.length; i++) {
          const v = Math.max(-1, Math.min(1, arr[i]));
          packed[i] = Math.round(v * 32767);
        }
        nAttr.setArray(packed).setNormalized(true);
      }

      // Pack TEXCOORD_0 into glTF 2.0 core UNSIGNED_SHORT normalized if within [0, 1]
      const uvAttr = prim.getAttribute('TEXCOORD_0');
      if (uvAttr && uvAttr.getArray() instanceof Float32Array) {
        const arr = uvAttr.getArray();
        let inUnitRange = true;
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] < 0 || arr[i] > 1) {
            inUnitRange = false;
            break;
          }
        }
        if (inUnitRange) {
          const packed = new Uint16Array(arr.length);
          for (let i = 0; i < arr.length; i++) {
            packed[i] = Math.round(arr[i] * 65535);
          }
          uvAttr.setArray(packed).setNormalized(true);
        }
      }
    }
  }

  // 2. Transform node translations:
  //    - For root joint (mixamorig:Hips): t' = S * t + [0, DY_BIND, 0]
  //    - For all other nodes: t' = S * t
  const skins = root.listSkins();
  const rootJoint = skins[0]?.getSkeleton();
  for (const node of root.listNodes()) {
    const t = node.getTranslation();
    const dy = (node === rootJoint) ? DY_BIND : 0;
    node.setTranslation([t[0] * SCALE, t[1] * SCALE + dy, t[2] * SCALE]);
  }

  // 3. Transform Skin Inverse Bind Matrices:
  //    Exact transform for v' = S*v + D_bind:
  //      M'_linear = M_linear
  //      b' = S * b - M_linear * [0, DY_BIND, 0]
  for (const skin of skins) {
    const ibmAcc = skin.getInverseBindMatrices();
    if (!ibmAcc) continue;
    const arr = ibmAcc.getArray();
    const next = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i += 16) {
      for (let k = 0; k < 16; k++) next[i + k] = arr[i + k];
      next[i + 12] = arr[i + 12] * SCALE - arr[i + 4] * DY_BIND;
      next[i + 13] = arr[i + 13] * SCALE - arr[i + 5] * DY_BIND;
      next[i + 14] = arr[i + 14] * SCALE - arr[i + 6] * DY_BIND;
    }
    ibmAcc.setArray(next);
  }

  // 4. Transform Animation translation channels:
  //    - For root joint (mixamorig:Hips): t_anim'(f) = S * t_anim(f) + [0, DY_ANIM, 0]
  const seenSamplers = new Set();
  for (const anim of root.listAnimations()) {
    for (const ch of anim.listChannels()) {
      if (ch.getTargetPath() !== 'translation') continue;
      const sampler = ch.getSampler();
      if (!sampler || seenSamplers.has(sampler)) continue;
      seenSamplers.add(sampler);
      const outAcc = sampler.getOutput();
      if (!outAcc) continue;
      const arr = outAcc.getArray();
      const next = new Float32Array(arr.length);
      const dy = (ch.getTargetNode() === rootJoint) ? DY_ANIM : 0;
      for (let i = 0; i < arr.length; i += 3) {
        next[i] = arr[i] * SCALE;
        next[i + 1] = arr[i + 1] * SCALE + dy;
        next[i + 2] = arr[i + 2] * SCALE;
      }
      outAcc.setArray(next);
    }
  }

  // 5. Compress 2048x2048 JPEG texture (3.0 MB) to crisp WebP (~470 KB) + clean up unused nodes
  await doc.transform(
    dedup(),
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      resize: [2048, 2048],
      quality: 80,
    }),
    prune(),
  );

  await io.write(OUTPUT_PATH, doc);
  const origSize = fs.statSync(INPUT_PATH).size;
  const optSize = fs.statSync(OUTPUT_PATH).size;
  console.log(`Written ${OUTPUT_PATH}`);
  console.log(`Size: ${(origSize / 1024 / 1024).toFixed(2)} MB -> ${(optSize / 1024 / 1024).toFixed(2)} MB (${(100 * optSize / origSize).toFixed(1)}%)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
