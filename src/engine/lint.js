// The Trove Creations checks, run on a compiled blueprint.
import { commas } from './bytes.js';
import { attachment as attachmentOf } from './codec.js';
import { isProcedural } from './materials.js';

export const DIMENSIONS = [
  ['melee', [10, 10, 35]], ['gun', [5, 12, 5]], ['staff', [12, 12, 35]], ['bow', [3, 9, 21]], ['fist', [6, 9, 5]],
  ['spear', [11, 11, 45]], ['mask', [10, 10, 5]], ['hat', [20, 14, 20]], ['hair', [20, 14, 20]], ['deco', [12, 12, 12]],
];
const NEEDS_ATTACHMENT = ['melee', 'gun', 'staff', 'bow', 'spear', 'fist', 'mask', 'hat', 'hair'];

export const creationTypes = () => [...DIMENSIONS.map(([k]) => k), 'other'];

const finding = (level, title, body, voxels = []) => ({ level, title, body, voxels });
const plural = (n) => (n !== 1 ? 's are' : ' is');

function dimensions(kind, [sx, sy, sz]) {
  const d = DIMENSIONS.find(([k]) => k === kind);
  if (!d) return [];
  const [lx, ly, lz] = d[1];
  if (sx <= lx && sy <= ly && sz <= lz) return [];
  const rotations = [[sx, sz, sy], [sy, sx, sz], [sy, sz, sx], [sz, sx, sy], [sz, sy, sx]];
  if (rotations.some(([a, b, c]) => a <= lx && b <= ly && c <= lz)) {
    return [finding('error', 'The model is facing the wrong way',
      `A ${kind} should fit within ${lx}x${ly}x${lz}, and yours (${sx}x${sy}x${sz}) would if it were turned. Use the rotate buttons under 'Turn it' - weapons point forward along the long axis, hats point up.`)];
  }
  return [finding('error', 'The model is too big', `A ${kind} should not exceed ${lx}x${ly}x${lz} voxels, but yours is ${sx}x${sy}x${sz}.`)];
}

// Cells in first-insertion order, each with the last voxel index that held it.
function cellIndex(doc) {
  const at = new Map();
  const order = [];
  doc.voxels.forEach((v, i) => {
    const k = v.x + ',' + v.y + ',' + v.z;
    const slot = at.get(k);
    if (slot !== undefined) order[slot][1] = i;
    else { at.set(k, order.length); order.push([[v.x, v.y, v.z], i]); }
  });
  return { at, order, has: (x, y, z) => at.has(x + ',' + y + ',' + z) };
}

function floating(cells) {
  if (!cells.order.length) return [];
  const start = cells.order[0][0];
  const seen = new Set([start.join(',')]);
  const queue = [start];
  for (let q = 0; q < queue.length; q++) {
    const [x, y, z] = queue[q];
    for (const n of [[x + 1, y, z], [x - 1, y, z], [x, y + 1, z], [x, y - 1, z], [x, y, z + 1], [x, y, z - 1]]) {
      const k = n.join(',');
      if (cells.at.has(k) && !seen.has(k)) { seen.add(k); queue.push(n); }
    }
  }
  const stray = cells.order.filter(([c]) => !seen.has(c.join(','))).map(([, i]) => i);
  if (!stray.length) return [];
  return [finding('warning', `${commas(stray.length)} voxel${plural(stray.length)} not connected to the model`,
    'These only touch the rest of the model at a corner, or not at all. Trove renders them, but the style guide asks for face-connected geometry.', stray)];
}

