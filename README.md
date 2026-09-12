# Safari refuses 16-channel Opus on decodeAudioData and on WebCodecs while a WebAssembly libopus decodes the same bytes with all 16 channels in order

**Live check: https://mormegil6.github.io/safari-multichannel-opus-repro/**

One page plus the two script files it loads from the same directory. It embeds, through `assets.js`, a 16-channel Opus clip (channel mapping family 255, sixteen independent streams, which is how this stream carries third-order Ambisonics) and a 2-channel control, offers both to the two decode APIs a page can call directly, `decodeAudioData` and WebCodecs, and to the two string queries the media element and MSE expose, then decodes the identical packets with libopus compiled to WebAssembly, and finally plays two of the decoded channels so a person can confirm that sound actually came out. Nothing is fetched over the network, so `index.html`, `assets.js` and `opus-decoder.min.js` copied side by side open from a `file://` URL with no server. Playback through a media element or an MSE SourceBuffer is not attempted; those paths appear only as their string queries, `canPlayType` and `isTypeSupported`.

The 16-channel clip carries a different sine on each channel: channel k = 200 + 100 k Hz, so channel 0 is 200 Hz and channel 15 is 1700 Hz. Every successful decode is followed by a Goertzel check on each channel, so a decoder that returns 16 channels in the wrong order, or 16 channels of which 14 are silent, shows as WRONG rather than as a pass.

## What the page does, in order

1. Loads the embedded assets from `assets.js`: the 16-channel clip in WebM and in fragmented MP4, the 2-channel control in both containers, and the raw Opus packets plus OpusHead of each clip as JSON. All three forms of a clip come from one libopus encode and carry byte-identical packets (see `make-assets.sh`). The control differs from the 16-channel clip in more than channel count: it is mapping family 0 with one coupled stream, and its WebCodecs configuration carries no description.
2. Asks the four native surfaces, one table row each, one cell per asset and container for the three file-based surfaces and one cell per asset for WebCodecs, which takes packets and stands for both containers:
   - `HTMLMediaElement.canPlayType`, printed as the string it returned. The MIME string carries no channel count, so both clips get the same answer.
   - `MediaSource.isTypeSupported` and `ManagedMediaSource.isTypeSupported`, whichever exist. iOS ships only `ManagedMediaSource`, and the cell says which one answered.
   - `decodeAudioData` on an `OfflineAudioContext`, an actual decode of the file, followed by the tone check.
   - WebCodecs `AudioDecoder.isConfigSupported` followed by an actual decode of the packets, with the OpusHead passed as `description` for the 16-channel clip.
