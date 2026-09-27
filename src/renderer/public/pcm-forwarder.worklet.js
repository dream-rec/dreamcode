/* eslint-disable @typescript-eslint/explicit-function-return-type */
/**
 * AudioWorklet that re-chunks the 128-sample render quantum into fixed-size frames
 * (default 20 ms) and posts each frame to the main thread as a Float32Array.
 * Served as a static asset so it loads under the strict `script-src 'self'` CSP.
 */
class PcmForwarder extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const frameSamples =
      (options && options.processorOptions && options.processorOptions.frameSamples) || 320
    this.frame = new Float32Array(frameSamples)
    this.filled = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i += 1) {
      this.frame[this.filled++] = channel[i]
      if (this.filled === this.frame.length) {
        this.port.postMessage(this.frame.slice())
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-forwarder', PcmForwarder)
