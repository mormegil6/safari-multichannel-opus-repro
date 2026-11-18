#!/usr/bin/env node
// Run playback.html in the real Safari: play each Opus clip through an audio
// element and through MSE, and record two things per test, what the element
// reported and what reached the output device.
//
// Safari is driven through safaridriver, as in measure.mjs. The sound is
// recorded with sox from a loopback audio device, which has to be the system's
// output device for the length of the run. BlackHole 2ch is the default name;
// pass another as the argument. If the 2-channel control plays and nothing is
// recorded, the loopback device was not the output, and the script says so.
//
// usage: node playback.mjs [--url <address of playback.html>] [capture device]
//   --url                                 test a copy of the page that is
//                                         already being served, for example the
//                                         published one, not the local copy
//   SAFARIDRIVER=http://127.0.0.1:4599    where safaridriver listens; the
//                                         script starts one on that port if
//                                         none answers there
//
// Writes playback-results/<date>-<os>-safari<version>-<time>Z.json, and leaves
// the eight recordings of the run beside it as last-*.wav (git ignores them).
// playback-table.mjs prints the README table from the JSON files.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'playback-results');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const u = args.indexOf('--url');
const PAGE = u >= 0 ? args.splice(u, 2)[1] : null;
if (u >= 0 && !PAGE) { console.error('--url needs the address of playback.html'); process.exit(2); }
const DEVICE = args[0] || 'BlackHole 2ch';
const DRIVER = process.env.SAFARIDRIVER || 'http://127.0.0.1:4599';

try { execSync('sox --version', { stdio: 'ignore' }); }
catch (e) { console.error('playback.mjs records the output device with sox, which is not installed (brew install sox)'); process.exit(2); }

