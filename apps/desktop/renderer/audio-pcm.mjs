export class PcmResampler {
  constructor(sourceRate, targetRate = 16000, frameSamples = 1600) {
    if (!Number.isFinite(sourceRate) || sourceRate < targetRate || sourceRate > 384000) throw new Error('不支持的音频采样率');
    this.ratio = sourceRate / targetRate;
    this.targetRate = targetRate;
    this.frameSamples = frameSamples;
    this.weight = 0;
    this.sum = 0;
    this.frame = new Int16Array(frameSamples);
    this.at = 0;
    this.samples = 0;
  }
  push(input) {
    const frames = [];
    for (let i = 0; i < input.length; i++) {
      const sample = Number.isFinite(input[i]) ? Math.max(-1, Math.min(1, input[i])) : 0;
      let remaining = 1;
      while (remaining > 1e-8) {
        const take = Math.min(remaining, this.ratio - this.weight);
        this.sum += sample * take;
        this.weight += take;
        remaining -= take;
        if (this.weight >= this.ratio - 1e-8) {
          const normalized = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.frame[this.at++] = Math.round(normalized * (normalized < 0 ? 32768 : 32767));
          this.samples++;
          this.weight = 0;
          this.sum = 0;
          if (this.at === this.frameSamples) { frames.push(this.frame); this.frame = new Int16Array(this.frameSamples); this.at = 0; }
        }
      }
    }
    return frames;
  }
  flush() {
    if (!this.at) return null;
    const result = this.frame.slice(0, this.at);
    this.frame = new Int16Array(this.frameSamples);
    this.at = 0;
    return result;
  }
}
