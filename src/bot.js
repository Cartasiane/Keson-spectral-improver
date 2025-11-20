'use strict'

require('dotenv').config()

const { Bot, InputFile } = require('grammy')
const { create: createYtDlp } = require('yt-dlp-exec')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const https = require('node:https')
const { pipeline } = require('node:stream/promises')
const http = require('node:http')
const { spawn } = require('node:child_process')
const messages = require('./messages')

const BOT_TOKEN = process.env.BOT_TOKEN
const SOUNDCLOUD_OAUTH_TOKEN =
  process.env.SOUNDCLOUD_OAUTH_TOKEN || process.env.SOUNDCLOUD_OAUTH
const ACCESS_PASSWORD = process.env.BOT_PASSWORD
const YT_DLP_BINARY_PATH = process.env.YT_DLP_BINARY_PATH
const BINARY_CACHE_DIR = path.join(__dirname, '..', 'bin')
const DATA_DIR = path.join(__dirname, '..', 'data')
const AUTH_STORE_PATH = path.join(DATA_DIR, 'authorized-users.json')
const DOWNLOAD_COUNT_PATH = path.join(DATA_DIR, 'download-count.json')
const YT_DLP_RELEASE_BASE =
  process.env.YT_DLP_DOWNLOAD_BASE ||
  'https://github.com/yt-dlp/yt-dlp/releases/latest/download/'
const MAX_CONCURRENT_DOWNLOADS = readPositiveInt(process.env.MAX_CONCURRENT_DOWNLOADS, 3)
const MAX_PENDING_DOWNLOADS = readPositiveInt(process.env.MAX_PENDING_DOWNLOADS, 25)
const TELEGRAM_MAX_FILE_BYTES = 50 * 1024 * 1024
const downloadQueue = createTaskQueue(MAX_CONCURRENT_DOWNLOADS, MAX_PENDING_DOWNLOADS)
const IDHS_API_BASE_URL = process.env.IDHS_API_BASE_URL || 'http://localhost:3000'
const IDHS_REQUEST_TIMEOUT_MS = Number(process.env.IDHS_REQUEST_TIMEOUT_MS || 15000)
const IDHS_SUPPORTED_HOSTS = [
  /spotify\.com/i,
  /music\.apple\.com/i,
  /deezer\.com/i,
  /tidal\.com/i,
  /youtube\.com/i,
  /youtu\.be/i
]
const ENABLE_QUALITY_ANALYSIS = process.env.ENABLE_QUALITY_ANALYSIS !== 'false'
const QUALITY_ANALYSIS_DEBUG = process.env.QUALITY_ANALYSIS_DEBUG === 'true'
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg'
const FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe'
const YT_DLP_SKIP_CERT_CHECK = process.env.YT_DLP_SKIP_CERT_CHECK === 'true'
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM']

const THUMB_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const INFO_SUFFIX = '.info.json'

let ytdlpInstancePromise

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is missing. Set it in your environment/.env file.')
  process.exit(1)
}

if (!SOUNDCLOUD_OAUTH_TOKEN) {
  console.error(
    'SOUNDCLOUD_OAUTH_TOKEN is missing. Provide the OAuth token from SoundCloud.'
  )
  process.exit(1)
}

if (!ACCESS_PASSWORD) {
  console.error('BOT_PASSWORD is missing. Set it to protect the bot access.')
  process.exit(1)
}

const bot = new Bot(BOT_TOKEN)
const authorizedUsers = new Set()
const awaitingPassword = new Set()
let persistAuthorizedUsersTimer
let persistDownloadCountTimer
let downloadCount = 0
let authorizedUsersDirty = false
let downloadCountDirty = false
let isShuttingDown = false
const SOUND_CLOUD_REGEX = /(https?:\/\/(?:[\w-]+\.)?soundcloud\.com\/[\w\-./?=&%+#]+)/i

setupSignalHandlers()

bot.api
  .setMyCommands([{ command: 'start', description: 'Show bot instructions' }])
  .catch(error => console.warn('Unable to set bot commands:', error))

bot.command('start', async ctx => {
  await ctx.reply(messages.startIntro())

  const userId = ctx.from?.id
  if (!userId) {
    await ctx.reply(messages.userIdMissing())
    return
  }

  if (authorizedUsers.has(userId)) {
    await ctx.reply(messages.alreadyAuthorized())
  } else {
    await promptForPassword(ctx, userId)
  }
})

bot.command('downloads', async ctx => {
  await ctx.reply(messages.downloadCount(downloadCount))
})

bot.on('message:text', async ctx => {
  if (isBotCommand(ctx)) {
    return
  }

  const userId = ctx.from?.id
  if (!userId) {
    await ctx.reply(messages.userIdMissing())
    return
  }

  if (!authorizedUsers.has(userId)) {
    await handlePasswordFlow(ctx, userId)
    return
  }

  const messageText = ctx.message.text || ''
  let url = extractSoundCloudUrl(messageText)

  if (!url) {
    const candidate = extractFirstUrl(messageText)
    if (candidate && isIdhsSupportedLink(candidate)) {
      await ctx.reply(messages.conversionInProgress())
      url = await resolveLinkViaIdhs(candidate)
      if (!url) {
        await ctx.reply(messages.conversionNotFound())
        return
      }
    }
  }

  if (!url) {
    await ctx.reply(messages.invalidSoundCloudLink())
    return
  }

  await ctx.reply(messages.downloadPrep())

  try {
    await downloadQueue.add(() => handleDownloadJob(ctx, url))
  } catch (error) {
    console.error('Download failed:', error)
    await ctx.reply(formatUserFacingError(error))
  }
})

bot.catch(err => {
  console.error('Bot error:', err)
})

initializeBot().catch(error => {
  console.error('Failed to start bot:', error)
  process.exit(1)
})

function extractSoundCloudUrl(text) {
  if (!text) return null
  const match = SOUND_CLOUD_REGEX.exec(text)
  if (!match) return null
  return match[1].replace(/[\]\)>,\s]+$/, '')
}

