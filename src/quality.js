'use strict'

const path = require('node:path')
const { spawn } = require('node:child_process')
const messages = require('./messages')
const {
  ENABLE_QUALITY_ANALYSIS,
  FFPROBE_PATH,
  QUALITY_ANALYSIS_DEBUG
} = require('./config')
const LOW_BITRATE_THRESHOLD = 256

/**
 * Analyze bitrate using the external Python CLI "whatsmybitrate".
 * Returns { bitrate_kbps, source_bitrate_kbps, warning, text } or null.
 */
async function analyzeTrackQuality(filePath, metadata) {
  if (!ENABLE_QUALITY_ANALYSIS) return null

  const measured = await measureBitrateKbps(filePath)
  if (!measured) return null

  const source = pickSourceBitrate(metadata)
  const trackLabel = describeTrack(metadata)

  let warning = null
  const hasDropIssue = source && measured + 5 < source
  const hasLowIssue = measured < LOW_BITRATE_THRESHOLD

  if (hasDropIssue) {
    warning = messages.bitrateDropWarning(trackLabel, measured, source)
  } else if (hasLowIssue) {
    warning = messages.lowBitrateWarning(trackLabel, measured, LOW_BITRATE_THRESHOLD)
  }

  const text = warning || null

  return {
    bitrate_kbps: measured,
    source_bitrate_kbps: source,
    warning,
    text
  }
}

function pickSourceBitrate(metadata) {
  if (!metadata || typeof metadata !== 'object') return null
  const candidates = [
    metadata.abr,
    metadata.tbr,
    metadata.bitrate,
    metadata.audio_bitrate,
    metadata.audio_bitrate_kbps,
    metadata.bit_rate,
    metadata.vbr
  ]
  for (const val of candidates) {
    const n = typeof val === 'string' ? Number(val) : val
    if (Number.isFinite(n) && n > 0) return Math.round(n)
  }
  return null
}

function describeTrack(metadata) {
  if (!metadata || typeof metadata !== 'object') return 'ce track'
  const title = metadata.title || metadata.fulltitle || metadata.track
  const artist = metadata.uploader || metadata.artist
  if (title && artist) return `${artist} – ${title}`
  if (title) return title
  return 'ce track'
}

async function measureBitrateKbps(filePath) {
  const wmbPath = path.join(__dirname, '..', 'bin', 'whatsmybitrate-json')
  // First try vendored whatsmybitrate wrapper
  const pythonRes = await trySpawnPython(wmbPath, filePath)
  if (pythonRes !== null) return pythonRes
  // Fallback to ffprobe average bitrate
  return await probeBitrateWithFfprobe(filePath)
}

async function trySpawnPython(scriptPath, filePath) {
  try {
    const { stdout } = await spawnCollect('python3', [scriptPath, filePath])
    const parsed = parseMaybeJson(stdout)
    const kbps =
      extractKbps(parsed?.estimated_bitrate_numeric) ||
      extractKbps(parsed?.estimated_bitrate) ||
      extractKbps(parsed?.bit_rate)
    return kbps || null
  } catch (error) {
    qualityDebug('whatsmybitrate-json failed:', error)
    return null
  }
}

async function probeBitrateWithFfprobe(filePath) {
  try {
    const { stdout } = await spawnCollect(FFPROBE_PATH, [
      '-v',
      'error',
      '-show_entries',
      'format=bit_rate',
      '-of',
      'default=nk=1:nw=1',
      filePath
    ])
    const val = Number(stdout.trim())
    if (Number.isFinite(val) && val > 0) {
      return Math.round(val / 1000)
    }
  } catch (error) {
    qualityDebug('ffprobe bitrate fallback failed:', error)
  }
  return null
}

function parseMaybeJson(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function extractKbps(value) {
  if (!value) return null
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value)
  }
  if (typeof value === 'string') {
    const match = value.match(/(\d+(?:\.\d+)?)\s*k(?:bit|b)ps/i)
    if (match) return Math.round(Number(match[1]))
    const num = Number(value)
    if (Number.isFinite(num)) return Math.round(num)
    return null
  }
  if (typeof value === 'object') {
    const fields = [
      'kbps',
      'bitrate',
      'bitRate',
      'audioBitrate',
      'audio_bitrate',
      'bit_rate',
      'averageBitrate',
      'avgBitrate',
      'bit_rate_numeric',
      'bit_rate_numeric_kbps'
    ]
    for (const key of fields) {
      const v = value[key]
      const n = typeof v === 'string' ? Number(v) : v
      if (Number.isFinite(n)) return Math.round(n)
    }
  }
  return null
}

function spawnCollect(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        const error = new Error(`${cmd} exited with ${code}`)
        error.stdout = stdout
        error.stderr = stderr
        return reject(error)
      }
      resolve({ stdout, stderr })
    })
  })
}

function qualityDebug(...args) {
  if (!QUALITY_ANALYSIS_DEBUG) return
  console.debug('[quality]', ...args)
}

module.exports = {
  analyzeTrackQuality,
  qualityDebug
}
