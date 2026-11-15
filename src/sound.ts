// All sound is synthesised: filtered noise for the surf and the wash, sine
// pings for drips and plips. Nothing loads until the visitor turns it on.

interface Mix {
  tide: number;
  surge: number;
  stir: number;
}

export class Sound {
  enabled = false;
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private surfGain!: GainNode;
  private surfFilter!: BiquadFilterNode;
  private hissGain!: GainNode;
  private stirGain!: GainNode;
  private echo!: DelayNode;
  private noise!: AudioBuffer;
  private time = 0;
  private nextDrip = 3;
  private stir = 0;

  async toggle(): Promise<boolean> {
    if (!this.ctx) this.build();
    const ctx = this.ctx!;
    this.enabled = !this.enabled;
    if (this.enabled && ctx.state !== 'running') await ctx.resume();
    const now = ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(this.enabled ? 0.9 : 0, now, this.enabled ? 0.6 : 0.15);
    return this.enabled;
  }

  private build() {
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    this.master.connect(comp).connect(ctx.destination);

    // Brown noise, a few seconds long, looped.
    const length = ctx.sampleRate * 4;
    this.noise = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = last * 3.5;
    }

    const surf = this.loop();
    this.surfFilter = ctx.createBiquadFilter();
    this.surfFilter.type = 'lowpass';
    this.surfFilter.frequency.value = 500;
    this.surfGain = ctx.createGain();
    this.surfGain.gain.value = 0.3;
    surf.connect(this.surfFilter).connect(this.surfGain).connect(this.master);

    const hiss = this.loop(1.3);
    const hissFilter = ctx.createBiquadFilter();
    hissFilter.type = 'bandpass';
    hissFilter.frequency.value = 1600;
    hissFilter.Q.value = 0.5;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0;
    hiss.connect(hissFilter).connect(this.hissGain).connect(this.master);

    const stir = this.loop(0.7);
    const stirFilter = ctx.createBiquadFilter();
    stirFilter.type = 'bandpass';
    stirFilter.frequency.value = 750;
    stirFilter.Q.value = 1.3;
    this.stirGain = ctx.createGain();
    this.stirGain.gain.value = 0;
    stir.connect(stirFilter).connect(this.stirGain).connect(this.master);

    // A short echo makes drips sound like they fall in a hollow.
    this.echo = ctx.createDelay(1);
    this.echo.delayTime.value = 0.16;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.32;
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    this.echo.connect(feedback).connect(this.echo);
    this.echo.connect(wet).connect(this.master);
  }

  private loop(rate = 1) {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = rate;
    src.start(0, Math.random() * 3);
    return src;
  }

  update(dt: number, mix: Mix) {
    this.time += dt;
    if (!this.ctx || !this.enabled) return;
    const now = this.ctx.currentTime;
    const swell = 0.5 + 0.5 * Math.sin(this.time * 0.9) * Math.sin(this.time * 0.37 + 1);
    const surf = (0.18 + 0.22 * mix.tide) * (0.6 + 0.4 * swell) + mix.surge * 0.25;
    this.surfGain.gain.setTargetAtTime(surf, now, 0.3);
    this.surfFilter.frequency.setTargetAtTime(380 + 500 * swell + 900 * mix.surge, now, 0.3);
    this.stir += (mix.stir - this.stir) * Math.min(1, dt * 6);
    this.stirGain.gain.setTargetAtTime(Math.min(this.stir, 1.2) * 0.5, now, 0.08);

    this.nextDrip -= dt;
    if (this.nextDrip <= 0) {
      this.nextDrip = 2.5 + Math.random() * 6;
      this.ping(900 + Math.random() * 900, 0.05 + Math.random() * 0.05, true);
    }
  }

  private ping(freq: number, level: number, echo: boolean) {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.45, now + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(level, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
    osc.connect(g).connect(this.master);
    if (echo) g.connect(this.echo);
    osc.start(now);
    osc.stop(now + 0.2);
  }

  plip(strength: number) {
    if (!this.ctx || !this.enabled) return;
    this.ping(700 + Math.random() * 400, 0.18 * strength, false);
  }

  wash(size: number) {
    if (!this.ctx || !this.enabled) return;
    const now = this.ctx.currentTime;
    const g = this.hissGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0.25 * Math.min(size, 1.4), now + 0.5);
    g.setTargetAtTime(0, now + 0.6, 1.1);
  }
}