function extractFirstUrl(text) {
  if (!text) return null
  const match = text.match(/https?:\/\/[^\s]+/i)
  if (!match) return null
  return match[0].replace(/[\]\)>,\s]+$/, '')
}


function isIdhsSupportedLink(rawUrl) {
  try {
    const { hostname } = new URL(rawUrl)
    return IDHS_SUPPORTED_HOSTS.some(pattern => pattern.test(hostname))
  } catch {
    return false
  }
}

async function resolveLinkViaIdhs(originalLink) {
  if (!IDHS_API_BASE_URL) return null
  let endpoint
  try {
    endpoint = new URL('/api/search?v=1', IDHS_API_BASE_URL)
  } catch (error) {
    console.error('Invalid IDHS base URL:', error)
    return null
  }

  const body = JSON.stringify({ link: originalLink, adapters: ['soundCloud'] })

  try {
    const response = await httpJsonRequest(endpoint, body, IDHS_REQUEST_TIMEOUT_MS)
    if (response.status < 200 || response.status >= 300) {
      console.warn(`IDHS request failed with status ${response.status}: ${response.body}`)
      return null
    }

    let parsed
    try {
      parsed = JSON.parse(response.body)
    } catch (error) {
      console.warn('Unable to parse IDHS response as JSON:', error)
      return null
    }

    if (parsed?.error) {
      console.warn('IDHS responded with an error:', parsed.error)
      return null
    }

    const soundCloudLink = pickSoundCloudLink(parsed)
    return soundCloudLink
  } catch (error) {
    console.error('Failed to resolve link via IDHS:', error)
    return null
  }
}

function pickSoundCloudLink(result) {
  const fromLinks = Array.isArray(result?.links) ? result.links : null
  if (fromLinks) {
    const entry = fromLinks.find(link => isUsableSoundCloudEntry(link))
    if (entry?.url) {
      return entry.url
    }
  }

  if (Array.isArray(result)) {
    const entry = result.find(item => typeof item === 'string' && SOUND_CLOUD_REGEX.test(item))
    if (entry) return extractSoundCloudUrl(entry)
  }

  if (typeof result?.source === 'string' && SOUND_CLOUD_REGEX.test(result.source)) {
    return extractSoundCloudUrl(result.source)
  }

  return null
}

function isUsableSoundCloudEntry(entry) {
  if (!entry || typeof entry !== 'object') return false
  if (entry.notAvailable) return false
  if (typeof entry.url !== 'string') return false
  const type = typeof entry.type === 'string' ? entry.type.toLowerCase() : ''
  return type === 'soundcloud'
}

function httpJsonRequest(targetUrl, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const isHttps = targetUrl.protocol === 'https:'
    const transport = isHttps ? https : http
    const options = {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'application/json'
      }
    }

    const req = transport.request(options, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8')
        })
      })
    })

    req.on('error', reject)

    if (timeoutMs) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('IDHS request timed out'))
      })
    }

    req.write(body)
    req.end()
  })
}

class TooShortError extends Error {
  constructor(message = 'Audio is too short for analysis') {
    super(message)
    this.name = 'TooShortError'
  }
}

class SilentTrackError extends Error {
  constructor(message = 'Audio appears to be silent') {
    super(message)
    this.name = 'SilentTrackError'
  }
}

async function analyzeTrackQuality(filePath) {
  if (!FFMPEG_PATH || !FFPROBE_PATH) return null
  const audio = await decodeAudioData(filePath)
  if (!audio) {
    qualityDebug('Failed to decode PCM data; skipping analysis.')
    return null
  }

  const maxFreq = detectMaxFrequency(audio.monoData, audio.sampleRate)
  const { verdictKey, verdictLabel } = classifyVerdict(audio.sampleRate, maxFreq)

  let drStatus = 'ok'
  let dynamicRange = null
  let avgPeakDb = null
  let avgRmsDb = null
  try {
    const dr = computeDynamicRange(audio.channelData, audio.sampleRate)
    dynamicRange = dr.dynamicRange
    avgPeakDb = dr.avgPeakDb
    avgRmsDb = dr.avgRmsDb
  } catch (error) {
    if (error instanceof TooShortError) {
      drStatus = 'too_short'
    } else if (error instanceof SilentTrackError) {
      drStatus = 'silent_track'
    } else {
      throw error
    }
  }

  const lufs = await measureIntegratedLoudness(filePath)

  const details = {
    file: path.basename(filePath),
    sample_rate: audio.sampleRate,
    nyquist_freq: audio.sampleRate / 2,
    max_significant_freq: maxFreq,
    verdict_key: verdictKey,
    verdict_label: verdictLabel,
    dr_status: drStatus,
    dynamic_range: dynamicRange,
    avg_peak_db: avgPeakDb,
    avg_rms_db: avgRmsDb,
    lufs
  }

  qualityDebug('Analyzed quality metrics:', details)
  return buildQualityInfo(details)
}