function attachmentChecks(kind, attach, [sx, sy, sz], cells) {
  const out = [];
  if (!attach) {
    if (NEEDS_ATTACHMENT.includes(kind)) {
      out.push(finding('warning', 'This model stores no attachment point',
        "Older blueprints (format v3/v4) don't record an origin, so there's nothing to check and nothing to show. The game positions these by other means."));
    }
    return out;
  }
  const [ax, ay, az] = attach;
  if (['melee', 'staff', 'bow', 'spear', 'gun', 'fist'].includes(kind) && !cells.has(ax, ay, az)) {
    out.push(finding('warning', "The attachment point isn't on a voxel",
      `The hand grips (${ax}, ${ay}, ${az}), but there's no voxel there. On a weapon the attachment point should sit inside the handle.`));
  }
  if (['melee', 'staff', 'bow'].includes(kind)) {
    const limit = kind === 'bow' ? 3 : 4;
    if (ay > limit || sy - ay > 6) {
      out.push(finding('warning', 'The handle sits too high or too low',
        `There shouldn't be more than 5 voxels above or ${limit} below the attachment point; yours has ${sy - ay - 1} above and ${ay} below.`));
    }
    const blocked = cells.order
      .filter(([[x, y, z]]) => Math.abs(x - ax) <= 1 && Math.abs(y - ay) <= 1 && Math.abs(z - az) <= 1 && !(x === ax && y === ay))
      .map(([, i]) => i);
    if (blocked.length) {
      out.push(finding('warning', 'The grip is crowded',
        'Around the attachment point there should be nothing in a 3x3x3 cube except the handle running lengthwise - that space is the hand.', blocked));
    }
  }
  if (kind === 'staff') {
    if (az < 8 || az > 14) out.push(finding('warning', 'The staff handle is the wrong length', `The handle behind the attachment point should be 8-14 voxels; yours is ${az}.`));
    if (sz - az < 17) {
      out.push(finding('warning', 'The staff head is too close to the grip',
        `There should be at least 16 voxels between the attachment point and the tip; yours has ${sz - az - 1}.`));
    }
  }
  if (kind === 'spear' && (az < 8 || az > 12)) {
    out.push(finding('warning', 'The spear grip is in the wrong place', `The attachment point should be 9-13 voxels from the base of the shaft; yours is ${az + 1}.`));
  }
  if (kind === 'gun' && az !== 0) {
    out.push(finding('warning', "There's geometry behind the grip", `A gun's attachment point should sit at the back of the model (z = 0); yours is at z = ${az}.`));
  }
  if (kind === 'hat' || kind === 'hair') {
    if (ay > -6) {
      out.push(finding('error', "The model isn't high enough above its attachment point",
        `The attachment point should be at least 6 voxels below the model (the head fills that space); yours is ${ay < 0 ? -ay : 0}.`));
    }
    if (ax > 10 || sx - ax > 10 || az > 9 || sz - az > 11) {
      out.push(finding('warning', 'The model is off-centre over the head',
        `There shouldn't be more than ~10 voxels to any side of the attachment point; yours reaches ${ax} right, ${sx - ax - 1} left, ${az} back, ${sz - az - 1} front.`));
    }
  }
  if (kind === 'mask') {
    if (az > -6) {
      out.push(finding('error', "The mask isn't far enough in front of its attachment point",
        `The attachment point should be 6 voxels behind the mask (that space is the head); yours is ${az < 0 ? -az : 0}.`));
    }
    if (ax > 5 || sx - ax > 5 || ay > 4 || sy - ay > 6) {
      out.push(finding('warning', 'The mask is off-centre on the face',
        `There shouldn't be more than ~5 voxels to any side of the attachment point; yours reaches ${ax} right, ${sx - ax - 1} left, ${sy - ay - 1} up, ${ay} down.`));
    }
  }
  return out;
}

export function check(doc, kindIn) {
  const kind = creationTypes().includes(kindIn) ? kindIn : 'other';
  const attach = attachmentOf(doc);
  const cells = cellIndex(doc);
  let findings = [...dimensions(kind, doc.size)];
  if (kind === 'spear' && doc.size[2] !== 45) {
    findings.push(finding('error', 'A spear has to be exactly 45 voxels long', `Yours is ${doc.size[2]}. The game positions the shaft assuming that length.`));
  }
  if (kind === 'bow' && doc.size[0] > 3 && doc.size[0] <= 5) {
    findings.push(finding('warning', 'This bow is thicker than the guidelines allow',
      `A bow should be at most 3 voxels thick; yours is ${doc.size[0]}. Up to 5 is sometimes accepted if the design really needs it.`));
  }
  const dark = [];
  doc.voxels.forEach((v, i) => {
    if (!isProcedural(v.ty, v.r, v.g, v.b) && Math.min(v.r, v.g, v.b) + Math.max(v.r, v.g, v.b) < 20) dark.push(i);
  });
  if (dark.length) {
    findings.push(finding('error', `${commas(dark.length)} voxel${plural(dark.length)} almost black`,
      "Trove's style guide asks for nothing darker than (10, 10, 10) - pure black reads as a hole in game. Use a dark grey instead.", dark));
  }
  if (kind !== 'deco') findings.push(...floating(cells));
  if (doc.voxels.every((v) => v.ty === 21 && v.w === 0)) {
    findings.push(finding('info', 'No materials are used',
      'Every voxel is a plain rough solid. Glass, glowing and the metal/waxy/iridescent finishes are what give a model depth in game - worth trying where they suit the design.'));
  }
  if (kind !== 'other') findings.push(...attachmentChecks(kind, attach, doc.size, cells));
  const rank = (l) => (l === 'error' ? 0 : l === 'warning' ? 1 : 2);
  findings = findings.map((f, i) => [f, i]).sort((a, b) => rank(a[0].level) - rank(b[0].level) || a[1] - b[1]).map(([f]) => f);

  const satisfied = ["A blueprint stores one material per voxel, so alpha-on-solid and specular-on-glass - two of the classic .qb mistakes - can't happen here."];
  if (!findings.some((f) => f.title.endsWith('almost black'))) satisfied.push('No near-black voxels.');
  if (attach && NEEDS_ATTACHMENT.includes(kind)) satisfied.push(`Attachment point recorded at (${attach[0]}, ${attach[1]}, ${attach[2]}).`);
  const count = (l) => findings.filter((f) => f.level === l).length;
  return { kind, attachment: attach, findings, satisfied, counts: { error: count('error'), warning: count('warning'), info: count('info') } };
}
