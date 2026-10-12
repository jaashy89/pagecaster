# Pagecaster
<img src="assets/logo.svg" alt="Ephemeris Icon" width="125" align="right">
<p align="justify">
Pagecaster streams a web browser to an RTMP server with flexible audio source options! It uses Puppeteer to control a headless browser and streams the content via FFmpeg to an RTMP server. You can choose between webpage audio capture, external Icecast streams, or silent audio. A 360p stream typically consumes about a quarter of a CPU core and 250MB of RAM.
</p>

# Examples
The following examples are provided as a way to get started. Some adjustments may be required before production use, particularly regarding secret management.
## Docker
```shell
# With browser audio capture
docker run -d \
--shm-size=256m \
-e WEB_URL="https://weatherstar.netbymatt.com/" \
-e AUDIO_SOURCE="browser" \
-e RTMP_URL="rtmp://supercool.stream:1935/live" \
-e SCREEN_HEIGHT=480 \
-e SCREEN_WIDTH=854 \
ghcr.io/rmitchellscott/pagecaster

# With Icecast audio stream
docker run -d \
--shm-size=256m \
-e WEB_URL="https://weatherstar.netbymatt.com/" \
-e AUDIO_SOURCE="icecast" \
-e ICE_URL="https://radio.supercool.stream" \
-e RTMP_URL="rtmp://supercool.stream:1935/live" \
-e SCREEN_HEIGHT=480 \
-e SCREEN_WIDTH=854 \
ghcr.io/rmitchellscott/pagecaster

# With silent audio
docker run -d \
--shm-size=256m \
-e WEB_URL="https://weatherstar.netbymatt.com/" \
-e AUDIO_SOURCE="silent" \
-e RTMP_URL="rtmp://supercool.stream:1935/live" \
-e SCREEN_HEIGHT=480 \
-e SCREEN_WIDTH=854 \
ghcr.io/rmitchellscott/pagecaster
```

## Docker Compose

```yaml
version: '3.8'

services:
  pagecaster:
    image: ghcr.io/rmitchellscott/pagecaster
    deploy:
      resources:
        limits:
          shm_size: 256m
    environment:
      - WEB_URL=https://weatherstar.netbymatt.com/
      - AUDIO_SOURCE=browser  # or 'icecast' or 'silent'
      - ICE_URL=https://radio.supercool.stream  # only needed if AUDIO_SOURCE=icecast
      - RTMP_URL=rtmp://supercool.stream:1935/live
      - SCREEN_HEIGHT=480
      - SCREEN_WIDTH=854
    restart: always
```

## Kubernetes statefulset
```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: pagecaster
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/component: pagecaster
      app.kubernetes.io/instance: pagecaster
      app.kubernetes.io/name: pagecaster
  serviceName: pagecaster
  template:
    metadata:
      labels:
        app.kubernetes.io/component: pagecaster
        app.kubernetes.io/instance: pagecaster
        app.kubernetes.io/name: pagecaster
    spec:
      containers:
      - env:
        - name: RTMP_URL
          value: rtmp://supercool.stream:1935/live
        - name: SCREEN_HEIGHT
          value: "480"
        - name: SCREEN_WIDTH
          value: "854"
        - name: WEB_URL
          value: https://weatherstar.netbymatt.com/
       - name: ICE_URL
          value: https://radio.supercool.stream
        image: ghcr.io/rmitchellscott/pagecaster
        imagePullPolicy: IfNotPresent
        name: pagecaster
        volumeMounts:
        - mountPath: /dev/shm
          name: dshm
      volumes:
      - emptyDir:
          sizeLimit: 256Mi
        name: dshm
```

