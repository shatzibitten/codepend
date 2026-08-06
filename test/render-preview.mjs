/* Render the fixture payloads to /tmp for eyeballing. `node test/render-preview.mjs` */
import { writeFileSync } from 'node:fs';
import { renderHTML } from '../src/render.js';
import { payload, thinPayload } from './fixture-payload.mjs';

const out = process.argv[2] || '/tmp/codepend-preview.html';
writeFileSync(out, renderHTML(payload, { version: '0.1.0', redact: 'safe' }));
writeFileSync('/tmp/codepend-preview-thin.html', renderHTML(thinPayload, { version: '0.1.0', redact: 'safe' }));
writeFileSync('/tmp/codepend-preview-empty.html', renderHTML(
  { profile: {}, memories: [], stats: {}, timeline: [] }, { version: '0.1.0' }));

const size = (p) => (Buffer.byteLength(renderHTML(payload)) / 1024).toFixed(0);
console.log(`wrote ${out} (${size()} KB), /tmp/codepend-preview-thin.html, /tmp/codepend-preview-empty.html`);