// A static server WITH byte ranges: Safari's media element asks for ranges and
// gives up on a server that ignores them.
const TYPES = { '.html': 'text/html; charset=utf-8', '.webm': 'audio/webm', '.mp4': 'audio/mp4' };
const requests = [];
let server = null;
let url = PAGE;
if (!PAGE) {
  server = http.createServer((req, res) => {
    const name = path.basename(decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    const f = path.join(here, name);
    if (!/^(playback\.html|opus(2|16)\.(webm|mp4))$/.test(name) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    const size = fs.statSync(f).size;
    const head = { 'content-type': TYPES[path.extname(f)], 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] !== '' || m[2] !== '')) {
      let start, end;
      if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
      else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
      if (start > end || start >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); requests.push(`${name} ${req.headers.range} 416`); return; }
      res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
      fs.createReadStream(f, { start, end }).pipe(res);
      requests.push(`${name} ${req.headers.range} 206`);
    } else {
      res.writeHead(200, { ...head, 'content-length': size });
      fs.createReadStream(f).pipe(res);
      requests.push(`${name} whole 200`);
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  url =`http://localhost:${server.address().port}/playback.html`;
}

// ---- what is in a recording -------------------------------------------------
function readWav(file) {
  const b = fs.readFileSync(file);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('latin1', p, p + 4), len = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') { data = b.subarray(p + 8, Math.min(b.length, p + 8 + len)); break; }
    p += 8 + len + (len & 1);
  }
  if (!fmt || !data || fmt.bits !== 16) throw new Error('unexpected wav: ' + JSON.stringify(fmt));
  const n = Math.floor(data.length / (2 * fmt.channels));
  const ch = Array.from({ length: fmt.channels }, () => new Int16Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < fmt.channels; c++) ch[c][i] = data.readInt16LE(2 * (i * fmt.channels + c));
  return { ...fmt, ch };
}
// amplitude of a sine at f in x[from, from+len), by direct correlation; x is
// 16-bit samples and the result is relative to full scale
function toneAmp(x, rate, f, from, len) {
  let re = 0, im = 0;
  const w = 2 * Math.PI * f / rate;
  for (let i = 0; i < len; i++) { const v = x[from + i] / 32768; re += v * Math.cos(w * i); im += v * Math.sin(w * i); }
  return 2 * Math.hypot(re, im) / len;
}
// the clips' tones: channel k of the 16-channel clip is 200 + 100 k Hz, and the
// control is the first two of them
const TONES = Array.from({ length: 16 }, (_, k) => 200 + 100 * k);
// Per channel: the largest sample, how many samples are not zero, and every
// clip tone above -60 dBFS in the loudest half second of the recording. The
// loudest half second lies inside the clip, where the tones are steady and
// every one of them fits a whole number of cycles.
function analyse(file) {
  const w = readWav(file);
  const n = w.ch[0].length, win = Math.floor(w.rate / 2), hop = Math.floor(win / 2);
  const heard = { rate: w.rate, channels: w.channels, seconds: +(n / w.rate).toFixed(2), peak: [], nonzeroSamples: [], loudestHalfSecondAt: null, tones: [] };
  let bestFrom = -1, bestEnergy = 0;
  for (let from = 0; from + win <= n; from += hop) {
    let e = 0;
    for (const x of w.ch) for (let i = from; i < from + win; i++) e += x[i] * x[i];
    if (e > bestEnergy) { bestEnergy = e; bestFrom = from; }
  }
  if (bestFrom >= 0) heard.loudestHalfSecondAt = +(bestFrom / w.rate).toFixed(2);
  for (const x of w.ch) {
    let peak = 0, nonzero = 0;
    for (const v of x) { if (v !== 0) nonzero++; if (Math.abs(v) > peak) peak = Math.abs(v); }
    heard.peak.push(+(peak / 32768).toFixed(6));
    heard.nonzeroSamples.push(nonzero);
    heard.tones.push(bestFrom < 0 ? [] : TONES.map(hz => [hz, toneAmp(x, w.rate, hz, bestFrom, win)]).filter(([, a]) => a > 0.001).map(([hz, a]) => ({ hz, dbfs: +(20 * Math.log10(a)).toFixed(1) })));
  }
  return heard;
}

// ---- WebDriver --------------------------------------------------------------
const call = async (method, p, body) => {
  const r = await fetch(DRIVER + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(method + ' ' + p + ': ' + JSON.stringify(j).slice(0, 300));
  return j.value;
};
const driverAnswers = async () => { try { await fetch(DRIVER + '/status'); return true; } catch (e) { return false; } };

let driver = null;
let sid = null;
const report = { when: new Date().toISOString(), page: PAGE || 'the local copy, served on loopback', macos: execSync('sw_vers -productVersion').toString().trim(), captureDevice: DEVICE, tests: [] };
try { report.safariBuild = execSync('defaults read /Applications/Safari.app/Contents/Info CFBundleVersion', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { report.safariBuild = null; }
try {
  if (!(await driverAnswers())) {
    driver = spawn('safaridriver', ['-p', new URL(DRIVER).port || '4599'], { stdio: 'ignore' });
    driver.on('error', () => {});
    for (let i = 0; i < 40 && !(await driverAnswers()); i++) await sleep(250);
    if (!(await driverAnswers())) throw new Error('safaridriver does not answer at ' + DRIVER + '; run "safaridriver --enable" once');
  }
  // without alwaysAllowAutoplay Safari refuses play() in a window nobody clicked
  const s = await call('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari', 'webkit:alwaysAllowAutoplay': true } } });
  sid = s.sessionId;
  report.safari = s.capabilities.browserVersion;
  const js = script => call('POST', `/session/${sid}/execute/sync`, { script, args: [] });
  await call('POST', `/session/${sid}/window/rect`, { x: 40, y: 60, width: 900, height: 700 }).catch(() => {});
  await call('POST', `/session/${sid}/url`, { url });
  for (let i = 0; i < 40 && !(await js('return window.__ready === true')); i++) await sleep(250);
  if (!(await js('return window.__ready === true'))) throw new Error('playback.html did not load at ' + url);
  report.queries = JSON.parse(await js('return JSON.stringify(window.__queries)'));
  try { report.volume = execSync(`osascript -e 'get volume settings'`).toString().trim(); } catch (e) { report.volume = 'unknown'; }

  fs.mkdirSync(out, { recursive: true });
  const plan = [];
  for (const ext of ['webm', 'mp4']) for (const p of ['element', 'mse']) for (const n of [2, 16]) plan.push([p, `opus${n}.${ext}`]);
  for (const [p, file] of plan) {
    const wav = path.join(out, `last-${p}-${file}.wav`);
    fs.rmSync(wav, { force: true });
    // ten seconds of the loopback device as 16-bit samples; -D switches off the
    // dither sox would add, so that a silent output is recorded as zeros
    const rec = spawn('sox', ['-q', '-D', '-t', 'coreaudio', DEVICE, '-b', '16', wav, 'trim', '0', '10'], { stdio: 'ignore' });
    const recDone = new Promise(r => { rec.on('exit', r); rec.on('error', r); });
    await sleep(800);
    // window.start is what each button on the page calls. The script calls it
    // directly because Safari delivers a WebDriver click only to a window that is
    // in front, and the run should not depend on that.
    const key = await js(`return window.start(${JSON.stringify(p)}, ${JSON.stringify(file)})`);
    let res = null;
    for (let i = 0; i < 60 && !res; i++) { await sleep(300); const t = await js(`return JSON.stringify(window.__results[${JSON.stringify(key)}])`); res = t && t !== 'null' ? JSON.parse(t) : null; }
    await recDone;
    let heard;
    try { heard = analyse(wav); } catch (e) { heard = { error: String(e.message || e) }; }
    report.tests.push({ ...(res || { path: p, file, noResult: true }), heard });
    const f = res && res.final;
    console.log(`${p.padEnd(7)} ${file.padEnd(11)} position ${f ? f.currentTime : '-'} s, duration ${f ? f.duration : '-'}, error ${f && f.error ? JSON.stringify(f.error) : 'none'}, ` +
      `${res && res.addSourceBuffer ? 'addSourceBuffer ' + res.addSourceBuffer + ', append ' + (res.append || '-') + ', ' : ''}play() ${res && res.playPromise ? res.playPromise : 'not called'}; ` +
      (heard.error ? 'recording: ' + heard.error : `recorded peak ${heard.peak.join('/')}, tones ${heard.tones.map(t => t.map(x => x.hz).join('+') || 'none').join(' / ')}`));
  }
  if (server) report.requests = requests;
  const control = report.tests.find(t => t.path === 'element' && t.file === 'opus2.webm');
  if (control && control.final && control.final.currentTime > 1 && control.heard.peak && Math.max(...control.heard.peak) === 0) {
    report.captureWarning = `the 2-channel control played and nothing was recorded from "${DEVICE}", so that device was not the system's output and the recordings of this run say nothing`;
    console.log('WARNING: ' + report.captureWarning);
  }
} catch (e) {
  report.failed = String(e.message || e);
  console.log('FAILED: ' + report.failed);
} finally {
  if (sid) await call('DELETE', `/session/${sid}`).catch(() => {});
  if (driver) driver.kill();
  if (server) server.close();
}
if (report.tests.length) {
  const file = path.join(out, `${report.when.slice(0, 10)}-macos${report.macos}-safari${report.safari}-${report.when.slice(11, 19).replace(/:/g, '')}Z.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 1) + '\n');
  console.log('wrote ' + path.relative(process.cwd(), file));
}
process.exit(report.failed ? 1 : 0);
