const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const http = require('http');

const int = (v, d) => (Number.isFinite(parseInt(v)) ? parseInt(v) : d);
const flag = (v, d) => (v === undefined || v === '' ? d : !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase()));

class PageCaster {
  constructor() {
    this.validateEnvironment();
    this.audioSource = process.env.AUDIO_SOURCE || (process.env.ICE_URL ? 'icecast' : 'silent');
    this.webUrl = process.env.WEB_URL;
    this.rtmpUrl = process.env.RTMP_URL;
    this.iceUrl = process.env.ICE_URL;
    this.display = process.env.DISPLAY_NUM || ':99.0';
    this.screenWidth = int(process.env.SCREEN_WIDTH, 640);
    this.screenHeight = int(process.env.SCREEN_HEIGHT, 360);
    this.ffmpegPreset = process.env.FFMPEG_PRESET || 'ultrafast';
    this.ffmpegTune = process.env.FFMPEG_TUNE || 'zerolatency';
    this.ffmpegThreads = process.env.FFMPEG_THREADS || '2';
    this.framerate = int(process.env.FRAMERATE, 10);          // was 15: biggest CPU saver
    this.crf = int(process.env.CRF, 25);                      // slightly lighter than 23
    this.maxrate = process.env.MAXRATE || '1500k';
    this.audioBitrate = process.env.AUDIO_BITRATE || '96k';
    this.maxRestartAttempts = int(process.env.MAX_RESTART_ATTEMPTS, 5);

    // Browser CPU options
    this.disableGpu = flag(process.env.DISABLE_GPU, true);     // set DISABLE_GPU=0 if the host has a real GPU
    this.reduceMotion = flag(process.env.REDUCE_MOTION, false); // REDUCE_MOTION=1 kills CSS animations/transitions

    // Long-run hygiene
    this.recycleHours = int(process.env.RECYCLE_HOURS, 6);
    this.maxHeapMb = int(process.env.MAX_HEAP_MB, 500);
    this.stallSeconds = int(process.env.STALL_SECONDS, 30);
    this.maintIntervalSec = int(process.env.MAINT_INTERVAL_SEC, 15);

    this.browser = null;
    this.page = null;
    this.ffmpegProcess = null;
    this.shuttingDown = false;
    this.cleaned = false;
    this.restartAttempts = 0;
    this.ffmpegStartTime = 0;
    this.ffmpegRunning = false;
    this.ffmpegExiting = false;
    this.lastProgress = 0;
    this.lastFrame = -1;
    this.restartTimer = null;
    this.maintTimer = null;
    this.recycling = false;
    this.isMaintaining = false;
    this.recycleFailures = 0;
    this.nextRecycleAllowed = 0;
    this.pageStartedAt = Date.now();
    this.audioConfig = null;
    this.healthServer = null;

    this.logBudget = 20;
    this.logWindow = Date.now();
    this.suppressed = 0;
  }

  validateEnvironment() {
    const missing = ['WEB_URL', 'RTMP_URL'].filter((e) => !process.env[e]);
    if (missing.length) {
      console.error(`Missing required environment variables: ${missing.join(', ')}`);
      process.exit(1);
    }
  }

  // ---------- Browser ----------

  async setupBrowser() {
    console.log('Starting Puppeteer browser...');
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      `--window-size=${this.screenWidth},${this.screenHeight}`,
      '--window-position=0,0',
      '--force-device-scale-factor=1',
      '--autoplay-policy=no-user-gesture-required',
      '--allow-running-insecure-content',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor,Translate,MediaRouter,IsolateOrigins,site-per-process,OptimizationHints',
      '--disable-site-isolation-trials',
      '--enable-features=PulseAudio',
      '--kiosk',
      // Less background work = less CPU/RAM over time
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--disable-domain-reliability',
      '--disable-client-side-phishing-detection',
      '--disable-hang-monitor',
      '--disable-prompt-on-repost',
      '--disable-smooth-scrolling',
      '--disable-lcd-text',
      '--disable-font-subpixel-positioning',
      '--metrics-recording-only',
      '--no-default-browser-check',
      '--password-store=basic',
      '--use-mock-keychain',
      `--js-flags=--max-old-space-size=${this.maxHeapMb * 2}`
    ];
    if (this.disableGpu) args.push('--disable-gpu');

