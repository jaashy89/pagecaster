FROM node:24-alpine3.21

RUN apk update && \
    apk add --no-cache \
    chromium \
    xvfb \
    ffmpeg \
    bash \
    udev \
    ttf-freefont \
    ca-certificates \
    pulseaudio \
    alsa-utils \
    dbus

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    PULSE_SERVER=unix:/tmp/pulse-socket

# Create audio configuration
RUN echo "pcm.!default { type pulse }" > /etc/asound.conf && \
    echo "ctl.!default { type pulse }" >> /etc/asound.conf

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY entrypoint.sh .

RUN chmod +x entrypoint.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:8080/healthz || exit 1

CMD ["bash", "entrypoint.sh"]
