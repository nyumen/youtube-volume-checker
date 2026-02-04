// vc-meter-processor.js
class VCMeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._peak = 0;
    this._sumSq = 0;
    this._n = 0;
    this._frames = 0;
    this._emitEvery = Math.max(128, Math.floor(sampleRate * 0.1)); // 100msごとに送信
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || input.length === 0 || !input[0]) {
      // 入力がない場合は無音を出力
      for (let ch = 0; ch < output.length; ch++) output[ch].fill(0);
      return true;
    }

    // pass-through（入力→出力）
    for (let ch = 0; ch < output.length; ch++) {
      const src = input[ch] || input[0]; // monoならch0を複製
      output[ch].set(src);
    }

    // 解析はch0で行う
    const in0 = input[0];
    let peak = this._peak;
    let sumSq = this._sumSq;

    for (let i = 0; i < in0.length; i++) {
      const v = in0[i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sumSq += v * v;
    }

    this._peak = peak;
    this._sumSq = sumSq;
    this._n += in0.length;
    this._frames += in0.length;

    if (this._frames >= this._emitEvery) {
      this.port.postMessage({
        peak: this._peak,
        sumSq: this._sumSq,
        n: this._n,
        durSec: this._frames / sampleRate
      });
      this._peak = 0;
      this._sumSq = 0;
      this._n = 0;
      this._frames = 0;
    }

    return true;
  }
}

registerProcessor("vc-meter", VCMeterProcessor);
