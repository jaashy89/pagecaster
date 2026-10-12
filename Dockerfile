FROM node:24-alpine3.21

# pulseaudio-utils provides pactl (used by entrypoint.sh); tini reaps Chrome's zombie children
RUN apk add --no-cache \
    chromium \
    xvfb \
    ffmpeg \
    bash \
    ttf-freefont \
    ca-certificates \
    pulseaudio \
    pulseaudio-utils \
    alsa-plugins-pulse \
    tini

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Route ALSA to PulseAudio (PULSE_SERVER is set by entrypoint.sh only when AUDIO_SOURCE=browser)
RUN echo "pcm.!default { type pulse }" > /etc/asound.conf && \
    echo "ctl.!default { type pulse }" >> /etc/asound.conf

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ ./src/
COPY entrypoint.sh .

# chmod + strip Windows line endings (CRLF breaks bash scripts)
RUN sed -i 's/\r$//' entrypoint.sh && chmod +x entrypoint.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bash", "entrypoint.sh"]