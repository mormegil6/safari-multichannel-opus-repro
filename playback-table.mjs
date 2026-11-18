#!/usr/bin/env node
// Print the README playback table from the JSON files that playback.mjs wrote
// into playback-results/. The cells come from the first file. Every further
// file is compared with it, and the last line says whether the runs agree.
//
// usage: node playback-table.mjs playback-results/*.json
import fs from 'node:fs';
import path from 'node:path';

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node playback-table.mjs playback-results/*.json'); process.exit(2); }

const PATHS = { element: 'audio element', mse: 'MSE' };
const ERRORS = { 1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
const clip = file => { const m = /^opus(\d+)\.(\w+)$/.exec(file); return `${m[1]}-ch ${m[2] === 'webm' ? 'WebM' : 'fMP4'}`; };
const fired = (t, name) => (t.events || []).some(e => e.split(' ')[1] === name);

// What the page recorded about one test, as short phrases in a fixed order.
function reported(t) {
  if (t.noResult || t.crashed) return 'no result from the page';
  const f = t.final || {};
  const parts = [];
  if (t.path === 'element') parts.push(`\`canPlayType\` "${t.canPlayType}"`);
  else {
    parts.push(`\`isTypeSupported\` ${t.isTypeSupported}`);
    if (t.addSourceBuffer !== 'ok') { parts.push('`addSourceBuffer` ' + String(t.addSourceBuffer).replace(/^threw (\w+):.*$/, 'throws $1')); return parts.join('; '); }
    parts.push('`addSourceBuffer` accepts the type');
    parts.push(t.append === 'updateend' ? `\`appendBuffer\` completes ${t.sourceBufferError ? 'with' : 'without'} an \`error\` event` : '\`appendBuffer\`: ' + t.append);
    const b = t.sourceBufferBuffered || [];
    parts.push(b.length ? 'buffered ' + b.map(r => Array.isArray(r) ? `${r[0].toFixed(2)} to ${r[1].toFixed(2)} s` : r).join(', ') : 'nothing buffered');
  }
  parts.push(f.error ? `the element reports error ${f.error.code}${ERRORS[f.error.code] ? ' (`' + ERRORS[f.error.code] + '`)' : ''}` : 'the element reports no error');
  parts.push('duration ' + (typeof f.duration !== 'number' ? 'not known' : f.duration === 0 ? '0' : f.duration.toFixed(2) + ' s'));
  parts.push(fired(t, 'playing') ? (f.ended ? 'plays to the end' : 'starts playing and stops at ' + f.currentTime + ' s') : fired(t, 'ended') ? '`ended` fires without `playing`' : 'never plays');
  parts.push('`play()` ' + String(t.playPromise).replace(/^rejected, (\w+):.*$/, 'rejects with $1').replace(/^resolved$/, 'resolves').replace(/^still pending after 3 s$/, 'is still pending after 3 s'));
  return parts.join('; ');
}

// What the recording of the output device holds. `coarse` rounds the levels to
// whole decibels, so that two runs can be compared.
function recorded(t, coarse) {
  const h = t.heard || {};
  if (h.error || !h.tones) return 'no recording';
  if (h.nonzeroSamples.every(n => n === 0)) return 'silence, every sample zero';
  const sides = ['left', 'right'];
  const level = v => coarse ? String(Math.round(v)) : v.toFixed(1);
  const cells = h.tones.map((list, c) => {
    const side = sides[c] || 'channel ' + c;
    if (!list.length) return `none of the clips' tones ${side}`;
    const top = Math.max(...list.map(x => x.dbfs));
    const near = list.filter(x => x.dbfs > top - 20).sort((a, b) => a.hz - b.hz);
    return near.length === 1 ? `${near[0].hz} Hz at ${level(top)} dBFS ${side}` : `${near.length} tones from ${near[0].hz} to ${near[near.length - 1].hz} Hz ${side}, the strongest at ${level(top)} dBFS`;
  });
  return cells.join(', ');
}

const runs = files.map(f => ({ name: path.basename(f), ...JSON.parse(fs.readFileSync(f, 'utf8')) }));
const first = runs[0];
console.log(`Safari ${first.safari}${first.safariBuild ? ' (build ' + first.safariBuild + ')' : ''}, macOS ${first.macos}, ${first.when}, ${first.name}`);
console.log('');
console.log('| Path and clip | What the page recorded | Recorded from the output device |');
console.log('|---|---|---|');
for (const t of first.tests) console.log(`| ${PATHS[t.path]}, ${clip(t.file)} | ${reported(t)} | ${recorded(t, false)} |`);
console.log('');

const key = run => run.tests.map(t => `${t.path} ${t.file}: ${reported(t)} | ${recorded(t, true)}`);
const warned = runs.filter(r => r.captureWarning || r.failed);
for (const r of warned) console.log(`${r.name}: ${r.failed || r.captureWarning}`);
let differences = 0;
const base = key(first);
for (const r of runs.slice(1)) {
  key(r).forEach((line, i) => {
    if (line !== base[i]) { differences++; console.log(`${r.name} differs from ${first.name}:\n  ${line}\n  ${base[i]}`); }
  });
  if (r.safari !== first.safari || r.safariBuild !== first.safariBuild || r.macos !== first.macos) console.log(`${r.name} is another build: Safari ${r.safari} (${r.safariBuild}), macOS ${r.macos}`);
}
console.log(differences ? `${differences} cells differ between the ${runs.length} runs` : runs.length > 1 ? `the ${runs.length} runs agree in every cell (levels compared to the nearest decibel)` : 'one run');
process.exit(differences || warned.length ? 1 : 0);