async function decodeAudioData(filePath) {
  const meta = await probeAudioStream(filePath)
  if (!meta) return null
  const sampleRate = Number(meta.sample_rate)
  const channels = Math.max(1, Number(meta.channels) || 1)
  if (!sampleRate || !Number.isFinite(sampleRate)) {
    qualityDebug('Unable to read sample rate from ffprobe output:', meta)
    return null
  }

  const pcm = await decodeToFloat32(filePath, channels, sampleRate)
  if (!pcm) return null

  const samplesPerChannel = Math.floor(pcm.length / channels)
  if (!Number.isFinite(samplesPerChannel) || samplesPerChannel <= 0) {
    qualityDebug('PCM decode returned no samples')
    return null
  }

  const channelData = Array.from({ length: channels }, () => new Float64Array(samplesPerChannel))
  for (let i = 0; i < samplesPerChannel; i++) {
    for (let ch = 0; ch < channels; ch++) {
      channelData[ch][i] = pcm[i * channels + ch]
    }
  }

  const monoData = new Float64Array(samplesPerChannel)
  for (let i = 0; i < samplesPerChannel; i++) {
    let sum = 0
    for (let ch = 0; ch < channels; ch++) {
      sum += channelData[ch][i]
    }
    monoData[i] = sum / channels
  }

  return { sampleRate, channels, channelData, monoData }
}

function probeAudioStream(filePath) {
  return new Promise(resolve => {
    const args = [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=sample_rate,channels',
      '-of',
      'json',
      filePath
    ]

    const child = spawn(FFPROBE_PATH, args)
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })

    child.on('error', error => {
      console.warn('Unable to start ffprobe:', error)
      qualityDebug('ffprobe spawn error:', error)
      resolve(null)
    })

    child.on('close', code => {
      if (code !== 0) {
        console.warn(`ffprobe exited with code ${code}`)
        qualityDebug('ffprobe stderr:', stderr)
        resolve(null)
        return
      }

      try {
        const parsed = JSON.parse(stdout)
        if (parsed?.streams?.length) {
          resolve(parsed.streams[0])
          return
        }
      } catch (error) {
        console.warn('Unable to parse ffprobe output as JSON:', error)
        qualityDebug('ffprobe output:', stdout)
      }
      resolve(null)
    })
  })
}

function decodeToFloat32(filePath, channels, sampleRate) {
  return new Promise(resolve => {
    const args = [
      '-hide_banner',
      '-nostats',
      '-i',
      filePath,
      '-vn',
      '-acodec',
      'pcm_f32le',
      '-f',
      'f32le',
      '-ac',
      String(channels),
      '-ar',
      String(sampleRate),
      'pipe:1'
    ]

    const child = spawn(FFMPEG_PATH, args)
    const chunks = []
    let stderr = ''

    child.stdout.on('data', chunk => {
      chunks.push(chunk)
    })

    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })

    child.on('error', error => {
      console.warn('Unable to start ffmpeg PCM decode:', error)
      qualityDebug('ffmpeg decode error:', error)
      resolve(null)
    })

    child.on('close', code => {
      if (code !== 0) {
        console.warn(`ffmpeg PCM decode failed (code ${code})`)
        qualityDebug('ffmpeg decode stderr:', stderr.slice(-2000))
        resolve(null)
        return
      }
      const buffer = Buffer.concat(chunks)
      if (!buffer.length) {
        qualityDebug('ffmpeg produced empty PCM stream')
        resolve(null)
        return
      }
      const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      const floatArray = new Float32Array(arrayBuffer)
      resolve(floatArray)
    })
  })
}

function detectMaxFrequency(samples, sampleRate) {
  const windowSize = 2048
  const hopLength = 512
  if (!samples || samples.length < windowSize) return null
  const numFrames = Math.floor((samples.length - windowSize) / hopLength) + 1
  if (numFrames <= 0) return null
  const freqBins = windowSize / 2 + 1
  const magnitudes = Array.from({ length: freqBins }, () => new Float64Array(numFrames))
  const window = getHannWindow(windowSize)
  const { cosTable, sinTable } = getFftTables(windowSize)
  const real = new Float64Array(windowSize)
  const imag = new Float64Array(windowSize)
  let maxAmp = 0

  for (let frame = 0; frame < numFrames; frame++) {
    const offset = frame * hopLength
    for (let i = 0; i < windowSize; i++) {
      real[i] = samples[offset + i] * window[i]
      imag[i] = 0
    }
    fftRadix2(real, imag, cosTable, sinTable)
    for (let bin = 0; bin < freqBins; bin++) {
      const mag = Math.hypot(real[bin], imag[bin])
      magnitudes[bin][frame] = mag
      if (mag > maxAmp) maxAmp = mag
    }
  }

  if (maxAmp <= 0) return null

  const dbMatrix = magnitudes.map(column => {
    const arr = new Float64Array(numFrames)
    for (let i = 0; i < numFrames; i++) {
      const ratio = Math.max(1e-12, column[i] / maxAmp)
      arr[i] = 20 * Math.log10(ratio)
    }
    return arr
  })

  const smoothed = smoothSpectrogram(dbMatrix)
  const meanDb = computeMean(smoothed)
  const stdDb = computeStd(smoothed, meanDb)
  const baseThreshold = meanDb + 1.5 * stdDb
  const hfThreshold = 18
  const nyquist = sampleRate / 2
  let maxSignificant = null

  for (let bin = 0; bin < freqBins; bin++) {
    const freq = (bin * sampleRate) / windowSize
    const threshold = baseThreshold - hfThreshold * (freq / nyquist)
    const column = smoothed[bin]
    for (let frame = 0; frame < numFrames; frame++) {
      if (column[frame] > threshold) {
        maxSignificant = freq
      }
    }
  }

  return maxSignificant ? Math.ceil(maxSignificant) : null
}

function getHannWindow(size) {
  const window = new Float64Array(size)
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1))
  }
  return window
}

const FFT_TABLE_CACHE = new Map()

function getFftTables(size) {
  if (!FFT_TABLE_CACHE.has(size)) {
    const cosTable = new Float64Array(size / 2)
    const sinTable = new Float64Array(size / 2)
    for (let i = 0; i < size / 2; i++) {
      cosTable[i] = Math.cos((-2 * Math.PI * i) / size)
      sinTable[i] = Math.sin((-2 * Math.PI * i) / size)
    }
    FFT_TABLE_CACHE.set(size, { cosTable, sinTable })
  }
  return FFT_TABLE_CACHE.get(size)
}