3. Decodes the same packets with [opus-decoder](https://github.com/eshaz/wasm-audio-decoders) 0.7.12, a libopus WebAssembly build, constructed from the OpusHead's multistream layout (16 channels, 16 streams, 0 coupled, identity mapping, pre-skip 312). A per-channel table prints expected against detected frequency, and the cell reports decode speed as a multiple of realtime.
4. Human verdict, independent of the four native verdicts: **Play channel 0 then channel 15** plays the WASM-decoded 200 Hz channel for one second and the 1700 Hz channel for one second through a stereo `AudioContext`, and two large buttons record **I heard both tones** or **I heard nothing**. The verdict buttons are enabled in exactly one place, inside the Play handler, after the context reports running, and Play itself is enabled only once the WASM row has decoded. A run in which Play never became enabled cannot record a human result. On WebKit the handler first asks for the `playback` audio session category, because a context left with the default type, `auto`, is silenced on iOS by the hardware ringer switch, and a reviewer running the page with the switch on silent would otherwise record "heard nothing" for a reason unrelated to any decode surface. The type the context ended up with is recorded with the verdict.
5. A summary block at the top: how many of the four native surfaces refuse the 16-channel asset, counted per container, whether the WASM decode came out with 16 channels in ACN order, and the human verdict. **Copy JSON** puts every raw result plus the user agent on the clipboard.

The first two surfaces answer about a MIME string and cannot see a channel count, so they can say yes for `audio/webm; codecs="opus"` on an engine whose decoders then refuse the 16-channel WebM. That is why the summary counts refusals per container and lets the two decoding surfaces decide the headline: the page reports REPRODUCED when `decodeAudioData` and WebCodecs both refuse the 16-channel clip in both containers while the WASM row decodes it, and it names the string surfaces that still said yes. Below the table, `MediaCapabilities.decodingInfo` with `channels: "16"` is printed for information; it is the one string-level query that takes a channel count, but it decodes nothing and is not counted.

## Status, measured 12 September 2026

Each column is one run of the page, and the JSON the run produced is in `results/`. The table is printed from those files by `status-table.mjs`, so every cell below is what the page recorded rather than a transcription.

| Surface | Safari 27.0, macOS 15.7.9, 2026-09-12 | Safari 18.7.7, iOS 18.7 (iPhone Xs), 2026-09-12 | Chrome 152.0.7977.76, macOS 15.7.9, 2026-09-12 | Firefox 155.0, macOS 15.7.9, 2026-09-12 |
|---|---|---|---|---|
| `canPlayType`, `audio/webm; codecs="opus"` | "probably" | "probably" | "probably" | "probably" |
| `canPlayType`, `audio/mp4; codecs="opus"` | "" | "" | "probably" | "probably" |
| `isTypeSupported`, WebM | MediaSource true, ManagedMediaSource true | ManagedMediaSource true (no MediaSource) | MediaSource true (no ManagedMediaSource) | MediaSource true (no ManagedMediaSource) |
| `isTypeSupported`, fMP4 | MediaSource false, ManagedMediaSource false | ManagedMediaSource false (no MediaSource) | MediaSource true (no ManagedMediaSource) | MediaSource true (no ManagedMediaSource) |
| `decodeAudioData`, 16-ch WebM | refused (error callback invoked with null) | refused (error callback invoked with null) | 16 ch, ladder in order | 16 ch, ladder in order |
| `decodeAudioData`, 16-ch fMP4 | refused (error callback invoked with null) | refused (error callback invoked with null) | 16 ch, ladder in order | 16 ch, ladder in order |
| `decodeAudioData`, 2-ch WebM | 2 ch, ladder in order | 2 ch, ladder in order | 2 ch, ladder in order | 2 ch, ladder in order |
| `decodeAudioData`, 2-ch fMP4 | 2 ch, ladder in order | refused (error callback invoked with null) | 2 ch, ladder in order | 2 ch, ladder in order |
| WebCodecs, 16-ch with OpusHead description | isConfigSupported false | isConfigSupported false | supported, 151 frames, 16 ch in order, 80x realtime | supported, 151 frames, 16 ch in order, 91x realtime |
| WebCodecs, 2-ch | supported, 151 frames, 2 ch in order, 178x realtime | supported, 151 frames, 2 ch in order, 62x realtime | supported, 151 frames, 2 ch in order, 397x realtime | supported, 151 frames, 2 ch in order, 275x realtime |
| WASM libopus, 16-ch | 16 ch, ACN order OK, 68x realtime | 16 ch, ACN order OK, 26x realtime | 16 ch, ACN order OK, 62x realtime | 16 ch, ACN order OK, 66x realtime |
| `MediaCapabilities`, channels 16 (informational) | file WebM true, file fMP4 false, media-source WebM true, media-source fMP4 false | file WebM true, file fMP4 false, media-source WebM true, media-source fMP4 false | true for all four | true for all four |
| Decoding surfaces refusing 16-ch in both containers | decodeAudioData, webcodecs | decodeAudioData, webcodecs | none | none |
| Human: both tones heard | no verdict chosen (Play was pressed, context running) | heard both tones | no verdict chosen (Play was pressed, context running) | no verdict chosen (Play was pressed, context running) |

What the table says. On Safari, on both platforms, the two surfaces that decode refuse the 16-channel clip in both containers. In WebM the 2-channel control passes through the same two surfaces on both platforms, so the WebM refusal follows the 16-channel, family-255 layout, not the codec or the container. The two surfaces that only inspect a string say yes to that same WebM on both platforms, which is the dangerous direction: a player that trusts `canPlayType` or `isTypeSupported` before attempting a decode selects a track that neither decoding API will decode. Opus in fMP4 is refused by Safari at the string level as well, and there the two Safaris part company one row further down: macOS Safari 27 decodes the 2-channel fMP4 through `decodeAudioData` while iOS 18.7 refuses it, so for fMP4 the control does not isolate the channel count on iOS, and a measurement on one Safari is not evidence about the other. Chrome and Firefox accept the 16-channel clip on every surface, in both containers, with the ladder intact, and the page reports "Not reproduced" there. The WASM row decodes the same packets with all 16 channels in order on all four.

The human row is judged only where a person listened. The iPhone run is that person's verdict; the three macOS columns were driven by a script that pressed Play, so the page recorded a running context for each (and, on Safari, the `playback` category), but nobody chose a verdict and the row says so. A run on the same phone earlier that day, with a revision of the page that did not yet request the category, is kept as `results/2026-09-12-ios18.7-safari18.7.7-iphoneXs-ambient.json`: it recorded the same machine verdicts, timing aside, and its tones were inaudible with the ringer switch on silent until the switch was flipped. The run in the table was made with the switch on silent and the tones were audible. That is why step 4 sets the category.

How the columns were measured. `measure.mjs` runs the page in the browsers installed on the machine and writes one JSON per browser into `results/`: Safari through safaridriver, Apple's own WebDriver, which is the only way to drive the real Safari with its real media stack; Google Chrome as installed, in a fresh temporary profile; and Firefox as installed, over WebDriver BiDi rather than Playwright's own Firefox build. The iPhone column is the page's own **Copy JSON**, pasted off the phone into `results/`. Machine: MacBook Pro, Apple M3 Max, macOS 15.7.9; the iPhone Xs runs iOS 18.7 with Safari 18.7.7.

```
npm install                              # playwright-core, for the chrome and firefox targets; safari needs only safaridriver
safaridriver --enable                    # once
safaridriver -p 4599 &
node measure.mjs safari chrome firefox
node status-table.mjs results/2026-09-12-macos15.7.9-safari27.0.json results/2026-09-12-ios18.7-safari18.7.7-iphoneXs.json results/2026-09-12-macos15.7.9-chrome152.0.7977.76.json results/2026-09-12-macos15.7.9-firefox155.0.json
```

Chrome caveat: a Chrome profile enrolled in the `DirectOpusAudioDecoding` field trial refuses the 16-channel clip on `decodeAudioData` while passing the 2-channel control. That is a separate Chromium bug with its own reproduction, [opus-multichannel-repro](https://github.com/mormegil6/opus-multichannel-repro), fixed in Chromium ([547065816](https://issues.chromium.org/issues/547065816)) and verified on Canary 154.0.8021.0; the page prints a note when it sees that pattern on a Chromium user agent. The Chrome column above is a fresh profile, which carries no field-trial seed.

### Playwright smoke check (not Safari)

`check-playwright.js` drives the page under Playwright's bundled Chromium and WebKit from a `file://` URL and prints every cell. Playwright's WebKit is a WebKit build without Safari's application layer, not Safari, and it has failed to reproduce three Safari media behaviours measured in [ambisonic-box](https://github.com/mormegil6/ambisonic-box/blob/main/docs/IOS-SAFARI.md); treat its numbers as evidence that the page works, not as a measurement of Safari. Playwright's Chromium also starts with a fresh profile.

Run on 2026-09-01, macOS 15 (Apple silicon), playwright-core 1.60.0, all from `file://`. The table is a transcript of the script's console output; no JSON of that run is committed. Firefox ran through the `PW_FIREFOX` override because the cached Playwright build is Firefox Nightly 151.0 (build 1532) and playwright-core 1.60 asks for 150.0.2 (build 1522). The same check was run again on 2026-09-12 against the current page, Chromium and WebKit, and both passed.

| Surface | Playwright Chromium 148.0.7778.96 | Playwright WebKit 26.4 | Playwright Firefox 151.0 |
|---|---|---|---|
| `canPlayType`, WebM | `"probably"` | `"probably"` | `"probably"` |
| `canPlayType`, fMP4 | `"probably"` | `""` | `"probably"` |
| `isTypeSupported`, WebM | MediaSource true (no ManagedMediaSource) | MediaSource true, ManagedMediaSource true | MediaSource true (no ManagedMediaSource) |
| `isTypeSupported`, fMP4 | MediaSource true | MediaSource false, ManagedMediaSource false | MediaSource true |
| `decodeAudioData`, 16-ch WebM | 16 ch, ladder in order | refused (error callback with `null`) | 16 ch, ladder in order |
| `decodeAudioData`, 16-ch fMP4 | 16 ch, ladder in order | refused (error callback with `null`) | 16 ch, ladder in order |
| `decodeAudioData`, 2-ch WebM and fMP4 | 2 ch, in order | 2 ch, in order | 2 ch, in order |
| WebCodecs, 16-ch with description | supported, 151 frames, 16 ch in order, 60x realtime | `isConfigSupported` false | supported, 151 frames, 16 ch in order, 86x realtime |
| WebCodecs, 2-ch | supported, 2 ch in order | supported, 2 ch in order | supported, 2 ch in order |
| WASM libopus, 16-ch | 16 ch, ACN order OK, 64x realtime | 16 ch, ACN order OK, 68x realtime | 16 ch, ACN order OK, 8x realtime |
| MediaCapabilities, channels 16 (informational) | true for all four | WebM true, fMP4 false (file and media-source) | true for all four |
| Human row | verdict buttons disabled before Play, enabled after, click recorded | same | same |
| Decoder blocked (negative check) | WASM row fails, Play stays disabled, human stays pending | same | same |

Playwright's WebKit shows the same shape as the real Safari columns above on the two decoding surfaces, and the same yes from the string surfaces for WebM. What it cannot show is a shipping Safari on a shipping OS, which is what the status table is for.

To run it, after `npm install` here and `npx playwright install chromium webkit` (add `firefox` for the third column):

```
node check-playwright.js            # chromium and webkit
node check-playwright.js firefox    # Playwright's Firefox
```

## Regenerating the assets

```
./make-assets.sh
```

Needs ffmpeg with the libopus encoder (`ffmpeg -encoders | grep libopus`) and python3 with the standard library only. The script synthesises the tone ladder with `aevalsrc`, encodes each clip once with libopus (16 channels at 192 kbit/s with `-mapping_family 255`, 2 channels at 64 kbit/s, 20 ms frames, 3 s), remuxes the Ogg output into WebM and fragmented MP4 with `-c copy`, demuxes the Ogg pages into the packet JSON with `ogg-packets.py`, and writes `assets.js`. Output is byte-identical between runs (`-fflags +bitexact -flags +bitexact` as output options), so a regenerated tree diffs clean; the committed files were regenerated with ffmpeg 9.0.1 on 2026-09-12 and matched byte for byte. The embedded total is about 500 KB of base64. 12 kbit/s per channel is low; WebCodecs refuses on the configuration alone, before any packet is sent, and the tone ladder survives the rate intact, but `decodeAudioData` has been tried at this bitrate only.

## Files

- `index.html`: the page.
- `assets.js`: generated, the media as base64 plus the packet JSON.
- `opus16.*`, `opus2.*`, `*-packets.json`: the generated media in each form, kept so they can be inspected with `ffprobe` outside a browser. `afinfo` opens only the 2-channel Ogg and MP4 and refuses the three 16-channel files, which is itself a data point.
- `opus-decoder.min.js`: opus-decoder 0.7.12 by Ethan Halsall, vendored unmodified from the npm package's `dist/opus-decoder.min.js` (byte-identical to the package on npm). Its UMD global is `globalThis['opus-decoder']`.
- `results/`: what the page recorded on each browser in the status table, one JSON per run, named by date, OS and browser, plus the earlier iPhone run described above.
- `measure.mjs`: runs the page in the installed Safari, Chrome and Firefox and writes those files.
- `status-table.mjs`: prints the status table from them.
- `make-assets.sh`, `ogg-packets.py`: asset generation.
- `check-playwright.js`: the smoke check described above.
- `package.json`: `playwright-core`, needed only by `measure.mjs` and `check-playwright.js`.

## Context

I run a livestream that carries third-order Ambisonics as 16-channel Opus. On Safari the audio has to be decoded in WebAssembly and scheduled against the video clock, because neither surface that decodes will take it and the two that answer about a string say yes and then the decode fails; the measurements behind that design, on macOS and on two iPhones, are in the project's notes: [docs/IOS-SAFARI.md](https://github.com/mormegil6/ambisonic-box/blob/main/docs/IOS-SAFARI.md) in [ambisonic-box](https://github.com/mormegil6/ambisonic-box). This page is the reduced, public form of those measurements, built so that anyone can run it on their own device and so that a browser vendor can turn it into a test.

## License

- Source code (`index.html`, `check-playwright.js`, `measure.mjs`, `status-table.mjs`, `make-assets.sh`, `ogg-packets.py`): MIT, see [LICENSE](LICENSE).
- `opus-decoder.min.js`: the opus-decoder wrapper is MIT, copyright Ethan Halsall; it compiles in libopus, BSD 3-clause, copyright Xiph.Org Foundation and others. Both notices are in [LICENSE-opus-decoder](LICENSE-opus-decoder).
- Generated media (`opus16.*`, `opus2.*`, `*-packets.json`, `assets.js`) and the measurement records in `results/`: CC0 1.0, see [LICENSE-ASSETS](LICENSE-ASSETS). Synthetic ffmpeg output and measurements of it, with no third-party material, so anyone can reuse them without attribution.
