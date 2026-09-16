const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const http = require('http');

class PageCaster {
  constructor() {
    this.validateEnvironment();
    // Auto-set AUDIO_SOURCE to icecast if ICE_URL is provided and AUDIO_SOURCE isn't explicitly set
    this.audioSource = process.env.AUDIO_SOURCE || (process.env.ICE_URL ? 'icecast' : 'silent');
    this.webUrl = process.env.WEB_URL;
    this.rtmpUrl = process.env.RTMP_URL;
    this.iceUrl = process.env.ICE_URL;
    this.screenWidth = parseInt(process.env.SCREEN_WIDTH) || 854;
    this.screenHeight = parseInt(process.env.SCREEN_HEIGHT) || 480;
    this.ffmpegPreset = process.env.FFMPEG_PRESET || 'medium';
    this.ffmpegTune = process.env.FFMPEG_TUNE || '';
    this.framerate = parseInt(process.env.FRAMERATE) || 30;
    this.crf = parseInt(process.env.CRF) || 23;
    this.maxrate = process.env.MAXRATE || '2000k';
    
    this.browser = null;
    this.page = null;
    this.ffmpegProcess = null;
    this.shuttingDown = false;
    this.restartAttempts = 0;
    this.ffmpegStartTime = 0;
    this.ffmpegRunning = false;
    this.healthServer = null;
  }

  validateEnvironment() {
    const required = ['WEB_URL', 'RTMP_URL'];
    const missing = required.filter(env => !process.env[env]);
    
    if (missing.length > 0) {
      console.error(`Missing required environment variables: ${missing.join(', ')}`);
      process.exit(1);
    }
  }

