#!/usr/bin/env bash
# Regenerate matrix/files: Opus test streams at several channel counts and
# mapping families, for matrix/index.html. Needs ffmpeg with libopus and python3.
#
# Family 255 (independent streams): any channel count, encoded uncoupled, including
#   mono and stereo, where it differs from family 0 only in the header and stream layout.
# Family 1 (RFC 7845 5.1.1.2, Vorbis layouts): 3.0, quad, 5.1 and 7.1, encoded by
#   ffmpeg's libopus wrapper with real surround layouts (so coupled streams).
# Family 2 (RFC 8486, Ambisonics): ffmpeg cannot encode it, and a family 2 stream
#   with no non-diegetic pair is structurally the same as an uncoupled, identity-
#   mapped family 255 stream, so these are the family 255 streams with the one
#   mapping-family byte of the OpusHead changed from 255 to 2. Only 4 and 16
#   channels are used, both allowed counts for family 2 (RFC 8486 3.3).
# The 2-channel control and the 16-channel stream are the repo's own opus2.webm
# and opus16.webm, so the matrix agrees with the main page.
set -e
cd "$(dirname "$0")"
OUT=matrix/files; mkdir -p "$OUT"
BITEXACT="-fflags +bitexact -flags +bitexact"
expr() { python3 -c "print('|'.join('0.4*sin(2*PI*%d*t)' % (200+100*k) for k in range($1)))"; }

enc() { # family channels layout
  local tag="f$1-$2ch"
  ffmpeg -y -v error -f lavfi -i "aevalsrc=exprs='$(expr "$2")':c=$3:s=48000:d=2" \
    -c:a libopus -b:a "$(( $2 * 24 > 64 ? $2 * 24 : 64 ))k" -frame_duration 20 -mapping_family "$1" $BITEXACT -f ogg "$OUT/$tag.opus"
  ffmpeg -y -v error -i "$OUT/$tag.opus" -c copy $BITEXACT -f webm "$OUT/$tag.webm"
  python3 ogg-packets.py "$OUT/$tag.opus" 20 > "$OUT/$tag-packets.json"
  rm "$OUT/$tag.opus"
}
enc 255 1 mono; enc 255 2 stereo
for n in 3 4 6 8 10 12; do enc 255 "$n" "${n}c"; done
enc 1 2 stereo; enc 1 3 3.0; enc 1 4 quad; enc 1 6 5.1; enc 1 8 7.1

cp opus2.webm "$OUT/f0-2ch.webm";   cp opus2-packets.json  "$OUT/f0-2ch-packets.json"
cp opus16.webm "$OUT/f255-16ch.webm"; cp opus16-packets.json "$OUT/f255-16ch-packets.json"

python3 - <<'PY'
import base64, json
OUT = 'matrix/files'
for src, dst in (('f255-4ch', 'f2-4ch'), ('f255-16ch', 'f2-16ch')):
    b = bytearray(open(f'{OUT}/{src}.webm', 'rb').read()); i = b.find(b'OpusHead')
    assert b[i + 18] == 255 and b[i + 20] == 0, 'expected an uncoupled family 255 stream'
    b[i + 18] = 2; open(f'{OUT}/{dst}.webm', 'wb').write(b)
    d = json.load(open(f'{OUT}/{src}-packets.json'))
    h = bytearray(base64.b64decode(d['description'])); assert h[18] == 255; h[18] = 2
    d['description'] = base64.b64encode(bytes(h)).decode(); d['mappingFamily'] = 2
    json.dump(d, open(f'{OUT}/{dst}-packets.json', 'w'))
PY
echo "wrote $(ls $OUT/*.webm | wc -l | tr -d ' ') streams to $OUT ($(du -sh $OUT | cut -f1))"
