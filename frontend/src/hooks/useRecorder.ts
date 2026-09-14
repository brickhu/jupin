import { createSignal } from 'solid-js'

export interface RecorderState {
  status: 'idle' | 'requesting' | 'recording' | 'stopped' | 'error'
  audioBlob: Blob | null
  duration: number
  error: string | null
}

// WAV 编码：将 Float32 PCM 样本转为 16-bit WAV Blob
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = samples.length * (bitsPerSample / 8)
  const bufferSize = 44 + dataSize

  const buffer = new ArrayBuffer(bufferSize)
  const view = new DataView(buffer)

  // RIFF header
  writeString(view, 0, 'RIFF')
  view.setUint32(4, bufferSize - 8, true) // file size
  writeString(view, 8, 'WAVE')

  // fmt chunk
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // chunk size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)

  // data chunk
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  // 写入 PCM 样本（Float32 → Int16）
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    const val = s < 0 ? s * 0x8000 : s * 0x7fff
    view.setInt16(offset, val, true)
    offset += 2
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}

export function useRecorder(maxDuration = 30) {
  const [state, setState] = createSignal<RecorderState>({
    status: 'idle',
    audioBlob: null,
    duration: 0,
    error: null,
  })

  let audioContext: AudioContext | null = null
  let stream: MediaStream | null = null
  let scriptNode: ScriptProcessorNode | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let pcmBuffer: Float32Array[] = []
  let timer: ReturnType<typeof setInterval> | null = null
  let startTime = 0

  const startRecording = async () => {
    setState({ status: 'requesting', audioBlob: null, duration: 0, error: null })

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: { ideal: 16000 },
          channelCount: { ideal: 1 },
          echoCancellation: true,
          noiseSuppression: true,
        },
      })

      // 创建 AudioContext（16kHz）
      audioContext = new AudioContext({ sampleRate: 16000 })
      source = audioContext.createMediaStreamSource(stream)

      // ScriptProcessorNode：以 4096 帧/块接收 PCM 数据
      scriptNode = audioContext.createScriptProcessor(4096, 1, 1)
      pcmBuffer = []

      scriptNode.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0)
        pcmBuffer.push(new Float32Array(input))
      }

      source.connect(scriptNode)
      scriptNode.connect(audioContext.destination)

      startTime = Date.now()
      setState({ status: 'recording', audioBlob: null, duration: 0, error: null })

      timer = setInterval(() => {
        const elapsed = (Date.now() - startTime) / 1000
        setState((prev) => ({ ...prev, duration: Math.round(elapsed) }))
        if (elapsed >= maxDuration) {
          stopRecording()
        }
      }, 100)
    } catch (err: any) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setState({
          status: 'error',
          audioBlob: null,
          duration: 0,
          error: '请允许使用麦克风以进行录音',
        })
      } else {
        setState({
          status: 'error',
          audioBlob: null,
          duration: 0,
          error: '麦克风不可用，请检查设备',
        })
      }
      cleanup()
    }
  }

  const stopRecording = () => {
    if (audioContext && audioContext.state !== 'closed') {
      // 等一帧确保最后数据被捕获
      setTimeout(() => {
        // 合并所有 PCM 块
        const totalLen = pcmBuffer.reduce((sum, buf) => sum + buf.length, 0)
        const allSamples = new Float32Array(totalLen)
        let offset = 0
        for (const buf of pcmBuffer) {
          allSamples.set(buf, offset)
          offset += buf.length
        }

        // 编码为 WAV
        const sampleRate = audioContext?.sampleRate || 16000
        const wavBlob = encodeWav(allSamples, sampleRate)

        setState({
          status: 'stopped',
          audioBlob: wavBlob,
          duration: Math.round((Date.now() - startTime) / 1000),
          error: null,
        })

        cleanup()
      }, 100)
    }
  }

  const cleanup = () => {
    if (timer) { clearInterval(timer); timer = null }
    try { scriptNode?.disconnect() } catch {}
    try { source?.disconnect() } catch {}
    try { audioContext?.close() } catch {}
    stream?.getTracks().forEach((t) => t.stop())
    audioContext = null
    stream = null
    scriptNode = null
    source = null
    pcmBuffer = []
  }

  const reset = () => {
    setState({ status: 'idle', audioBlob: null, duration: 0, error: null })
    cleanup()
  }

  return { state, startRecording, stopRecording, reset }
}