function fftRadix2(real, imag, cosTable, sinTable) {
  const n = real.length
  if ((n & (n - 1)) !== 0) {
    throw new Error('FFT size must be power of two')
  }

  let j = 0
  for (let i = 1; i < n; i++) {
    let bit = n >> 1
    while (j & bit) {
      j &= ~bit
      bit >>= 1
    }
    j |= bit
    if (i < j) {
      ;[real[i], real[j]] = [real[j], real[i]]
      ;[imag[i], imag[j]] = [imag[j], imag[i]]
    }
  }

  for (let size = 2; size <= n; size <<= 1) {
    const halfSize = size >> 1
    const tableStep = n / size
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < halfSize; k++) {
        const l = i + k + halfSize
        const jIndex = k * tableStep
        const tpre = real[l] * cosTable[jIndex] - imag[l] * sinTable[jIndex]
        const tpim = real[l] * sinTable[jIndex] + imag[l] * cosTable[jIndex]
        real[l] = real[i + k] - tpre
        imag[l] = imag[i + k] - tpim
        real[i + k] += tpre
        imag[i + k] += tpim
      }
    }
  }
}

const SG_COEFF_CACHE = new Map()

function smoothSpectrogram(dbMatrix) {
  const numBins = dbMatrix.length
  if (!numBins) return dbMatrix
  const numFrames = dbMatrix[0].length
  const windowSize = 11
  const polyOrder = 2
  const result = Array.from({ length: numBins }, () => new Float64Array(numFrames))

  for (let frame = 0; frame < numFrames; frame++) {
    const column = new Float64Array(numBins)
    for (let bin = 0; bin < numBins; bin++) {
      column[bin] = dbMatrix[bin][frame]
    }
    const smoothedColumn = applySavitzkyGolay(column, windowSize, polyOrder)
    for (let bin = 0; bin < numBins; bin++) {
      result[bin][frame] = smoothedColumn[bin]
    }
  }

  return result
}

function applySavitzkyGolay(series, windowSize, polyOrder) {
  if (series.length === 0) return series
  if (windowSize % 2 === 0) throw new Error('Savitzky-Golay window must be odd')
  const coeffs = getSavitzkyGolayCoefficients(windowSize, polyOrder)
  const half = (windowSize - 1) / 2
  const output = new Float64Array(series.length)

  for (let i = 0; i < series.length; i++) {
    let acc = 0
    for (let j = 0; j < windowSize; j++) {
      let idx = i + j - half
      if (idx < 0) idx = 0
      if (idx >= series.length) idx = series.length - 1
      acc += coeffs[j] * series[idx]
    }
    output[i] = acc
  }

  return output
}

function getSavitzkyGolayCoefficients(windowSize, polyOrder) {
  const key = `${windowSize}:${polyOrder}`
  if (SG_COEFF_CACHE.has(key)) return SG_COEFF_CACHE.get(key)
  const half = (windowSize - 1) / 2
  const order = polyOrder + 1
  const A = Array.from({ length: windowSize }, (_, row) => {
    const k = row - half
    return Array.from({ length: order }, (_, col) => Math.pow(k, col))
  })
  const AT = transpose(A)
  const ATA = multiply(AT, A)
  const ATAInv = invert(ATA)
  const pinv = multiply(ATAInv, AT)
  const coeffs = pinv[0]
  SG_COEFF_CACHE.set(key, coeffs)
  return coeffs
}

function transpose(matrix) {
  return matrix[0].map((_, colIndex) => matrix.map(row => row[colIndex]))
}

function multiply(a, b) {
  const rows = a.length
  const cols = b[0].length
  const shared = b.length
  const result = Array.from({ length: rows }, () => Array(cols).fill(0))
  for (let i = 0; i < rows; i++) {
    for (let k = 0; k < shared; k++) {
      for (let j = 0; j < cols; j++) {
        result[i][j] += a[i][k] * b[k][j]
      }
    }
  }
  return result
}

function invert(matrix) {
  const n = matrix.length
  const augmented = matrix.map((row, i) => [...row, ...identityRow(n, i)])
  for (let i = 0; i < n; i++) {
    let pivot = augmented[i][i]
    if (Math.abs(pivot) < 1e-12) {
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(augmented[j][i]) > Math.abs(pivot)) {
          ;[augmented[i], augmented[j]] = [augmented[j], augmented[i]]
          pivot = augmented[i][i]
          break
        }
      }
    }
    if (Math.abs(pivot) < 1e-12) {
      throw new Error('Matrix not invertible')
    }
    for (let j = 0; j < 2 * n; j++) {
      augmented[i][j] /= pivot
    }
    for (let k = 0; k < n; k++) {
      if (k === i) continue
      const factor = augmented[k][i]
      for (let j = 0; j < 2 * n; j++) {
        augmented[k][j] -= factor * augmented[i][j]
      }
    }
  }
  return augmented.map(row => row.slice(n))
}

function identityRow(size, index) {
  return Array.from({ length: size }, (_, i) => (i === index ? 1 : 0))
}

function computeMean(matrix) {
  let sum = 0
  let count = 0
  for (const column of matrix) {
    for (const value of column) {
      sum += value
      count++
    }
  }
  return count ? sum / count : 0
}

function computeStd(matrix, mean) {
  let sum = 0
  let count = 0
  for (const column of matrix) {
    for (const value of column) {
      const diff = value - mean
      sum += diff * diff
      count++
    }
  }
  return count ? Math.sqrt(sum / count) : 0
}

