import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
export const fixture = (name) => new Uint8Array(readFileSync(here(name)));
export const expected = JSON.parse(readFileSync(here('expected.json'), 'utf8'));
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const VERSIONS = ['tiny-v3', 'tiny-v4', 'tiny-v5'];
