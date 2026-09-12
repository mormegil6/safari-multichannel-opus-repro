#!/usr/bin/env node
// Run index.html in the browsers installed on this machine and write one JSON
// per browser into results/, the same object the page's Copy JSON button puts
// on the clipboard. The README status table is printed from those files by
// status-table.mjs, so no cell in it is typed by hand.
//
// Safari is driven through safaridriver, Apple's WebDriver, because that is
// the only way to run the real Safari with its real media stack (Playwright's
// WebKit is a different build; see check-playwright.js). Start it first:
//
//   safaridriver --enable      # once; asks for an administrator password
//   safaridriver -p 4599 &
//
// Chrome and Firefox are launched through playwright-core: Chrome as the
// installed Google Chrome in a fresh temporary profile, so it carries no
// field-trial seed, and Firefox as the installed Mozilla build over WebDriver
// BiDi, not Playwright's own Firefox.
//
// usage: node measure.mjs [safari] [chrome] [firefox]
//   SAFARIDRIVER=http://127.0.0.1:4599    where safaridriver listens
//   FIREFOX=/path/to/firefox              the Firefox binary to launch
//
// Play is pressed in every run so the page records the state of its
// AudioContext, but neither verdict button is: nobody listened, so the human
// row of an automated run stays "pending" on purpose.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The page fetches nothing, but Safari through WebDriver will not open a
// file:// URL, so serve the directory on a loopback port for the run.
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (p === '/') p = '/index.html';
  const f = path.join(here, p);
  if (!f.startsWith(here + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
// Safari keeps a page zoom per site, and on a site zoomed away from 100 %
// every WebDriver click lands off its element ("element not interactable").
// If the Play click fails in Safari, open http://localhost/ there and choose
// View > Actual Size once.
const url = `http://localhost:${server.address().port}/`;

async function untilTrue(probe, timeoutMs, everyMs = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (await probe()) return true; await sleep(everyMs); }
  return false;
}

async function safari() {
  const base = process.env.SAFARIDRIVER || 'http://127.0.0.1:4599';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(method + ' ' + p + ': ' + JSON.stringify(j).slice(0, 200));
    return j.value;
  };
  const s = await call('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } });
  const sid = s.sessionId;
  const version = s.capabilities.browserVersion;
  const js = script => call('POST', `/session/${sid}/execute/sync`, { script, args: [] });
  try {
    await call('POST', `/session/${sid}/window/rect`, { x: 20, y: 40, width: 1000, height: 900 }).catch(() => {});
    await call('POST', `/session/${sid}/url`, { url });
    if (!(await untilTrue(() => js('return window.__machineDone === true'), 120000))) throw new Error('page did not finish');
    // Play needs a user gesture, and Safari has to be frontmost for the
    // WebDriver click to count as one. The button is scrolled into view
    // first because safaridriver does not do that by itself.
    let clickError = null;
    for (let i = 0; i < 5 && !(await js('return !!(window.__result && window.__result.humanPlay)')); i++) {
      if (process.platform === 'darwin') { try { execSync(`osascript -e 'tell application "Safari" to activate'`); } catch (e) { /* not fatal */ } }
      await js("document.getElementById('play').scrollIntoView({ block: 'center' })");
      await sleep(500);
      const el = await call('POST', `/session/${sid}/element`, { using: 'css selector', value: '#play' });
      await call('POST', `/session/${sid}/element/${Object.values(el)[0]}/click`, {}).then(() => { clickError = null; }, e => { clickError = e; });
      await sleep(1500);
    }
    if (clickError) console.log('  safari: the Play click did not register: ' + String(clickError.message).slice(0, 120));
    return { version, result: JSON.parse(await js('return JSON.stringify(window.__result)')) };
  } finally {
    await call('DELETE', `/session/${sid}`).catch(() => {});
  }
}

async function viaPlaywright(name) {
  const require = createRequire(import.meta.url);
  const pw = require(require.resolve('playwright-core', { paths: [process.cwd(), here] }));
  let browser = null, context;
  if (name === 'chrome') {
    context = await pw.chromium.launchPersistentContext('', { channel: 'chrome', headless: false });
    browser = context.browser();
  } else {
    // channel moz-firefox finds the installed Mozilla build by itself; FIREFOX
    // overrides it with a specific binary
    const opts = { channel: 'moz-firefox', headless: false };
    if (process.env.FIREFOX) opts.executablePath = process.env.FIREFOX;
    browser = await pw.firefox.launch(opts);
    context = await browser.newContext();
  }
  const page = await context.newPage();
  try {
    await page.goto(url);
    await page.waitForFunction(() => window.__machineDone === true, null, { timeout: 120000 });
    await page.click('#play');
    await page.waitForFunction(() => !!(window.__result && window.__result.humanPlay), null, { timeout: 10000 }).catch(() => {});
    const result = await page.evaluate(() => JSON.parse(JSON.stringify(window.__result)));
    return { version: browser ? browser.version() : 'unknown', result };
  } finally {
    await context.close();
    if (browser) await browser.close().catch(() => {});
  }
}

function osToken() {
  if (process.platform === 'darwin') return 'macos' + execSync('sw_vers -productVersion').toString().trim();
  if (process.platform === 'win32') return 'windows';
  return process.platform;
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : ['safari', 'chrome', 'firefox'];
let failed = false;
try {
  for (const name of names) {
    try {
      const { version, result } = name === 'safari' ? await safari() : await viaPlaywright(name);
      const file = path.join(here, 'results', `${result.when.slice(0, 10)}-${osToken()}-${name}${version}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(result, null, 1) + '\n');
      const s = result.summary;
      console.log(`${name} ${version}: decoders refusing 16-ch in both containers: ${s.decodersRefusing16.length ? s.decodersRefusing16.join(', ') : 'none'}; WASM ${s.wasmOk ? 'ok' : 'FAILED'}; human ${result.human}; context ${result.humanPlay ? result.humanPlay.contextState : 'Play not recorded'}`);
      console.log(`  wrote ${path.relative(process.cwd(), file)}`);
    } catch (e) {
      failed = true;
      console.log(`${name}: did not run: ${String(e.message || e).split('\n')[0]}`);
    }
  }
} finally {
  server.close();
}
process.exit(failed ? 1 : 0);
