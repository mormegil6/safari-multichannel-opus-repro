#!/usr/bin/env node
// Print the README status table from the JSON files in results/, one column
// per file, in the order given. Every cell is derived from what the page
// recorded; nothing is typed by hand.
//
// usage: node status-table.mjs results/*.json
//
// File names carry the column heading: <date>-<os><version>-<browser><version>[-<device>].json,
// for example 2026-09-12-macos15.7.9-safari27.0.json or
// 2026-09-12-ios18.7-safari18.7.7-iphoneXs.json.
import fs from 'node:fs';
import path from 'node:path';

const NAMES = { macos: 'macOS', ios: 'iOS', windows: 'Windows', linux: 'Linux', safari: 'Safari', chrome: 'Chrome', firefox: 'Firefox', iphonexs: 'iPhone Xs' };
const pretty = tok => {
  const m = /^([a-z]+)(.*)$/i.exec(tok);
  if (!m) return tok;
  const word = NAMES[m[1].toLowerCase()] || m[1];
  return m[2] ? word + ' ' + m[2] : word;
};
function heading(file) {
  const parts = path.basename(file, '.json').split('-');
  const [os, browser, ...rest] = parts.slice(3);
  return pretty(browser) + ', ' + pretty(os) + (rest.length ? ' (' + rest.map(pretty).join(', ') + ')' : '') + ', ' + parts.slice(0, 3).join('-');
}

const cell = (r, surface, asset, container) => (((r.surfaces || {})[surface] || {})[asset] || {})[container];

function isTypeSupported(r, container) {
  const c = cell(r, 'isTypeSupported', 'opus16', container);
  if (!c) return 'not run';
  const impls = ['MediaSource', 'ManagedMediaSource'];
  const present = impls.filter(i => r.mediaSource && r.mediaSource[i]);
  const absent = impls.filter(i => !(r.mediaSource && r.mediaSource[i]));
  const answers = present.map(i => i + ' ' + String(c.answers[i]));
  return answers.join(', ') + (absent.length ? ' (no ' + absent.join(', no ') + ')' : '');
}

function decodeAudioData(r, asset, container) {
  const c = cell(r, 'decodeAudioData', asset, container);
  if (!c) return 'not run';
  if (c.decoded) return c.channels + ' ch, ladder ' + (c.ladderOk ? 'in order' : 'WRONG');
  return 'refused (' + (c.error || c.text) + ')';
}

function webcodecs(r, asset) {
  const c = cell(r, 'webcodecs', asset, 'packets');
  if (!c) return 'not run';
  if (c.present === false) return 'no AudioDecoder';
  if (c.isConfigSupported !== true) return 'isConfigSupported ' + String(c.isConfigSupported);
  if (!c.frames) return 'supported, but decoded no frames' + (c.error ? ' (' + c.error + ')' : '');
  const decoded = c.frames + ' frames, ' + c.channels + ' ch ' + (c.ladderOk ? 'in order' : 'WRONG') + (c.realtimeFactor ? ', ' + c.realtimeFactor + 'x realtime' : '');
  return (c.ok ? 'supported, ' : 'supported, but FAILED: ') + decoded + (c.error ? ', error: ' + c.error : '');
}

function wasm(r) {
  const w = r.wasm;
  if (!w) return 'not run';
  if (!w.channels) return 'failed (' + (w.error || w.text) + ')';
  return w.channels + ' ch, ACN order ' + (w.ladderOk ? 'OK' : 'WRONG') + (w.realtimeFactor ? ', ' + w.realtimeFactor + 'x realtime' : '') + (w.decoderErrors ? ', ' + w.decoderErrors + ' decoder errors' : '');
}

function mediaCapabilities(r) {
  const m = r.mediaCapabilities;
  if (!m) return 'not run';
  if (m.absent) return 'no MediaCapabilities';
  const keys = ['file webm', 'file mp4', 'media-source webm', 'media-source mp4'];
  const vals = keys.map(k => m[k]);
  if (vals.every(v => v === true)) return 'true for all four';
  if (vals.every(v => v === false)) return 'false for all four';
  return keys.map(k => k.replace('mp4', 'fMP4').replace('webm', 'WebM') + ' ' + String(m[k])).join(', ');
}

// The human row reports what happened, and nothing more: a verdict if a
// person chose one, otherwise how far the run got towards the point where a
// person could have.
function human(r) {
  if (r.human === 'heard') return 'heard both tones';
  if (r.human === 'nothing') return 'heard nothing';
  if (r.humanPlay) return 'no verdict chosen (Play was pressed, context ' + r.humanPlay.contextState + ')';
  if (r.summary && r.summary.wasmOk === false) return 'no verdict (Play never enabled, the WASM decode failed)';
  return 'no verdict (Play never pressed)';
}

const ROWS = [
  ['`canPlayType`, `audio/webm; codecs="opus"`', r => (cell(r, 'canPlayType', 'opus16', 'webm') || {}).text || 'not run'],
  ['`canPlayType`, `audio/mp4; codecs="opus"`', r => (cell(r, 'canPlayType', 'opus16', 'mp4') || {}).text || 'not run'],
  ['`isTypeSupported`, WebM', r => isTypeSupported(r, 'webm')],
  ['`isTypeSupported`, fMP4', r => isTypeSupported(r, 'mp4')],
  ['`decodeAudioData`, 16-ch WebM', r => decodeAudioData(r, 'opus16', 'webm')],
  ['`decodeAudioData`, 16-ch fMP4', r => decodeAudioData(r, 'opus16', 'mp4')],
  ['`decodeAudioData`, 2-ch WebM', r => decodeAudioData(r, 'opus2', 'webm')],
  ['`decodeAudioData`, 2-ch fMP4', r => decodeAudioData(r, 'opus2', 'mp4')],
  ['WebCodecs, 16-ch with OpusHead description', r => webcodecs(r, 'opus16')],
  ['WebCodecs, 2-ch', r => webcodecs(r, 'opus2')],
  ['WASM libopus, 16-ch', r => wasm(r)],
  ['`MediaCapabilities`, channels 16 (informational)', r => mediaCapabilities(r)],
  ['Decoding surfaces refusing 16-ch in both containers', r => (!r.summary ? 'not run' : r.summary.decodersRefusing16.length ? r.summary.decodersRefusing16.join(', ') : 'none')],
  ['Human: both tones heard', r => human(r)],
];

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node status-table.mjs results/*.json'); process.exit(2); }
const runs = files.map(f => ({ file: f, r: JSON.parse(fs.readFileSync(f, 'utf8')) }));
console.log('| Surface | ' + runs.map(x => heading(x.file)).join(' | ') + ' |');
console.log('|---|' + runs.map(() => '---').join('|') + '|');
for (const [label, fn] of ROWS) console.log('| ' + label + ' | ' + runs.map(x => fn(x.r)).join(' | ') + ' |');
