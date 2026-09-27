/** Encode mono PCM16 samples as a WAV file (what every transcription endpoint accepts). */
export function encodeWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2
  const dataLength = samples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true)
  view.setUint16(32, bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataLength, true)

  new Int16Array(buffer, 44).set(samples)
  return new Uint8Array(buffer)
}

export function floatToPcm16(frames: Float32Array[]): Int16Array {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0)
  const out = new Int16Array(total)
  let offset = 0
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, frame[i]))
      out[offset + i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
    }
    offset += frame.length
  }
  return out
}
