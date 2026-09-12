#!/usr/bin/env python3
# Demux an Ogg Opus file into its raw packets and print them as JSON, so the
# page can hand the SAME bytes to WebCodecs and to the WASM decoder that the
# WebM and fMP4 files carry (all three are remuxes of one encode, see
# make-assets.sh). Ogg is used because its framing is a few lines of Python
# with no library: pages start with "OggS", a lacing table follows the 27-byte
# header, and a lacing value of 255 means the packet continues in the next
# segment or page.
#
# Output shape matches the vector the player project already uses:
#   { "description": base64 OpusHead, "sampleRate": 48000, "channels": N,
#     "frameUs": frame duration in microseconds, "packets": [base64, ...] }
# "description" is the OpusHead identification header verbatim (RFC 7845,
# section 5.1); WebCodecs takes it as AudioDecoderConfig.description, and the
# page parses the multistream layout for libopus out of the same bytes.
#
# usage: ogg-packets.py FILE.opus FRAME_MS > FILE-packets.json
import base64, json, struct, sys

path, frame_ms = sys.argv[1], float(sys.argv[2])
data = open(path, 'rb').read()

packets, partial, pos = [], b'', 0
while pos < len(data):
    if data[pos:pos + 4] != b'OggS':
        sys.exit('%s: lost Ogg sync at byte %d' % (path, pos))
    nsegs = data[pos + 26]
    lacing = data[pos + 27:pos + 27 + nsegs]
    body = pos + 27 + nsegs
    for lace in lacing:
        partial += data[body:body + lace]
        body += lace
        if lace < 255:
            packets.append(partial)
            partial = b''
    pos = body

if len(packets) < 3 or not packets[0].startswith(b'OpusHead'):
    sys.exit('%s: first packet is not an OpusHead' % path)
head = packets[0]
channels = head[9]
pre_skip, rate = struct.unpack_from('<HI', head, 10)
audio = packets[2:]          # [0] OpusHead, [1] OpusTags, the rest is audio

out = {
    'description': base64.b64encode(head).decode('ascii'),
    'sampleRate': 48000,     # Opus always decodes at 48 kHz; the header rate is only the original input rate
    'inputSampleRate': rate,
    'channels': channels,
    'preSkip': pre_skip,
    'mappingFamily': head[18],
    'frameUs': int(frame_ms * 1000),
    'packets': [base64.b64encode(p).decode('ascii') for p in audio],
}
json.dump(out, sys.stdout, separators=(',', ':'))
sys.stdout.write('\n')
sys.stderr.write('%s: %d channels, family %d, pre-skip %d, %d audio packets (%.2f s at %g ms)\n'
                 % (path, channels, head[18], pre_skip, len(audio), len(audio) * frame_ms / 1000, frame_ms))