function computeDynamicRange(channelData, sampleRate) {
  if (!channelData.length) throw new TooShortError()
  const blockSize = Math.max(1, Math.floor(sampleRate * 3))
  const totalFrames = channelData[0].length
  const numBlocks = Math.floor(totalFrames / blockSize)
  if (numBlocks < 1) {
    throw new TooShortError()
  }

  const drs = []
  const avgPeaks = []
  const avgRmss = []
  for (const channel of channelData) {
    const stats = analyzeChannelBlocks(channel, blockSize, numBlocks)
    drs.push(stats.dr)
    avgPeaks.push(stats.avgPeak)
    avgRmss.push(stats.avgRms)
  }

  return {
    dynamicRange: roundTo(drs.reduce((acc, val) => acc + val, 0) / drs.length, 2),
    avgPeakDb: toDb(average(avgPeaks)),
    avgRmsDb: toDb(average(avgRmss))
  }
}

function analyzeChannelBlocks(channelSamples, blockSize, numBlocks) {
  const peaks = []
  const rmss = []
  for (let block = 0; block < numBlocks; block++) {
    const start = block * blockSize
    const end = start + blockSize
    let peak = 0
    let sumSquares = 0
    for (let i = start; i < end; i++) {
      const sample = channelSamples[i]
      const absVal = Math.abs(sample)
      if (absVal > peak) peak = absVal
      sumSquares += sample * sample
    }
    peaks.push(peak)
    rmss.push(Math.sqrt(sumSquares / blockSize))
  }

  peaks.sort((a, b) => a - b)
  rmss.sort((a, b) => a - b)
  if (peaks.length < 2) throw new TooShortError()
  const p2 = peaks[peaks.length - 2]
  if (p2 === 0) throw new SilentTrackError()
  const topCount = Math.floor(0.2 * rmss.length)
  if (topCount <= 0) throw new TooShortError()
  let rmsSum = 0
  for (let i = rmss.length - topCount; i < rmss.length; i++) {
    rmsSum += rmss[i] * rmss[i]
  }
  const r = Math.sqrt(rmsSum / topCount)
  const dr = -toDb(r / p2)
  return {
    dr,
    avgPeak: average(peaks),
    avgRms: average(rmss)
  }
}

function classifyVerdict(sampleRate, maxFreq) {
  const nyquist = sampleRate / 2
  if (maxFreq === null || !Number.isFinite(maxFreq)) {
    return { verdictKey: 'unknown', verdictLabel: "Can't determine" }
  }

  // Detect typical AAC 256 kbps spectral roll-off so we don't flag expected lossy files as fake.
  if (sampleRate <= 48000) {
    const norm = maxFreq / nyquist
    const aac256Lower = 0.78 // ~18 kHz on 44.1/48 kHz
    const aac256Upper = 0.93 // ~21 kHz on 44.1/48 kHz
    if (norm >= aac256Lower && norm <= aac256Upper) {
      return { verdictKey: 'aac_256', verdictLabel: 'Probable AAC-256 source (expected lossy)' }
    }
    if (norm < aac256Lower) {
      return { verdictKey: 'sub_aac_lossy', verdictLabel: 'Likely pre-AAC lossy source (<256 kbps)' }
    }
  }

  if (sampleRate === 48000) {
    if (maxFreq < 20000) return { verdictKey: 'fake', verdictLabel: 'Fake' }
    if (maxFreq < nyquist * 0.5) return { verdictKey: 'likely_fake', verdictLabel: 'Most likely Fake' }
    if (maxFreq < nyquist * 0.8) return { verdictKey: 'maybe_fake', verdictLabel: 'Might be Fake' }
    if (maxFreq < nyquist * 0.9) return { verdictKey: 'maybe_authentic', verdictLabel: 'Might be Authentic' }
    if (maxFreq < nyquist * 0.99)
      return { verdictKey: 'likely_authentic', verdictLabel: 'Most likely Authentic' }
    return { verdictKey: 'authentic', verdictLabel: 'Authentic' }
  }
  if (sampleRate > 48000) {
    if (maxFreq < 22050) return { verdictKey: 'fake', verdictLabel: 'Fake' }
    if (maxFreq < nyquist * 0.5) return { verdictKey: 'likely_fake', verdictLabel: 'Most likely Fake' }
    if (maxFreq < nyquist * 0.8) return { verdictKey: 'maybe_fake', verdictLabel: 'Might be Fake' }
    if (maxFreq < nyquist * 0.9)
      return { verdictKey: 'maybe_authentic', verdictLabel: 'Might be Authentic' }
    if (maxFreq < nyquist * 0.99)
      return { verdictKey: 'likely_authentic', verdictLabel: 'Most likely Authentic' }
    return { verdictKey: 'authentic', verdictLabel: 'Authentic' }
  }

  const reference = 22050
  if (maxFreq < reference * 0.8) return { verdictKey: 'fake', verdictLabel: 'Fake' }
  if (maxFreq < reference * 0.85)
    return { verdictKey: 'likely_fake', verdictLabel: 'Most likely Fake' }
  if (maxFreq < reference * 0.9) return { verdictKey: 'maybe_fake', verdictLabel: 'Might be Fake' }
  if (maxFreq < reference * 0.95)
    return { verdictKey: 'maybe_authentic', verdictLabel: 'Might be Authentic' }
  if (maxFreq < reference * 0.99)
    return { verdictKey: 'likely_authentic', verdictLabel: 'Most likely Authentic' }
  return { verdictKey: 'authentic', verdictLabel: 'Authentic' }
}

function average(values) {
  if (!values.length) return 0
  return values.reduce((sum, val) => sum + val, 0) / values.length
}

function toDb(value) {
  if (!Number.isFinite(value) || value <= 0) return -Infinity
  return Number((20 * Math.log10(value)).toFixed(2))
}

