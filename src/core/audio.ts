import { clamp } from './math';

type Ctx = AudioContext;

/**
 * Gunshots use recorded samples (assets/sfx, close and far variants) once
 * they are decoded; everything else is synthesised at runtime.
 */
export class GameAudio {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private ambientNodes: { osc: OscillatorNode; gain: GainNode }[] = [];
  muted = false;
  private rawSamples = new Map<string, ArrayBuffer>();
  private nearShots: AudioBuffer[] = [];
  private farShots: AudioBuffer[] = [];

  /** Must be called from a user gesture (browser autoplay policy). */
  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    this.master = master;

    const len = Math.floor(ctx.sampleRate * 0.5);
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;

    this.startAmbient();
    this.decodeSamples();
  }

  /** Raw (encoded) samples from the asset pack; decoded once audio is unlocked. */
  setSamples(samples: Map<string, ArrayBuffer>): void {
    this.rawSamples = samples;
    this.decodeSamples();
  }

  private decodeSamples(): void {
    const ctx = this.ctx;
    if (!ctx || this.rawSamples.size === 0) return;
    const raw = this.rawSamples;
    this.rawSamples = new Map();
    for (const [name, data] of raw) {
      // decodeAudioData detaches its input; keep the original intact.
      ctx.decodeAudioData(data.slice(0)).then(
        (buf) => (name.includes('_far_') ? this.farShots : this.nearShots).push(buf),
        () => undefined,
      );
    }
  }

  private sample(buffer: AudioBuffer, gain: number, rate: number, lowpass: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = lowpass;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(lp).connect(g).connect(master);
    src.start();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 0.5;
  }

  private get now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  private noise(duration: number, gain: number, filter: number, q = 1, type: BiquadFilterType = 'bandpass'): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || !this.noiseBuffer) return;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = type;
    bp.frequency.value = filter;
    bp.Q.value = q;
    const g = ctx.createGain();
    const t = this.now;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(bp).connect(g).connect(master);
    src.start(t);
    src.stop(t + duration + 0.02);
  }

  private tone(freq: number, endFreq: number, duration: number, gain: number, type: OscillatorType = 'sine'): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    const t = this.now;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  /** Gunshot: noise crack plus a low thump. `power` scales the body. */
  shot(power = 1, distance = 0): void {
    const att = clamp(1 - distance / 45, 0.08, 1);
    const pool = distance > 20 && this.farShots.length > 0 ? this.farShots : this.nearShots;
    if (pool.length > 0) {
      const buf = pool[Math.floor(Math.random() * pool.length)];
      // Lighter guns play the rifle recording higher and shorter.
      const rate = clamp(1.32 - power * 0.3, 0.8, 1.35) * (0.96 + Math.random() * 0.08);
      this.sample(buf, 0.7 * att * clamp(power, 0.6, 1.3), rate, 2500 + att * 15000);
      this.tone(120 * power, 40, 0.12 * power, 0.18 * power * att, 'triangle');
      return;
    }
    this.noise(0.09 * power, 0.55 * power * att, 1800 * power, 0.8, 'highpass');
    this.noise(0.16 * power, 0.4 * power * att, 320, 1.4);
    this.tone(150 * power, 45, 0.12 * power, 0.3 * power * att, 'triangle');
  }

  impact(): void {
    this.noise(0.05, 0.2, 2600, 1.2, 'highpass');
  }

  explosion(): void {
    this.noise(0.9, 0.75, 180, 0.6, 'lowpass');
    this.tone(90, 28, 0.8, 0.5, 'sine');
    this.tone(200, 50, 0.35, 0.25, 'square');
  }

  hurt(): void {
    this.noise(0.16, 0.3, 480, 1.1, 'lowpass');
    this.tone(220, 120, 0.16, 0.16, 'sawtooth');
  }

  death(): void {
    this.tone(320, 70, 0.5, 0.25, 'sawtooth');
    this.noise(0.35, 0.25, 700, 0.8, 'lowpass');
  }

  reload(): void {
    this.noise(0.05, 0.22, 1400, 2, 'highpass');
    window.setTimeout(() => this.noise(0.06, 0.18, 900, 2, 'highpass'), 180);
    window.setTimeout(() => this.noise(0.05, 0.26, 2000, 2.5, 'highpass'), 420);
  }

  pickup(): void {
    this.tone(520, 780, 0.1, 0.16, 'triangle');
    window.setTimeout(() => this.tone(780, 1180, 0.12, 0.13, 'triangle'), 80);
  }

  powerup(): void {
    this.tone(440, 880, 0.12, 0.14, 'sine');
    window.setTimeout(() => this.tone(660, 1320, 0.16, 0.12, 'sine'), 70);
    window.setTimeout(() => this.tone(990, 1760, 0.2, 0.1, 'triangle'), 150);
  }

  smokePop(dist: number): void {
    const v = Math.max(0.1, 1 - dist / 30);
    this.noise(1.4, 0.12 * v, 1800, 0.6, 'bandpass');
  }

  /** A flash grenade: a sharp bang, then a ringing tone up close. */
  flashBang(dist: number): void {
    const v = Math.max(0.15, 1 - dist / 40);
    this.noise(0.25, 0.5 * v, 2400, 0.8, 'bandpass');
    if (dist < 16) this.tone(3900, 3700, 2.2, 0.035 * (1 - dist / 16), 'sine');
  }

  /** Breaking glass, quieter with distance. */
  glass(dist: number): void {
    const v = Math.max(0.15, 1 - dist / 30);
    this.noise(0.18, 0.22 * v, 5200, 2.5, 'highpass');
    this.tone(2600, 1800, 0.12, 0.05 * v, 'triangle');
  }

  step(volume = 1): void {
    this.noise(0.045, 0.07 * volume, 900, 1.1, 'lowpass');
  }

  door(): void {
    this.noise(0.7, 0.28, 260, 0.7, 'lowpass');
    this.tone(120, 70, 0.6, 0.16, 'sawtooth');
  }

  private startAmbient(): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 240;
    filter.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.value = 0.07;
    filter.connect(gain).connect(master);

    for (const freq of [46, 55.5, 69]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.07 + Math.random() * 0.1;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 1.4;
      lfo.connect(lfoGain).connect(osc.frequency);
      osc.connect(filter);
      osc.start();
      lfo.start();
      this.ambientNodes.push({ osc, gain });
    }
  }
}