  async setupBrowser() {
    console.log('Starting Puppeteer browser...');
    
    try {
      this.browser = await puppeteer.launch({
        headless: false,  // Use non-headless for X11 display
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
          '--disable-features=VizDisplayCompositor',
          '--enable-features=PulseAudio',
          '--kiosk'
        ],
        defaultViewport: null
      });
      console.log('Browser launched successfully');

      this.page = await this.browser.newPage();
      console.log('New page created');

      // Watchdog: if the page crashes or the browser disconnects, exit so the
      // container restart policy can bring us back up cleanly.
      this.page.on('error', (error) => {
        console.error('Page crashed:', error);
        this.fatalError('Page crashed');
      });
      this.browser.on('disconnected', () => {
        console.error('Browser disconnected unexpectedly');
        this.fatalError('Browser disconnected');
      });
      
      await this.page.setViewport({
        width: this.screenWidth,
        height: this.screenHeight
      });
      console.log('Viewport set');

      console.log(`Navigating to: ${this.webUrl}`);
      await this.page.goto(this.webUrl, { 
        waitUntil: 'domcontentloaded',
        timeout: 60000 
      });
      console.log('Page loaded successfully');

      await new Promise(resolve => setTimeout(resolve, 2000));
      console.log('Browser setup complete');
    } catch (error) {
      console.error('Browser setup failed:', error);
      throw error;
    }
  }

  async setupAudioCapture() {
    console.log(`Setting up audio capture (source: ${this.audioSource})`);
    
    switch (this.audioSource.toLowerCase()) {
      case 'browser':
        return await this.setupWebpageAudio();
      case 'icecast':
        return this.setupIcecastAudio();
      case 'silent':
        return this.setupSilentAudio();
      default:
        console.warn(`Unknown audio source: ${this.audioSource}, falling back to silence`);
        return this.setupSilentAudio();
    }
  }

  async setupWebpageAudio() {
    try {
      console.log('Setting up webpage audio capture via PulseAudio...');
      
      // Wait for page to be fully loaded
      await this.page.waitForFunction(() => document.readyState === 'complete', {timeout: 10000});
      
      // Check what audio elements exist and try to activate them
      const audioInfo = await this.page.evaluate(() => {
        // Resume audio context if it exists
        let audioContextState = 'none';
        if (typeof window.AudioContext !== 'undefined' || typeof window.webkitAudioContext !== 'undefined') {
          const AudioContextClass = window.AudioContext || window.webkitAudioContext;
          const audioContext = new AudioContextClass();
          audioContextState = audioContext.state;
          audioContext.resume();
        }
        
        // Try to play any audio/video elements
        const audioElements = document.querySelectorAll('audio, video');
        const elementInfo = Array.from(audioElements).map(el => ({
          tagName: el.tagName,
          src: el.src || el.currentSrc,
          paused: el.paused,
          muted: el.muted,
          autoplay: el.autoplay
        }));
        
        audioElements.forEach(el => {
          if (el.play) {
            el.play().catch(() => {});
          }
        });
        
        return {
          audioContextState,
          elementCount: audioElements.length,
          elements: elementInfo
        };
      });

      console.log('Audio info on page:', JSON.stringify(audioInfo, null, 2));

      // For webpage audio, always try to capture system audio 
      // (some sites use Web Audio API without HTML audio elements)
      if (audioInfo.audioContextState === 'running' || audioInfo.elementCount > 0) {
        console.log(`Will capture browser audio via PulseAudio (AudioContext: ${audioInfo.audioContextState}, Elements: ${audioInfo.elementCount})`);
        return {
          type: 'stream'
        };
      } else {
        console.log('No audio context or elements found, falling back to silent audio');
        return this.setupSilentAudio();
      }
      
    } catch (error) {
      console.error('Failed to setup webpage audio:', error.message);
      console.log('Falling back to silent audio...');
      return this.setupSilentAudio();
    }
  }

  setupIcecastAudio() {
    if (this.iceUrl) {
      console.log(`Using Icecast audio from: ${this.iceUrl}`);
      return {
        type: 'url',
        source: this.iceUrl
      };
    } else {
      console.log('No ICE_URL provided, falling back to silent audio');
      return this.setupSilentAudio();
    }
  }

  setupSilentAudio() {
    console.log('Using silent audio track');
    return {
      type: 'silent'
    };
  }

  async startScreencast() {
    console.log('Starting screen capture...');
    
    const audioConfig = await this.setupAudioCapture();
    const ffmpegArgs = this.buildFFmpegArgs(audioConfig);
    
    console.log('Starting FFmpeg with args:', ffmpegArgs.join(' '));
    
    this.startFFmpeg(ffmpegArgs);
  }

  startFFmpeg(ffmpegArgs) {
    this.ffmpegStartTime = Date.now();
    this.ffmpegRunning = true;
    this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.ffmpegProcess.stdout.on('data', (data) => {
      console.log(`FFmpeg stdout: ${data}`);
    });

    this.ffmpegProcess.stderr.on('data', (data) => {
      console.log(`FFmpeg stderr: ${data}`);
    });

    this.ffmpegProcess.on('close', (code) => {
      console.log(`FFmpeg process exited with code ${code}`);
      this.handleFFmpegExit(code);
    });

    this.ffmpegProcess.on('error', (error) => {
      console.error('FFmpeg process error:', error);
      this.handleFFmpegExit(-1);
    });

    // FFmpeg handles X11 capture directly - no screenshot loop needed
    console.log('FFmpeg started - X11 screen capture in progress...');
  }

  handleFFmpegExit(code) {
    this.ffmpegRunning = false;
    if (this.shuttingDown) {
      console.log('Shutting down, not restarting FFmpeg.');
      return;
    }

    // Reset backoff if the stream ran stably for a while
    const runDuration = Date.now() - this.ffmpegStartTime;
    if (runDuration > 60000) {
      this.restartAttempts = 0;
    }

    this.restartAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.restartAttempts - 1), 30000);
    console.log(`FFmpeg exited (code ${code}) after ${Math.round(runDuration / 1000)}s. Restarting in ${delay}ms (attempt ${this.restartAttempts})...`);

    setTimeout(async () => {
      if (this.shuttingDown) return;
      try {
        await this.startScreencast();
      } catch (error) {
        console.error('Failed to restart FFmpeg:', error);
        this.handleFFmpegExit(-1);
      }
    }, delay);
  }

  buildFFmpegArgs(audioConfig) {
    // Use X11 capture for better performance
    const baseArgs = [
      '-y',
      '-nostats',
      '-loglevel', 'warning',
      '-f', 'x11grab',
      '-framerate', this.framerate.toString(),  // Input framerate
      '-s', `${this.screenWidth}x${this.screenHeight}`,
      '-draw_mouse', '0',
      '-i', ':99.0'
    ];

    const audioArgs = [];
    switch (audioConfig.type) {
      case 'url':
        audioArgs.push('-thread_queue_size', '512', '-i', audioConfig.source);
        break;
      case 'stream':
        // Use PulseAudio to capture from our virtual audio device
        audioArgs.push('-thread_queue_size', '512', '-f', 'pulse', '-i', 'virtual-audio.monitor');
        break;
      case 'silent':
        audioArgs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
        break;
    }

    const outputArgs = [
      '-c:v', 'libx264',
      '-preset', this.ffmpegPreset,
      '-crf', this.crf.toString(),  // Quality (lower = better, 23 default)
      '-maxrate', this.maxrate,
      '-bufsize', '6000k',
      '-pix_fmt', 'yuv420p',
      '-g', (this.framerate * 2).toString(),  // Keyframe every 2 seconds
      '-r', this.framerate.toString(),  // Output framerate
      '-vsync', 'cfr',  // Constant frame rate
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ac', '2',
      '-flush_packets', '1',
      '-rtmp_live', 'live',
      '-rw_timeout', '10000000',
      '-f', 'flv',
      this.rtmpUrl
    ];

    // Tune is optional; 'zerolatency' trades quality for latency. For a
    // web-page stream, latency is rarely critical, so default to no tune.
    if (this.ffmpegTune) {
      outputArgs.splice(outputArgs.indexOf('-preset') + 2, 0, '-tune', this.ffmpegTune);
    }

    return [...baseArgs, ...audioArgs, ...outputArgs];
  }

  async cleanup() {
    console.log('Cleaning up resources...');
    this.shuttingDown = true;
    
    if (this.healthServer) {
      this.healthServer.close();
    }
    
    if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
      this.ffmpegProcess.kill('SIGTERM');
    }
    
    if (this.page) {
      await this.page.close();
    }
    
    if (this.browser) {
      await this.browser.close();
    }
  }

  fatalError(reason) {
    console.error(`Fatal error: ${reason}. Exiting to allow restart policy to recover.`);
    this.shuttingDown = true;
    process.exit(1);
  }

  startHealthServer() {
    const port = parseInt(process.env.HEALTH_PORT) || 8080;
    this.healthServer = http.createServer((req, res) => {
      if (req.url === '/healthz' || req.url === '/health') {
        const healthy = this.ffmpegRunning && this.browser && this.browser.isConnected();
        res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: healthy ? 'ok' : 'degraded',
          ffmpegRunning: this.ffmpegRunning,
          browserConnected: !!(this.browser && this.browser.isConnected()),
          uptimeSeconds: Math.round(process.uptime())
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    this.healthServer.listen(port, () => {
      console.log(`Health check server listening on port ${port}`);
    });
  }

  async start() {
    try {
      console.log('Starting PageCaster...');
      console.log(`Audio source: ${this.audioSource}`);
      console.log(`Web URL: ${this.webUrl}`);
      console.log(`RTMP URL: ${this.rtmpUrl}`);
      console.log(`Screen size: ${this.screenWidth}x${this.screenHeight}`);
      console.log(`Framerate: ${this.framerate}fps`);
      
      this.startHealthServer();
      await this.setupBrowser();
      await this.startScreencast();
      
    } catch (error) {
      console.error('Error starting PageCaster:', error);
      await this.cleanup();
      process.exit(1);
    }
  }
}

process.on('SIGINT', async () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  if (global.pageCaster) {
    await global.pageCaster.cleanup();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  if (global.pageCaster) {
    await global.pageCaster.cleanup();
  }
  process.exit(0);
});

const pageCaster = new PageCaster();
global.pageCaster = pageCaster;
pageCaster.start();
