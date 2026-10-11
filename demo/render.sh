#!/usr/bin/env bash
# Builds the demo: demo/out/agent-usage-guard.mp4 for posts and
# demo/out/agent-usage-guard.gif for the README. Records each scene with VHS,
# puts its caption above it, and joins the scenes. The scenes run
# demo/run-demo.sh, so Claude Code talks only to the scripted local API.
#
#   demo/render.sh                  record every scene, then build both
#   demo/render.sh --reuse          build both from the recordings in demo/out
#   demo/render.sh cold-cache ...   record and build only the named scenes
#
# The README shows the GIF from a release, so installs do not copy it. To
# publish a new one, attach it to a release with `gh release upload <tag>
# demo/out/agent-usage-guard.gif` and point the README's image at that tag.
#
# Needs VHS 0.11, ttyd, ffmpeg, ImageMagick and the DejaVu fonts, plus what
# demo/run-demo.sh needs.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

scenes=(cold-cache fan-out heavy-context agent-tokens)
labels=('COLD CACHE' 'PARALLEL AGENTS' 'HEAVY-CONTEXT LOOP' 'SUBAGENT TOKENS')
headlines=(
  'A 486k-token session, resumed after two hours'
  'Claude starts five agents at once; the limit is four'
  'Twenty tool calls in a row, each re-reading 433k tokens'
  'Four agents processed 10.9M tokens, and Claude wants a fifth'
)

# Matches demo/tapes/settings.tape: the recordings are 1440 px wide, and the
# caption shares the margin's colour, so both read as one canvas around the
# terminal window.
width=1440 canvas='#1c2230' accent='#0091FF'

# A caption bar as wide as the recording: the scene's label in the brand
# accent, its headline, and one progress mark per scene.
caption() {
  local out=$1 index=$2 label=$3 headline=$4
  local height=104 color x
  local args=(-size "${width}x${height}" xc:"$canvas"
    -font DejaVu-Sans-Mono-Bold -pointsize 18 -kerning 1.8 -fill "$accent" -annotate +48+40 "$label"
    -font DejaVu-Sans-Bold -pointsize 30 -kerning 0 -fill '#f0f6fc' -annotate +48+84 "$headline")
  x=$((width - 48 - ${#scenes[@]} * 41 + 7))
  for ((k = 1; k <= ${#scenes[@]}; k++)); do
    color='#30363d'
    ((k <= index)) && color=$accent
    args+=(-fill "$color" -draw "roundrectangle $x,28 $((x + 32)),33 2,2")
    x=$((x + 41))
  done
  convert "${args[@]}" "$out"
}

reuse=0 picked=()
for arg in "$@"; do
  if [ "$arg" = --reuse ]; then reuse=1; else picked+=("$arg"); fi
done
((${#picked[@]})) || picked=("${scenes[@]}")

mkdir -p demo/out
inputs=() graph='' joined='' n=0
for i in "${!scenes[@]}"; do
  scene=${scenes[$i]}
  [[ " ${picked[*]} " == *" $scene "* ]] || continue
  ((reuse)) || vhs -q "demo/tapes/$scene.tape"
  caption "demo/out/$scene-caption.png" $((i + 1)) "${labels[$i]}" "${headlines[$i]}"
  inputs+=(-loop 1 -framerate 25 -i "demo/out/$scene-caption.png" -i "demo/out/$scene.mp4")
  graph+="[$((2 * n))][$((2 * n + 1))]vstack=shortest=1[s$n];"
  joined+="[s$n]"
  n=$((n + 1))
done
((n)) || { echo "no such scene: ${picked[*]} (scenes: ${scenes[*]})" >&2; exit 1; }

# The MP4 keeps every frame at full size; the GIF drops to 12.5 fps and 960 px
# wide, with one palette for the whole film.
graph+="${joined}concat=n=$n:v=1:a=0,split[mp4][g];"
graph+="[g]fps=12.5,scale=960:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle[gif]"
mp4=demo/out/agent-usage-guard.mp4 gif=demo/out/agent-usage-guard.gif
ffmpeg -v error -y "${inputs[@]}" -filter_complex "$graph" \
  -map '[mp4]' -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart "$mp4" \
  -map '[gif]' "$gif"
echo "$mp4: $(du -k "$mp4" | cut -f1) KB"
echo "$gif: $(du -k "$gif" | cut -f1) KB"