function roundTo(value, decimals = 2) {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

async function measureIntegratedLoudness(filePath) {
  return new Promise(resolve => {
    const args = [
      '-hide_banner',
      '-nostats',
      '-i',
      filePath,
      '-filter_complex',
      'ebur128=peak=true',
      '-f',
      'null',
      '-'
    ]

    const child = spawn(FFMPEG_PATH, args)
    let stderr = ''

    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })

    child.on('error', error => {
      console.warn('Unable to start ffmpeg loudness probe:', error)
      qualityDebug('ffmpeg loudness error:', error)
      resolve(null)
    })

    child.on('close', code => {
      if (code !== 0) {
        console.warn(`ffmpeg loudness probe failed (code ${code})`)
        qualityDebug('ffmpeg loudness stderr:', stderr.slice(-2000))
        resolve(null)
        return
      }
      const match = stderr.match(/Integrated loudness:\s*(-?\d+(?:\.\d+)?) LUFS/i)
      if (match) {
        resolve(Number(match[1]))
        return
      }
      resolve(null)
    })
  })
}

function buildQualityInfo(details) {
  const verdictLabel = messages.qualityVerdict(details.verdict_key, details.verdict_label)
  const parts = []
  if (verdictLabel) parts.push(verdictLabel)
  const maxFreqText = formatMaxFrequency(details.max_significant_freq)
  if (maxFreqText) parts.push(maxFreqText)
  const drText = formatDynamicRange(details.dynamic_range, details.dr_status)
  if (drText) parts.push(drText)
  const lufsText = formatLufs(details.lufs)
  if (lufsText) parts.push(lufsText)

  const text = parts.length ? parts.join(' • ') : messages.qualityFallbackLabel()

  return {
    rating: details.verdict_key,
    text,
    details
  }
}

function formatMaxFrequency(value) {
  if (!Number.isFinite(value)) return null
  return `max ${(value / 1000).toFixed(1)} kHz`
}

function formatDynamicRange(value, status) {
  if (status === 'too_short') return 'DR n/a (too short)'
  if (status === 'silent_track') return 'DR n/a (silent track)'
  if (!Number.isFinite(value)) return null
  return `DR ${value.toFixed(1)}`
}

function formatLufs(value) {
  if (!Number.isFinite(value)) return null
  return `${value.toFixed(1)} LUFS`
}

async function handleDownloadJob(ctx, url) {
  let download
  try {
    download = await downloadTrack(url)
    const stats = await fsp.stat(download.path)
    if (stats.size > TELEGRAM_MAX_FILE_BYTES) {
      await ctx.reply(messages.fileTooLarge())
      return
    }

    let qualityInfo = null
    if (ENABLE_QUALITY_ANALYSIS) {
      try {
        qualityDebug('Running quality analysis for file:', download.filename)
        qualityInfo = await analyzeTrackQuality(download.path)
        if (qualityInfo) {
          qualityDebug('Quality analysis finished:', qualityInfo)
        } else {
          qualityDebug('Quality analysis returned null; using fallback caption text.')
        }
      } catch (error) {
        console.warn('Quality analysis failed:', error)
        qualityDebug('Quality analysis threw error:', error)
      }
    } else if (QUALITY_ANALYSIS_DEBUG) {
      qualityDebug('Quality analysis disabled via ENABLE_QUALITY_ANALYSIS=false; skipping probe.')
    }

    const inputFile = new InputFile(fs.createReadStream(download.path), download.filename)
    await ctx.replyWithDocument(inputFile, {
      caption: buildCaption(download.metadata, qualityInfo)
    })
    incrementDownloadCount()
  } finally {
    if (download) {
      await cleanupTempDir(download.tempDir)
    }
  }
}

async function downloadTrack(url) {
  const ytdlp = await getYtDlp()
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sc-dl-'))
  const outputTemplate = path.join(tmpDir, '%(title)s.%(ext)s')
  const headers = [`Authorization: OAuth ${SOUNDCLOUD_OAUTH_TOKEN}`]
  let completed = false
  try {
    const options = {
      output: outputTemplate,
      format: 'bestaudio[ext!=opus][acodec!=opus]/http_aac_1_0/bestaudio/best',
      addHeader: headers,
      noPlaylist: true,
      retries: 3,
      noPart: true,
      quiet: true,
      addMetadata: true,
      embedThumbnail: true,
      convertThumbnails: 'jpg',
      writeInfoJson: true
    }

    if (YT_DLP_SKIP_CERT_CHECK) {
      options.noCheckCertificates = true
    }

    await ytdlp(url, options)

    const files = await fsp.readdir(tmpDir)
    if (!files.length) {
      const err = new Error('SoundCloud returned no downloadable audio for this link.')
      err.userMessage = messages.missingAudioFile()
      throw err
    }

    const { audioFile, metadata } = await pickAudioFile(tmpDir, files)
    completed = true
    return { tempDir: tmpDir, path: audioFile.path, filename: audioFile.name, metadata }
  } finally {
    if (!completed) {
      await cleanupTempDir(tmpDir)
    }
  }
}

async function cleanupTempDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true })
}

async function getYtDlp() {
  if (!ytdlpInstancePromise) {
    ytdlpInstancePromise = ensureYtDlpBinary().then(binaryPath => {
      console.log(`Using yt-dlp binary at ${binaryPath}`)
      return createYtDlp(binaryPath)
    })
  }
  return ytdlpInstancePromise
}

async function ensureYtDlpBinary() {
  if (YT_DLP_BINARY_PATH) {
    return YT_DLP_BINARY_PATH
  }

  const { filename, url, note } = pickBinaryArtifact()
  const targetPath = path.join(BINARY_CACHE_DIR, filename)

  try {
    await fsp.access(targetPath, fs.constants.X_OK)
    return targetPath
  } catch {
    // continue to download
  }

  console.log(`Downloading yt-dlp (${note}) ...`)
  await fsp.mkdir(BINARY_CACHE_DIR, { recursive: true })
  await downloadWithRedirects(url, targetPath)
  if (process.platform !== 'win32') {
    await fsp.chmod(targetPath, 0o755)
  }
  return targetPath
}

