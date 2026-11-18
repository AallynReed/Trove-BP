// The (type, w) material model the editor edits.
import { roundHalfEven } from './bytes.js';
import { specularRgb, typeIndex, typeRgb } from './qb.js';

export const PALETTE = [
  [21, 'Solid', 'solid'],
  [18, 'Glass', 'glass'],
  [54, 'Tiled Glass', 'glass'],
  [55, 'Glowing Solid', 'solid'],
  [56, 'Glowing Glass', 'glass'],
];
export const SPECULAR_NAMES = ['Rough', 'Metal', 'Water', 'Iridescent', 'Waxy', 'Wave'];
export const NO_SPECULAR = 55;
export const GLASS_LEVELS = 8;
export const PLACEHOLDER_TYPE = 39;
const AUTHORED = [21, 18, 54, 55, 56, 24];

const INTERNAL_NAMES = {
  1: 'Terrain (dirt)', 2: 'Terrain (grass)', 3: 'Terrain (stone)', 4: 'Terrain (shadow)', 24: 'Placeable colour',
  28: 'Decorative', 38: 'Trigger', 39: 'Deco placeholder', 59: 'Attachment', 79: 'Terrain (ice)', 94: 'Collision',
  100: 'Terrain (snow)', 174: 'Terrain (lava)',
};

const entry = (t) => PALETTE.find((p) => p[0] === t) || null;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const alphaForW = (w) => 16 + 32 * clamp(w, 0, GLASS_LEVELS - 1);
const opacityPct = (w) => roundHalfEven((alphaForW(w) / 255) * 100);

export function isProcedural(t, r, g, b) {
  return !AUTHORED.includes(t) && Math.max(r, g, b) <= 24;
}

export const classOf = (t) => (entry(t) ? entry(t)[2] : 'solid');
export const isEditable = (t) => !!entry(t);

export function describe(t, w) {
  const e = entry(t);
  if (e) {
    if (e[2] === 'glass') return `${e[1]} - ${opacityPct(w)}% opacity`;
    if (t === NO_SPECULAR) return w === 0 ? e[1] : `${e[1]} - unused finish ${w}`;
    return `${e[1]} - ${SPECULAR_NAMES[w] ?? `finish ${w}`}`;
  }
  return INTERNAL_NAMES[t] ? `${INTERNAL_NAMES[t]} (type ${t})` : `Unknown type ${t}`;
}

const hex = (rgb) => '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');

export function palette() {
  const types = PALETTE.map(([t, label, cls]) => {
    let options;
    if (cls === 'glass') {
      options = [...Array(GLASS_LEVELS).keys()].map((w) => {
        const a = alphaForW(w);
        return { w, label: `${opacityPct(w)}%`, alpha: a, qb_map: '_a', qb: hex([a, a, a]) };
      });
    } else if (t === NO_SPECULAR) {
      options = [{ w: 0, label: SPECULAR_NAMES[0] }];
    } else {
      options = SPECULAR_NAMES.map((name, w) => {
        const q = specularRgb(w);
        return { w, label: name, qb_map: '_s', qb: q ? hex(q) : null };
      });
    }
    const q = typeRgb(typeIndex(t));
    return { type: t, label, class: cls, options, qb_map: '_t', qb: q ? hex(q) : null };
  });
  return { types, glass_levels: GLASS_LEVELS };
}

// [type, w] clamped to what the material allows; throws a message for non-editable types.
export function validate(t, w) {
  const e = entry(t);
  if (!e) throw new Error(`Type ${t} is not an editable material.`);
  if (e[2] === 'glass') return [t, clamp(w, 0, GLASS_LEVELS - 1)];
  if (t === NO_SPECULAR) return [t, 0];
  return [t, clamp(w, 0, SPECULAR_NAMES.length - 1)];
}
