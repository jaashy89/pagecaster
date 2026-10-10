const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const http = require('http');

const int = (v, d) => (Number.isFinite(parseInt(v)) ? parseInt(v) : d);

class PageCaster {
  constructor() {
    this.validateEnvironment();
    this.audioSource = process.env.AUDIO_SOURCE || (process.env.ICE_URL ? 'icecast' : 'silent');
    this.webUrl = process.env.WEB_URL;
    this.rtmpUrl = process.env.RTMP_URL;
    this.iceUrl = process.env.ICE_URL;
    this.screenWidth = int(process.env.SCREEN_WIDTH, 854);
    this.screenHeight = int(process.env.SCREEN_HEIGHT, 480);
    this.ffmpegPreset = process.env.FFMPEG_PRESET || 'veryfast';
    this.ffmpegTune = process.env.FFMPEG_TUNE || '';
    this.ffmpegThreads = process.env.FFMPEG_THREADS || '3'; // cap CPU use
    this.framerate = int(process.env.FRAMERATE, 30);
    this.crf = int(process.env.CRF, 23);
    this.maxrate = process.env.MAXRATE || '2000k';
    this.maxRestartAttempts = int(process.env.MAX_RESTART_ATTEMPTS, 5);

    // Long-run hygiene
    this.recycleHours = int(process.env.RECYCLE_HOURS, 6);       // fresh page every N hours (0 = off)
    this.maxHeapMb = int(process.env.MAX_HEAP_MB, 500);          // reload page if JS heap exceeds this
    this.stallSeconds = int(process.env.STALL_SECONDS, 30);      // kill FFmpeg if no frames for this long

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

    // Log rate limiting (prevents log flooding -> disk growth / CPU)
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
    this.browser = await puppeteer.launch({
      headless: false,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        `--window-size=${this.screenWidth},${this.screenHeight}`,
        '--window-position=0,0',
        '--autoplay-policy=no-user-gesture-required',
        '--allow-running-insecure-content',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor,Translate,MediaRouter',
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
        '--metrics-recording-only',
        '--no-default-browser-check',
        '--password-store=basic',
        `--js-flags=--max-old-space-size=${this.maxHeapMb * 2}`
      ],
      defaultViewport: null
    });

    this.browser.on('disconnected', () => {
      if (!this.shuttingDown) this.fatalError('Browser disconnected');
    });

    // Reuse the initial tab instead of leaving an extra about:blank renderer alive
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
    page.on('pageerror', () => {}); // swallow page JS errors; don't accumulate listeners/logs
  }

  async loadPage(page) {
    await page.setViewport({ width: this.screenWidth, height: this.screenHeight });
    console.log(`Navigating to: ${this.webUrl}`);
    await page.goto(this.webUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 2000));
    this.pageStartedAt = Date.now();
  }

  // Replace the page with a fresh one (frees leaked renderer memory)
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

      // Browser-audio mode: make sure media on the new page is playing
      if (this.audioSource.toLowerCase() === 'browser') await this.kickMedia(fresh);

      old.removeAllListeners();
      await old.close().catch(() => {});
    } catch (e) {
      console.error('Page recycle failed:', e.message);
      // Don't leak the half-loaded tab
      if (fresh && fresh !== this.page) {
        fresh.removeAllListeners();
        await fresh.close().catch(() => {});
      }
      // Tolerate transient failures (site briefly down), but not a broken browser
      if (++this.recycleFailures >= 3) {
        this.fatalError('Page recycle failed 3 times in a row');
      }
      this.nextRecycleAllowed = Date.now() + 60000; // cooldown before retrying
    } finally {
      this.recycling = false;
    }
  }

  async kickMedia(page) {
    await page
      .evaluate(() => document.querySelectorAll('audio, video').forEach((el) => el.play && el.play().catch(() => {})))
      .catch(() => {});
  }

  // Runs every 10s: FFmpeg stall check, heap check, scheduled recycle
  startMaintenance() {
    this.maintTimer = setInterval(async () => {
      if (this.shuttingDown || this.isMaintaining) return;
      this.isMaintaining = true;
      try {
        // FFmpeg stalled (e.g. hung RTMP socket) but process still alive
        if (this.ffmpegRunning && this.lastProgress &&
            Date.now() - this.lastProgress > this.stallSeconds * 1000) {
          console.warn(`FFmpeg made no progress for ${this.stallSeconds}s, killing it.`);
          this.lastProgress = Date.now();
          try { this.ffmpegProcess.kill('SIGKILL'); } catch (_) {}
        }

        if (this.recycling || !this.page || Date.now() < this.nextRecycleAllowed) return;

        // Heap check (with timeout: a frozen renderer would otherwise hang forever)
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

        // Scheduled recycle
        if (this.recycleHours > 0 &&
            Date.now() - this.pageStartedAt > this.recycleHours * 3600 * 1000) {
          await this.recyclePage('scheduled');
        }
      } finally {
        this.isMaintaining = false;
      }
    }, 10000);
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
        // Probe with a throwaway context and close it, so we don't leak one
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

    // `-progress pipe:1` prints key=value lines; "frame=N" is our heartbeat
    let lineBuffer = '';
    proc.stdout.on('data', (d) => {
      lineBuffer += d;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop().slice(-512); // keep incomplete tail, bounded
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
    if (this.ffmpegExiting) return; // 'close' and 'error' may both fire
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
      '-s', `${this.screenWidth}x${this.screenHeight}`,
      '-draw_mouse', '0',
      '-thread_queue_size', '512',
      '-i', ':99.0'
    ];

    const audioIn = [];
    if (audio.type === 'url') audioIn.push('-thread_queue_size', '512', '-i', audio.source);
    else if (audio.type === 'stream') audioIn.push('-thread_queue_size', '512', '-f', 'pulse', '-i', 'virtual-audio.monitor');
    else audioIn.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');

    const output = [
      '-c:v', 'libx264',
      '-preset', this.ffmpegPreset,
      ...(this.ffmpegTune ? ['-tune', this.ffmpegTune] : []),
      '-threads', this.ffmpegThreads,
      '-crf', this.crf.toString(),
      '-maxrate', this.maxrate,
      '-bufsize', '4000k',
      '-pix_fmt', 'yuv420p',
      '-g', (this.framerate * 2).toString(),
      '-r', fps,
      '-fps_mode', 'cfr',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
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
    // Best-effort kill of children so they don't linger as orphans
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