function pickBinaryArtifact() {
  if (process.platform === 'darwin') {
    return {
      filename: 'yt-dlp_macos',
      url: `${YT_DLP_RELEASE_BASE}yt-dlp_macos`,
      note: 'macOS universal binary'
    }
  }

  if (process.platform === 'win32') {
    return {
      filename: 'yt-dlp.exe',
      url: `${YT_DLP_RELEASE_BASE}yt-dlp.exe`,
      note: 'Windows standalone binary'
    }
  }

  if (process.platform === 'linux') {
    if (process.arch === 'arm64' || process.arch === 'aarch64') {
      return {
        filename: 'yt-dlp_linux_arm64',
        url: `${YT_DLP_RELEASE_BASE}yt-dlp_linux_arm64`,
        note: 'Linux ARM64 binary'
      }
    }

    if (process.arch.startsWith('arm')) {
      return {
        filename: 'yt-dlp_linux_armv7l',
        url: `${YT_DLP_RELEASE_BASE}yt-dlp_linux_armv7l`,
        note: 'Linux ARMv7 binary'
      }
    }

    return {
      filename: 'yt-dlp_linux',
      url: `${YT_DLP_RELEASE_BASE}yt-dlp_linux`,
      note: 'Linux x64 binary'
    }
  }

  return {
    filename: 'yt-dlp',
    url: `${YT_DLP_RELEASE_BASE}yt-dlp`,
    note: 'generic script (requires Python 3.10+)'
  }
}

async function downloadWithRedirects(url, filePath, attempt = 0) {
  const MAX_REDIRECTS = 5
  await new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      const { statusCode, headers } = response

      if (
        statusCode &&
        statusCode >= 300 &&
        statusCode < 400 &&
        headers.location
      ) {
        response.resume()
        if (attempt >= MAX_REDIRECTS) {
          reject(new Error('Too many redirects while downloading yt-dlp binary.'))
          return
        }
        downloadWithRedirects(headers.location, filePath, attempt + 1)
          .then(resolve)
          .catch(reject)
        return
      }

      if (statusCode !== 200) {
        response.resume()
        reject(new Error(`Failed to download yt-dlp (status ${statusCode}).`))
        return
      }

      const writeStream = fs.createWriteStream(filePath)
      pipeline(response, writeStream).then(resolve).catch(reject)
    })

    request.on('error', reject)
  })
}

function buildCaption(metadata, qualityInfo) {
  if (!metadata) return appendQuality(messages.captionDefault(), qualityInfo)
  const title = metadata.title || metadata.fulltitle
  const artist = metadata.uploader || metadata.artist
  if (title && artist) {
    return appendQuality(`${artist} – ${title}`, qualityInfo)
  }
  if (title) return appendQuality(title, qualityInfo)
  return appendQuality(messages.captionFallback(), qualityInfo)
}

function appendQuality(caption, qualityInfo) {
  if (!qualityInfo?.text) return caption
  return `${caption}\n${messages.qualityLine(qualityInfo.text)}`
}

async function pickAudioFile(tmpDir, files) {
  let info
  let infoPath
  const audioCandidates = []

  for (const file of files) {
    if (file.endsWith(INFO_SUFFIX)) {
      infoPath = path.join(tmpDir, file)
      continue
    }

    const ext = path.extname(file).toLowerCase()
    if (THUMB_EXTENSIONS.has(ext) || ext === '.opus') {
      continue
    }

    audioCandidates.push({ name: file, path: path.join(tmpDir, file) })
  }

  if (!audioCandidates.length) {
    const err = new Error('Download finished but no audio file was located.')
    err.userMessage = messages.opusOnlyMessage()
    throw err
  }

  if (infoPath) {
    try {
      info = JSON.parse(await fsp.readFile(infoPath, 'utf8'))
    } catch (error) {
      console.warn('Failed to parse SoundCloud metadata JSON:', error)
    }
  }

  return { audioFile: audioCandidates[0], metadata: info }
}

async function initializeBot() {
  await loadAuthorizedUsersFromDisk()
  await loadDownloadCountFromDisk()
  console.log(`Authorized users loaded: ${authorizedUsers.size}`)
  console.log(`Tracks downloaded historically: ${downloadCount}`)
  console.log('Bot is up. Waiting for SoundCloud URLs...')
  await bot.start()
}

async function loadAuthorizedUsersFromDisk() {
  try {
    const raw = await fsp.readFile(AUTH_STORE_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      parsed.forEach(value => {
        const id = Number(value)
        if (Number.isFinite(id)) {
          authorizedUsers.add(id)
        }
      })
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Unable to load authorized users file:', error)
    }
  }
}

