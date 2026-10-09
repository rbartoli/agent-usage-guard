#!/usr/bin/env bash
# Builds assets/agent-usage-guard.gif: records each scene with VHS, puts its
# caption above it, and joins the scenes. The scenes run demo/run-demo.sh, so
# Claude Code talks only to the scripted local API.
#
#   demo/render.sh           record every scene, then build the GIF
#   demo/render.sh --reuse   build the GIF from the recordings in demo/out
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

# A caption bar as wide as the recording: the scene's label in the lavender of
# the guard's question chip, its headline, and one progress mark per scene.
caption() {
  local out=$1 index=$2 label=$3 headline=$4
  local width=1200 height=84 accent='#afb8f9' color x
  local args=(-size "${width}x${height}" xc:'#0c0f16'
    -font DejaVu-Sans-Mono-Bold -pointsize 15 -kerning 1.5 -fill "$accent" -annotate +28+30 "$label"
    -font DejaVu-Sans-Bold -pointsize 25 -kerning 0 -fill '#f0f6fc' -annotate +28+65 "$headline"
    -fill '#21262d' -draw "rectangle 0,$((height - 1)) $width,$height")
  x=$((width - 28 - ${#scenes[@]} * 34 + 6))
  for ((k = 1; k <= ${#scenes[@]}; k++)); do
    color='#30363d'
    ((k <= index)) && color=$accent
    args+=(-fill "$color" -draw "roundrectangle $x,22 $((x + 27)),26 2,2")
    x=$((x + 34))
  done
  convert "${args[@]}" "$out"
}

mkdir -p demo/out
if [ "${1:-}" != --reuse ]; then
  for scene in "${scenes[@]}"; do vhs -q "demo/tapes/$scene.tape"; done
fi

inputs=() graph='' joined=''
for i in "${!scenes[@]}"; do
  caption "demo/out/${scenes[$i]}-caption.png" $((i + 1)) "${labels[$i]}" "${headlines[$i]}"
  inputs+=(-loop 1 -framerate 25 -i "demo/out/${scenes[$i]}-caption.png" -i "demo/out/${scenes[$i]}.gif")
  graph+="[$((2 * i))][$((2 * i + 1))]vstack=shortest=1,fps=12.5[s$i];"
  joined+="[s$i]"
done
graph+="${joined}concat=n=${#scenes[@]}:v=1:a=0,split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle"
ffmpeg -v error -y "${inputs[@]}" -filter_complex "$graph" assets/agent-usage-guard.gif
echo "assets/agent-usage-guard.gif: $(du -k assets/agent-usage-guard.gif | cut -f1) KB"
