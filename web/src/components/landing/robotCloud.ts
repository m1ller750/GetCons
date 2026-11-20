/**
 * The landing robot as a particle cloud, made from the GetCons robot 3D model (a white glossy
 * humanoid with dark joints and a glowing visor slit). The points were sampled offline from the
 * textured mesh: evenly spaced over the surface (denser on the head and chest, sparser on the
 * legs), coloured from the texture into material tones, with points hidden inside the shell
 * dropped and ambient occlusion measured from 64 view directions. They ship as one small binary
 * file (8 bytes per point), already in the scene's robot space: the chin sits at y ≈ 1.3, the top
 * of the head at y ≈ 2.4, the face looks towards +z.
 *
 * File layout (little-endian): "GCR1", uint32 count, float32 min xyz, float32 max xyz, then per
 * point uint32 position (x 10 bits, y 12 bits, z 10 bits within the box), int8×2 octahedral
 * normal, uint8 ambient occlusion, uint8 tone (low 4 bits) + head weight (high 4 bits). Points are
 * stored in random order, so any prefix is an even subsample of the whole body.
 */

export interface RobotCloud {
  count: number;
  /** xyz per point */
  positions: Float32Array;
  /** surface normal per point, for lighting; its length (0.3..1) is the ambient occlusion */
  normals: Float32Array;
  /** 0 = dark satin, 2 = gunmetal, 4 = white shell, 6 = visor light (glows) */
  tones: Float32Array;
  /** 0..1: how much the point follows head rotation */
  headWeights: Float32Array;
}

export function decodeRobotCloud(buffer: ArrayBuffer, wanted: number): RobotCloud {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'GCR1') throw new Error('Unknown robot cloud format');
  const total = view.getUint32(4, true);
  const min = [0, 1, 2].map((k) => view.getFloat32(8 + k * 4, true));
  const max = [0, 1, 2].map((k) => view.getFloat32(20 + k * 4, true));
  const packed = new Uint32Array(buffer, 32, total);
  const oct = new Int8Array(buffer, 32 + total * 4, total * 2);
  const occlusion = new Uint8Array(buffer, 32 + total * 6, total);
  const toneHead = new Uint8Array(buffer, 32 + total * 7, total);

  const count = Math.min(wanted, total);
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const tones = new Float32Array(count);
  const headWeights = new Float32Array(count);
  const scale = [(max[0]! - min[0]!) / 1023, (max[1]! - min[1]!) / 4095, (max[2]! - min[2]!) / 1023];
  for (let i = 0; i < count; i++) {
    const p = packed[i]!;
    positions[i * 3] = min[0]! + (p & 1023) * scale[0]!;
    positions[i * 3 + 1] = min[1]! + ((p >>> 10) & 4095) * scale[1]!;
    positions[i * 3 + 2] = min[2]! + ((p >>> 22) & 1023) * scale[2]!;

    let x = oct[i * 2]! / 127;
    let y = oct[i * 2 + 1]! / 127;
    const z = 1 - Math.abs(x) - Math.abs(y);
    if (z < 0) {
      const fx = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
      const fy = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
      x = fx;
      y = fy;
    }
    // Open surfaces keep full length; creases (armpits, between the legs) get darker.
    const length = (0.32 + 0.68 * Math.min(1, (occlusion[i]! / 255) * 1.15)) / (Math.hypot(x, y, z) || 1);
    normals[i * 3] = x * length;
    normals[i * 3 + 1] = y * length;
    normals[i * 3 + 2] = z * length;

    tones[i] = toneHead[i]! & 15;
    headWeights[i] = (toneHead[i]! >> 4) / 15;
  }
  return { count, positions, normals, tones, headWeights };
}

export async function loadRobotCloud(url: string, count: number, signal?: AbortSignal): Promise<RobotCloud> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Robot cloud: HTTP ${response.status}`);
  return decodeRobotCloud(await response.arrayBuffer(), count);
}
