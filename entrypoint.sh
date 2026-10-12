#!/bin/bash
set -u

# Environment validation
if [ -z "${WEB_URL:-}" ] || [ -z "${RTMP_URL:-}" ]; then
  echo "Error: WEB_URL and RTMP_URL must be set."
  exit 1
fi

# Defaults (FRAMERATE is left to index.js, whose default is now 10)
export SCREEN_WIDTH="${SCREEN_WIDTH:-640}"
export SCREEN_HEIGHT="${SCREEN_HEIGHT:-360}"
export AUDIO_SOURCE="${AUDIO_SOURCE:-icecast}"
export FFMPEG_PRESET="${FFMPEG_PRESET:-ultrafast}"

echo "Starting PageCaster with Puppeteer..."
echo "Audio source: $AUDIO_SOURCE"
echo "Screen size: ${SCREEN_WIDTH}x${SCREEN_HEIGHT}"
echo "Web URL: $WEB_URL"

# Kill background helpers when the container stops
XVFB_PID=""
cleanup() {
  [ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null
  pulseaudio --kill 2>/dev/null
}
trap cleanup EXIT

# --- X display ---
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24" -nolisten tcp -ac &
XVFB_PID=$!
export DISPLAY=:99

# Wait for X to accept connections (instead of hoping it is up)
for i in $(seq 1 50); do
  [ -S /tmp/.X11-unix/X99 ] && break
  sleep 0.2
done
if [ ! -S /tmp/.X11-unix/X99 ]; then
  echo "Error: Xvfb did not start."
  exit 1
fi

# --- Audio: only needed when capturing browser audio ---
if [ "$(echo "$AUDIO_SOURCE" | tr '[:upper:]' '[:lower:]')" = "browser" ]; then
  rm -rf /var/run/pulse /var/lib/pulse /root/.config/pulse
  mkdir -p /root/.config/pulse
  cat > /root/.config/pulse/default.pa << 'EOF'
load-module module-null-sink sink_name=virtual-audio sink_properties=device.description=Virtual_Audio_Device
load-module module-native-protocol-unix auth-anonymous=1 socket=/tmp/pulse-socket
set-default-sink virtual-audio
EOF

  export PULSE_SERVER=unix:/tmp/pulse-socket
  pulseaudio -D --log-level=error --exit-idle-time=-1 --disallow-exit --disable-shm -F /root/.config/pulse/default.pa

  # Wait until PulseAudio answers and the virtual sink exists
  for i in $(seq 1 25); do
    pactl list short sinks 2>/dev/null | grep -q virtual-audio && break
    sleep 0.4
  done
  echo "Checking audio devices:"
  pactl list short sources || echo "pactl failed"
else
  echo "Audio source is not 'browser'; skipping PulseAudio."
fi

# Not exec: keeps the trap alive so Xvfb/Pulse are cleaned up on exit
node src/index.js &
NODE_PID=$!
trap 'kill -TERM "$NODE_PID" 2>/dev/null' TERM INT

# Watchdog: if Xvfb dies, stop Node so the restart policy brings everything back clean
(
  while kill -0 "$NODE_PID" 2>/dev/null; do
    if ! kill -0 "$XVFB_PID" 2>/dev/null; then
      echo "Xvfb died; stopping Node for a clean restart."
      kill -TERM "$NODE_PID" 2>/dev/null
      break
    fi
    sleep 5
  done
) &

wait "$NODE_PID"
exit $?