    this.browser = await puppeteer.launch({
      headless: false,
      ignoreDefaultArgs: ['--enable-automation'],
      args,
      defaultViewport: null
    });

    this.browser.on('disconnected', () => {
      if (!this.shuttingDown) this.fatalError('Browser disconnected');
    });

    const [first] = await this.browser.pages();
    this.page = first || (await this.browser.newPage());
    this.attachPage(this.page);
    await this.loadPage(this.page);
    console.log('Browser setup complete');
  }

  attachPage(page) {
    page.on('error', (e) => {
      console.error('Page crashed:', e);
      if (!this.shuttingDown) this.fatalError('Page crashed');
    });
    page.on('pageerror', () => {});
  }

  async loadPage(page) {
    await page.setViewport({ width: this.screenWidth, height: this.screenHeight });
    if (this.reduceMotion) {
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]).catch(() => {});
      await page.evaluateOnNewDocument(() => {
        document.addEventListener('DOMContentLoaded', () => {
          const s = document.createElement('style');
          s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}';
          document.documentElement.appendChild(s);
        });
      }).catch(() => {});
    }
    console.log(`Navigating to: ${this.webUrl}`);
    await page.goto(this.webUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 2000));
    this.pageStartedAt = Date.now();
  }

  async recyclePage(reason) {
    if (this.recycling || this.shuttingDown) return;
    this.recycling = true;
    console.log(`Recycling page (${reason})...`);
    const old = this.page;
    let fresh = null;
    try {
      fresh = await this.browser.newPage();
      this.attachPage(fresh);
      await this.loadPage(fresh);
      await fresh.bringToFront();
      this.page = fresh;
      this.recycleFailures = 0;

      if (this.audioSource.toLowerCase() === 'browser') await this.kickMedia(fresh);

      old.removeAllListeners();
      await old.close().catch(() => {});
    } catch (e) {
      console.error('Page recycle failed:', e.message);
      if (fresh && fresh !== this.page) {
        fresh.removeAllListeners();
        await fresh.close().catch(() => {});
      }
      if (++this.recycleFailures >= 3) {
        this.fatalError('Page recycle failed 3 times in a row');
      }
      this.nextRecycleAllowed = Date.now() + 60000;
    } finally {
      this.recycling = false;
    }
  }

  async kickMedia(page) {
    await page
      .evaluate(() => document.querySelectorAll('audio, video').forEach((el) => el.play && el.play().catch(() => {})))
      .catch(() => {});
  }

  startMaintenance() {
    this.maintTimer = setInterval(async () => {
      if (this.shuttingDown || this.isMaintaining) return;
      this.isMaintaining = true;
      try {
        if (this.ffmpegRunning && this.lastProgress &&
            Date.now() - this.lastProgress > this.stallSeconds * 1000) {
          console.warn(`FFmpeg made no progress for ${this.stallSeconds}s, killing it.`);
          this.lastProgress = Date.now();
          try { this.ffmpegProcess.kill('SIGKILL'); } catch (_) {}
        }

        if (this.recycling || !this.page || Date.now() < this.nextRecycleAllowed) return;

        try {
          const m = await Promise.race([
            this.page.metrics(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('metrics timeout')), 5000))
          ]);
          const heapMb = m.JSHeapUsedSize / 1048576;
          if (heapMb > this.maxHeapMb) {
            return await this.recyclePage(`JS heap ${Math.round(heapMb)}MB > ${this.maxHeapMb}MB`);
          }
        } catch (e) {
          if (e.message === 'metrics timeout') {
            return await this.recyclePage('page unresponsive');
          }
        }

        if (this.recycleHours > 0 &&
            Date.now() - this.pageStartedAt > this.recycleHours * 3600 * 1000) {
          await this.recyclePage('scheduled');
        }
      } finally {
        this.isMaintaining = false;
      }
    }, this.maintIntervalSec * 1000);
  }

  // ---------- Audio ----------

  async setupAudioCapture() {
    console.log(`Setting up audio capture (source: ${this.audioSource})`);
    switch (this.audioSource.toLowerCase()) {
      case 'browser': return this.setupWebpageAudio();
      case 'icecast': return this.setupIcecastAudio();
      default: return { type: 'silent' };
    }
  }

  async setupWebpageAudio() {
    try {
      await this.page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 });

      const info = await this.page.evaluate(() => {
        let state = 'none';
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) {
          const ctx = new Ctx();
          state = ctx.state;
          ctx.resume();
          setTimeout(() => ctx.close().catch(() => {}), 1000);
        }
        const els = document.querySelectorAll('audio, video');
        els.forEach((el) => el.play && el.play().catch(() => {}));
        return { state, count: els.length };
      });

      if (info.state === 'running' || info.count > 0) {
        console.log(`Capturing browser audio via PulseAudio (ctx: ${info.state}, elements: ${info.count})`);
        return { type: 'stream' };
      }
      console.log('No audio found, using silent audio');
      return { type: 'silent' };
    } catch (e) {
      console.error('Webpage audio setup failed:', e.message);
      return { type: 'silent' };
    }
  }

  setupIcecastAudio() {
    if (this.iceUrl) return { type: 'url', source: this.iceUrl };
    console.log('No ICE_URL provided, using silent audio');
    return { type: 'silent' };
  }

  // ---------- FFmpeg ----------

  async startScreencast() {
    if (!this.audioConfig) this.audioConfig = await this.setupAudioCapture();
    const args = this.buildFFmpegArgs(this.audioConfig);
    console.log('Starting FFmpeg:', args.join(' '));
    this.startFFmpeg(args);
  }

  log(line) {
    const now = Date.now();
    if (now - this.logWindow > 1000) {
      if (this.suppressed) console.log(`(${this.suppressed} FFmpeg log lines suppressed)`);
      this.logWindow = now;
      this.logBudget = 20;
      this.suppressed = 0;
    }
    if (this.logBudget-- > 0) console.log(line);
    else this.suppressed++;
  }

  startFFmpeg(args) {
    this.ffmpegStartTime = Date.now();
    this.lastProgress = Date.now();
    this.lastFrame = -1;
    this.ffmpegRunning = true;
    this.ffmpegExiting = false;

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.ffmpegProcess = proc;

    let lineBuffer = '';
    proc.stdout.on('data', (d) => {
      lineBuffer += d;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop().slice(-512);
      for (const line of lines) {
        if (!line.startsWith('frame=')) continue;
        const frame = parseInt(line.slice(6), 10);
        if (Number.isFinite(frame) && frame !== this.lastFrame) {
          this.lastFrame = frame;
          this.lastProgress = Date.now();
        }
      }
    });

    proc.stderr.on('data', (d) => this.log(`FFmpeg: ${String(d).trimEnd()}`));
    proc.on('close', (code) => {
      console.log(`FFmpeg exited with code ${code}`);
      this.handleFFmpegExit(code);
    });
    proc.on('error', (e) => {
      console.error('FFmpeg process error:', e);
      this.handleFFmpegExit(-1);
    });
  }

  handleFFmpegExit(code) {
    if (this.ffmpegExiting) return;
    this.ffmpegExiting = true;
    this.ffmpegRunning = false;
    if (this.shuttingDown) return;

    const runDuration = Date.now() - this.ffmpegStartTime;
    if (runDuration > 60000) this.restartAttempts = 0;

    if (++this.restartAttempts > this.maxRestartAttempts) {
      return this.fatalError('FFmpeg restart limit exceeded');
    }

    const delay = Math.min(1000 * 2 ** (this.restartAttempts - 1), 30000);
    console.log(`Restarting FFmpeg in ${delay}ms (attempt ${this.restartAttempts}, ran ${Math.round(runDuration / 1000)}s)`);

    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      if (this.shuttingDown) return;
      try {
        await this.startScreencast();
      } catch (e) {
        console.error('Failed to restart FFmpeg:', e);
        this.ffmpegExiting = false;
        this.handleFFmpegExit(-1);
      }
    }, delay);
  }

  buildFFmpegArgs(audio) {
    const fps = this.framerate.toString();

    const input = [
      '-y', '-nostdin', '-nostats', '-loglevel', 'warning',
      '-progress', 'pipe:1',
      '-f', 'x11grab',
      '-framerate', fps,
      '-video_size', `${this.screenWidth}x${this.screenHeight}`,
      '-draw_mouse', '0',
      '-thread_queue_size', '512',
      '-i', this.display
    ];

    const audioIn = [];
    if (audio.type === 'url') audioIn.push('-thread_queue_size', '512', '-i', audio.source);
    else if (audio.type === 'stream') audioIn.push('-thread_queue_size', '512', '-f', 'pulse', '-i', 'virtual-audio.monitor');
    else audioIn.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');

    const output = [
      '-c:v', 'libx264',
      '-preset', this.ffmpegPreset,
      ...(this.ffmpegTune ? ['-tune', this.ffmpegTune] : []),
      '-profile:v', 'main',
      '-threads', this.ffmpegThreads,
      '-crf', this.crf.toString(),
      '-maxrate', this.maxrate,
      '-bufsize', '3000k',
      '-pix_fmt', 'yuv420p',
      '-g', (this.framerate * 2).toString(),
      '-sc_threshold', '0',
      '-r', fps,
      '-fps_mode', 'cfr',
      '-c:a', 'aac', '-b:a', this.audioBitrate, '-ac', '2', '-ar', '44100',
      '-flush_packets', '1',
      '-rtmp_live', 'live',
      '-rw_timeout', '10000000',
      '-f', 'flv',
      this.rtmpUrl
    ];

    return [...input, ...audioIn, ...output];
  }

  // ---------- Lifecycle ----------

  async killFFmpeg() {
    const p = this.ffmpegProcess;
    if (!p || p.exitCode !== null || p.signalCode) return;
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} resolve(); }, 3000);
      p.once('close', () => { clearTimeout(t); resolve(); });
      try { p.kill('SIGTERM'); } catch (_) { clearTimeout(t); resolve(); }
    });
  }

  async cleanup() {
    if (this.shuttingDown && this.cleaned) return;
    this.cleaned = true;
    console.log('Cleaning up resources...');
    this.shuttingDown = true;

    clearTimeout(this.restartTimer);
    clearInterval(this.maintTimer);
    if (this.healthServer) this.healthServer.close();

    await this.killFFmpeg();
    try { if (this.page) await this.page.close(); } catch (_) {}
    try { if (this.browser) await this.browser.close(); } catch (_) {}
  }

  fatalError(reason) {
    console.error(`Fatal error: ${reason}. Exiting so the restart policy can recover.`);
    this.shuttingDown = true;
    try { this.ffmpegProcess && this.ffmpegProcess.kill('SIGKILL'); } catch (_) {}
    try { this.browser && this.browser.process() && this.browser.process().kill('SIGKILL'); } catch (_) {}
    process.exit(1);
  }

  startHealthServer() {
    const port = int(process.env.HEALTH_PORT, 8080);
    this.healthServer = http.createServer((req, res) => {
      if (req.url === '/healthz' || req.url === '/health') {
        const browserOk = !!(this.browser && this.browser.isConnected());
        const flowing = Date.now() - this.lastProgress < this.stallSeconds * 1000;
        const healthy = this.ffmpegRunning && browserOk && flowing;
        res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: healthy ? 'ok' : 'degraded',
          ffmpegRunning: this.ffmpegRunning,
          framesFlowing: flowing,
          browserConnected: browserOk,
          rssMb: Math.round(process.memoryUsage().rss / 1048576),
          pageAgeMinutes: Math.round((Date.now() - this.pageStartedAt) / 60000),
          uptimeSeconds: Math.round(process.uptime())
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    this.healthServer.listen(port, () => console.log(`Health server on :${port}`));
  }

  async start() {
    try {
      console.log(`Starting PageCaster: ${this.webUrl} -> ${this.rtmpUrl} (${this.screenWidth}x${this.screenHeight}@${this.framerate}, audio: ${this.audioSource})`);
      this.startHealthServer();
      await this.setupBrowser();
      await this.startScreencast();
      this.startMaintenance();
    } catch (e) {
      console.error('Error starting PageCaster:', e);
      await this.cleanup();
      process.exit(1);
    }
  }
}

const shutdown = async (sig) => {
  console.log(`\nReceived ${sig}, shutting down gracefully...`);
  if (global.pageCaster) await global.pageCaster.cleanup();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
process.on('uncaughtException', (e) => {
  console.error('Uncaught exception:', e);
  if (global.pageCaster) global.pageCaster.fatalError('uncaught exception');
  else process.exit(1);
});

global.pageCaster = new PageCaster();
global.pageCaster.start();