## Kubernetes via flux, using the bjw-s/app-template Helm chart
```yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: pagecaster
spec:
  chart:
    spec:
      chart: app-template
      version: 3.3.2
      reconcileStrategy: ChartVersion
      sourceRef:
        kind: HelmRepository
        namespace: flux-system
        name: bjw-s
  interval: 1h
  driftDetection:
    mode: enabled
  values:
    controllers:
     pagecaster:
        type: statefulset
        replicas: 1
        containers:
          pagecaster:
            image:
              repository: ghcr.io/rmitchellscott/pagecaster
              pullPolicy: IfNotPresent
            env:
              WEB_URL: "https://weatherstar.netbymatt.com/"
              ICE_URL: "https://radio.supercool.stream"
              RTMP_URL: rtmp://supercool.stream:1935/live
              SCREEN_WIDTH: 854
              SCREEN_HEIGHT: 480

    persistence:
      dshm:
        enabled: true
        type: emptyDir
        sizeLimit: 256Mi
        globalMounts:
          - path: /dev/shm
            readOnly: false
````

# Environment Variables

| Variable                 | Required? | Details | Example |
|--------------------------|-----------|---------|---------|
| WEB_URL               | yes       | URL to stream | https://weatherstar.netbymatt.com/   |
| AUDIO_SOURCE          | no        | Audio source: 'browser', 'icecast', or 'silent' (default: auto-detects to 'icecast' if ICE_URL is set, otherwise 'silent') | browser |
| ICE_URL               | conditional | Icecast URL (required if AUDIO_SOURCE=icecast) | https://radio.supercool.stream |
| RTMP_URL               | yes       | RTMP URL to stream to | rtmp://supercool.stream:1935/live |
| SCREEN_HEIGHT           | no        | Height of browser window (default: 360) | 360 |
| SCREEN_WIDTH          | no        | Width of browser window (default: 640) | 640 |
| FFMPEG_PRESET         | no        | FFmpeg encoding preset (default: ultrafast) | ultrafast |
| FFMPEG_TUNE           | no        | Optional x264 tune (default: zerolatency) | zerolatency |
| FRAMERATE             | no        | Video framerate (default: 10) | 15 |
| CRF                   | no        | x264 quality (lower = better, default: 25) | 23 |
| MAXRATE               | no        | Max video bitrate (default: 1500k) | 2000k |
| AUDIO_BITRATE         | no        | Audio bitrate (default: 96k) | 128k |
| FFMPEG_THREADS        | no        | Cap on FFmpeg encoder threads (default: 2) | 2 |
| PAGE_CPU_THROTTLE     | no        | Renderer CPU throttle factor via CDP (default: 2, 1 = off) | 2 |
| REDUCE_MOTION         | no        | Kill CSS animations/transitions (default: true) | true |
| DISABLE_EFFECTS       | no        | Kill backdrop-filter/will-change (default: true) | true |
| DISABLE_GPU           | no        | Disable GPU (default: true; set 0 if host has a real GPU) | true |
| BLOCK_RESOURCE_TYPES  | no        | Comma-separated resource types to block (default: font) | font,image |
| BLOCK_ASSETS          | no        | Comma-separated URL substrings to block (default: none) | analytics,ads |
| MAX_RESTART_ATTEMPTS  | no        | Max consecutive FFmpeg restarts before giving up (default: 5) | 5 |
| RECYCLE_HOURS         | no        | Reload the page every N hours to free leaked memory (default: 6, 0 = off) | 6 |
| MAX_HEAP_MB           | no        | Reload the page if its JS heap exceeds this (default: 500) | 500 |
| STALL_SECONDS         | no        | Kill FFmpeg if no frames flow for this long (default: 30) | 30 |
| MAINT_INTERVAL_SEC    | no        | Maintenance loop interval (default: 15) | 15 |
| MAX_UPTIME_HOURS      | no        | Clean full restart after N hours (default: 24, 0 = off) | 24 |
| MAX_CONTAINER_MB      | no        | Restart if container memory exceeds this (default: 0 = off) | 800 |
| HEALTH_PORT           | no        | Port for the HTTP health check endpoint (default: 8080) | 8080 |

## Audio Source Options

- **browser**: Captures audio directly from the webpage using pulseaudio
- **icecast**: Uses an external Icecast stream as the audio source (maintains backward compatibility)
- **silent**: Generates a silent audio track for video-only streaming

## Health Check

The application exposes an HTTP health endpoint at `/healthz` (or `/health`) on port `8080` (configurable via `HEALTH_PORT`). It returns `200` when the stream is healthy and `503` when degraded:

```shell
curl http://localhost:8080/healthz
```

```json
{
  "status": "ok",
  "ffmpegRunning": true,
  "browserConnected": true,
  "uptimeSeconds": 1234
}
```

Use this with your orchestrator's liveness/readiness probes (e.g. Kubernetes `livenessProbe` or Docker `HEALTHCHECK`).
