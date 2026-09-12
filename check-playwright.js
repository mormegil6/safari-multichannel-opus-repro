#!/usr/bin/env node
// Automated smoke check of index.html under Playwright's bundled Chromium and
// WebKit, from a file:// URL. It confirms the page itself works (every row
// finishes, the WASM ladder is intact, the human row cannot pass before Play
// ran, and cannot pass at all when the decoder is missing) and prints what
// each surface returned.
//
// It is NOT a Safari measurement. Playwright's WebKit is the open-source
// WebKit with its own media backend; it has failed to reproduce several real
// Safari media behaviours in the project this comes from, and on this page it
// answers "probably" and true for the WebM strings where Safari is expected
// to differ. The README status table is filled from real Safari runs only.
// Playwright's Chromium starts with a fresh profile and no variations seed,
// so it is never enrolled in the DirectOpusAudioDecoding field trial that a
// daily-use Chrome may be.
//
// usage: from a tree that has playwright-core in node_modules,
//   node /path/to/check-playwright.js [chromium] [webkit] [firefox]
// PW_FIREFOX=/path/to/firefox (or PW_CHROMIUM, PW_WEBKIT) overrides the
// executable when the installed browser build does not match playwright-core.
'use strict';
const path = require('path');
const pw = require(require.resolve('playwright-core', { paths: [process.cwd(), __dirname] }));

const url = 'file://' + path.join(__dirname, 'index.html');
const NATIVE = ['canPlayType', 'isTypeSupported', 'decodeAudioData', 'webcodecs'];
// what a passing run looks like per engine: how many of the two decoding
// surfaces refuse the 16-channel clip in both containers, and whether the
// WASM row decodes it in ACN order
const EXPECT = { chromium: { decodersRefuse16: 0, wasm: true }, webkit: { decodersRefuse16: 2, wasm: true }, firefox: { decodersRefuse16: 0, wasm: true } };

function launch(name) {
  const opts = { args: name === 'chromium' ? ['--autoplay-policy=no-user-gesture-required'] : [] };
  const exe = process.env['PW_' + name.toUpperCase()];
  if (exe) opts.executablePath = exe;
  return pw[name].launch(opts);
}

async function run(name) {
  const browser = await launch(name);
  console.log('== ' + name + ' ' + browser.version());
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('  pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('  console.error: ' + m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => window.__machineDone === true, null, { timeout: 120000 });

  // human row: both verdict buttons must be disabled until Play has run
  const before = await page.evaluate(() => ({ play: document.getElementById('play').disabled,
    heard: document.getElementById('heard').disabled, nothing: document.getElementById('nothing').disabled }));
  let after = null, human = null;
  if (!before.play) {
    await page.click('#play');
    await page.waitForFunction(() => !document.getElementById('heard').disabled, null, { timeout: 10000 }).catch(() => {});
    after = await page.evaluate(() => ({ heard: document.getElementById('heard').disabled,
      nothing: document.getElementById('nothing').disabled, ctx: window.__result.humanPlay }));
    if (!after.heard) { await page.click('#heard'); }
    human = await page.evaluate(() => window.__result.human);
  }
  const r = await page.evaluate(() => window.__result);
  await browser.close();

  for (const s of NATIVE.concat(['wasm'])) {
    for (const asset of ['opus16', 'opus2']) {
      const cells = r.surfaces[s] && r.surfaces[s][asset];
      if (!cells) { console.log('  ' + s + ' ' + asset + ': MISSING'); continue; }
      for (const [container, cell] of Object.entries(cells))
        console.log('  ' + s.padEnd(16) + asset.padEnd(7) + container.padEnd(8) + (cell.ok ? 'PASS ' : 'FAIL ') + cell.text);
    }
  }
  console.log('  mediaSource: ' + JSON.stringify(r.mediaSource));
  console.log('  mediaCapabilities (channels 16): ' + JSON.stringify(r.mediaCapabilities));
  console.log('  summary: ' + JSON.stringify(r.summary));
  console.log('  human row: before Play ' + JSON.stringify(before) + '; after Play ' + JSON.stringify(after) + '; verdict ' + human);
  if (r.errors) console.log('  step errors: ' + JSON.stringify(r.errors));

  const problems = [];
  const exp = EXPECT[name];
  if (exp) {
    if (r.summary.decodersRefusing16.length !== exp.decodersRefuse16) problems.push('expected ' + exp.decodersRefuse16 + ' decoding surfaces refusing 16-ch in both containers, got ' + r.summary.decodersRefusing16.length);
    if (r.summary.wasmOk !== exp.wasm) problems.push('expected WASM ok=' + exp.wasm);
  }
  if (!(before.heard && before.nothing)) problems.push('verdict buttons were enabled before Play ran');
  if (before.play) problems.push('Play never enabled');
  else if (!after || after.heard) problems.push('verdict buttons did not enable after Play (context ' + JSON.stringify(after && after.ctx) + ')');
  else if (human !== 'heard') problems.push('verdict click did not record');
  console.log('  ' + (problems.length ? 'FAIL: ' + problems.join('; ') : 'PASS'));
  return problems.length === 0;
}

// Negative check: with the decoder library made invisible, the WASM row must
// fail, Play must stay disabled, and the human verdict must stay pending. This
// is the case the page is guarding against.
async function runWithoutDecoder(name) {
  const browser = await launch(name);
  const page = await browser.newPage();
  await page.addInitScript(() => {
    // the UMD wrapper assigns globalThis['opus-decoder']; swallow it
    Object.defineProperty(globalThis, 'opus-decoder', { get() { return undefined; }, set() { }, configurable: false });
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__machineDone === true, null, { timeout: 120000 });
  const s = await page.evaluate(() => ({
    play: document.getElementById('play').disabled, heard: document.getElementById('heard').disabled,
    nothing: document.getElementById('nothing').disabled, human: window.__result.human,
    wasmOk: window.__result.summary.wasmOk, summary: document.getElementById('summary').textContent }));
  await browser.close();
  const problems = [];
  if (s.wasmOk) problems.push('WASM row passed without the decoder');
  if (!s.play) problems.push('Play enabled without the decoder');
  if (!s.heard || !s.nothing) problems.push('verdict buttons enabled without the decoder');
  if (s.human !== 'pending') problems.push('human verdict is ' + s.human);
  if (!/Play never enabled/.test(s.summary)) problems.push('summary does not say Play never enabled');
  console.log('== ' + name + ', decoder blocked: ' + (problems.length ? 'FAIL: ' + problems.join('; ') : 'PASS (WASM row failed, Play disabled, human pending)'));
  return problems.length === 0;
}

(async () => {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'webkit'];
  let ok = true;
  for (const n of names) {
    try { ok = (await run(n)) && ok; }
    catch (e) { console.log('  ' + n + ' did not run: ' + e.message.split('\n')[0]); ok = false; }
    try { ok = (await runWithoutDecoder(n)) && ok; }
    catch (e) { console.log('  ' + n + ' (decoder blocked) did not run: ' + e.message.split('\n')[0]); ok = false; }
  }
  process.exit(ok ? 0 : 1);
})();