async function loadDownloadCountFromDisk() {
  try {
    const raw = await fsp.readFile(DOWNLOAD_COUNT_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    let value
    if (typeof parsed === 'number') {
      value = parsed
    } else if (parsed && typeof parsed.count === 'number') {
      value = parsed.count
    }

    if (Number.isFinite(value)) {
      downloadCount = value
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Unable to load download count file:', error)
    }
  }
}

function scheduleAuthorizedPersist() {
  authorizedUsersDirty = true
  if (persistAuthorizedUsersTimer) return
  persistAuthorizedUsersTimer = setTimeout(() => {
    persistAuthorizedUsersTimer = null
    persistAuthorizedUsers().catch(error =>
      console.error('Failed to persist authorized users:', error)
    )
  }, 250)
}

async function persistAuthorizedUsers() {
  await fsp.mkdir(DATA_DIR, { recursive: true })
  const payload = JSON.stringify([...authorizedUsers])
  const tempPath = `${AUTH_STORE_PATH}.tmp-${Date.now()}`
  await fsp.writeFile(tempPath, payload, 'utf8')
  await fsp.rename(tempPath, AUTH_STORE_PATH)
  authorizedUsersDirty = false
}

function scheduleDownloadCountPersist() {
  downloadCountDirty = true
  if (persistDownloadCountTimer) return
  persistDownloadCountTimer = setTimeout(() => {
    persistDownloadCountTimer = null
    persistDownloadCount().catch(error =>
      console.error('Failed to persist download count:', error)
    )
  }, 250)
}

async function persistDownloadCount() {
  await fsp.mkdir(DATA_DIR, { recursive: true })
  const tempPath = `${DOWNLOAD_COUNT_PATH}.tmp-${Date.now()}`
  await fsp.writeFile(tempPath, JSON.stringify(downloadCount), 'utf8')
  await fsp.rename(tempPath, DOWNLOAD_COUNT_PATH)
  downloadCountDirty = false
}

function incrementDownloadCount() {
  downloadCount += 1
  scheduleDownloadCountPersist()
}

function createTaskQueue(desiredConcurrency, maxQueueSize = Infinity) {
  const limit = Number.isFinite(desiredConcurrency) && desiredConcurrency > 0
    ? desiredConcurrency
    : Infinity
  const queueLimit = Number.isFinite(maxQueueSize) && maxQueueSize >= 0
    ? maxQueueSize
    : Infinity
  let active = 0
  const queue = []

  const runNext = () => {
    if (active >= limit || queue.length === 0) {
      return
    }
    const { task, resolve, reject } = queue.shift()
    active += 1
    Promise.resolve()
      .then(task)
      .then(result => {
        active -= 1
        resolve(result)
        runNext()
      })
      .catch(error => {
        active -= 1
        reject(error)
        runNext()
      })
  }

  return {
    add(task) {
      if (queue.length >= queueLimit) {
        const error = new Error('Download queue is full.')
        error.userMessage = messages.queueFull()
        return Promise.reject(error)
      }

      return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject })
        runNext()
      })
    }
  }
}

async function handlePasswordFlow(ctx, userId) {
  const text = (ctx.message.text || '').trim()

  if (awaitingPassword.has(userId)) {
    if (!text) {
      await promptForPassword(ctx, userId)
      return
    }

    if (text === ACCESS_PASSWORD) {
      awaitingPassword.delete(userId)
      authorizedUsers.add(userId)
      scheduleAuthorizedPersist()
      await ctx.reply(messages.passwordAccepted())
    } else {
      await ctx.reply(messages.passwordRejected())
      awaitingPassword.add(userId)
    }
    return
  }

  await promptForPassword(ctx, userId)
}

async function promptForPassword(ctx, userId) {
  awaitingPassword.add(userId)
  await ctx.reply(messages.promptPassword())
}

function isBotCommand(ctx) {
  const entities = ctx.message.entities
  if (!entities) return false
  return entities.some(entity => entity.type === 'bot_command' && entity.offset === 0)
}

function formatUserFacingError(error) {
  if (error?.userMessage) {
    return error.userMessage
  }

  return messages.genericError()
}

function extractReadableErrorText(error) {
  const candidates = []
  if (typeof error === 'string') candidates.push(error)
  if (typeof error?.message === 'string') candidates.push(error.message)
  if (typeof error?.stderr === 'string') candidates.push(error.stderr)
  if (typeof error?.stdout === 'string') candidates.push(error.stdout)

  for (const text of candidates) {
    const cleaned = pickUserFriendlyLine(text)
    if (cleaned) return cleaned
  }
  return null
}

function pickUserFriendlyLine(text) {
  if (!text) return null
  const errorMatch = text.match(/ERROR:\s*(.+)/i)
  if (errorMatch) {
    return truncate(errorMatch[1])
  }

  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line =>
      !line.startsWith('Traceback') &&
      !line.startsWith('File "') &&
      !line.startsWith('at ')
    )

  if (!lines.length) return null
  return truncate(lines[0])
}

function truncate(text, max = 140) {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

function setupSignalHandlers() {
  SHUTDOWN_SIGNALS.forEach(signal => {
    process.once(signal, () => {
      if (isShuttingDown) return
      isShuttingDown = true
      console.log(`Received ${signal}. Stopping bot...`)
      shutdownGracefully(signal)
        .catch(error => {
          console.error('Shutdown failed:', error)
          process.exitCode = 1
        })
        .finally(() => {
          process.exit(process.exitCode || 0)
        })
    })
  })

  process.on('beforeExit', () => {
    flushState().catch(error => {
      console.error('Failed to flush state before exit:', error)
    })
  })
}

async function shutdownGracefully(signal) {
  try {
    await bot.stop()
  } catch (error) {
    console.warn(`Unable to stop bot cleanly after ${signal}:`, error)
  }

  await flushState()
}

async function flushState() {
  if (persistAuthorizedUsersTimer) {
    clearTimeout(persistAuthorizedUsersTimer)
    persistAuthorizedUsersTimer = null
  }
  if (persistDownloadCountTimer) {
    clearTimeout(persistDownloadCountTimer)
    persistDownloadCountTimer = null
  }

  const pending = []
  if (authorizedUsersDirty) {
    pending.push(
      persistAuthorizedUsers().catch(error => {
        console.error('Failed to persist authorized users during shutdown:', error)
        throw error
      })
    )
  }
  if (downloadCountDirty) {
    pending.push(
      persistDownloadCount().catch(error => {
        console.error('Failed to persist download count during shutdown:', error)
        throw error
      })
    )
  }

  if (!pending.length) {
    return
  }

  await Promise.all(pending)
}

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed
  }
  return fallback
}

function qualityDebug(...args) {
  if (!QUALITY_ANALYSIS_DEBUG) return
  console.debug('[quality]', ...args)
}
