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
const QUALITY_RMS_THRESHOLD_DB = Number(process.env.QUALITY_RMS_THRESHOLD_DB || -55)
const QUALITY_FREQ_STEPS = [
  { freq: 19500, labelKey: 'lossless', rating: 'haute' },
  { freq: 18500, labelKey: 'kbps224', rating: 'haute' },
  { freq: 17500, labelKey: 'kbps192', rating: 'moyenne' },
  { freq: 16500, labelKey: 'kbps160', rating: 'moyenne-basse' },
  { freq: 15500, labelKey: 'kbps128', rating: 'basse' }
]
const QUALITY_FALLBACK_LABEL = messages.qualityFallbackLabel()
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

async function analyzeTrackQuality(filePath) {
  if (!FFMPEG_PATH) return null
  let selected = null
  let hadMeasurement = false
  qualityDebug('Starting quality probe for:', filePath)
  qualityDebug('Using frequency steps:', QUALITY_FREQ_STEPS)

  for (const step of QUALITY_FREQ_STEPS) {
    qualityDebug(`Measuring RMS above ${step.freq} Hz`)
    const rms = await measureHighFreqEnergy(filePath, step.freq)
    if (rms === null) {
      qualityDebug(`Measurement failed for ${step.freq} Hz; trying next tier.`)
      continue
    }
    hadMeasurement = true
    qualityDebug(`RMS for ${step.freq} Hz: ${rms} dB`)
    if (rms > QUALITY_RMS_THRESHOLD_DB) {
      const label = messages.qualityLabel(step.labelKey)
      selected = {
        cutoffHz: step.freq,
        rating: step.rating,
        text: `~${(step.freq / 1000).toFixed(1)} kHz (${label})`
      }
      qualityDebug('Selected tier:', selected)
      break
    }
  }

  if (!selected) {
    if (!hadMeasurement) {
      qualityDebug('All measurements failed; returning null to skip caption update.')
      return null
    }
    qualityDebug('No tier matched; using fallback label.')
    return {
      cutoffHz: 0,
      rating: 'très basse',
      text: QUALITY_FALLBACK_LABEL
    }
  }

  return selected
}

function measureHighFreqEnergy(filePath, cutoffHz) {
  return new Promise(resolve => {
    qualityDebug(`Spawning ffmpeg for cutoff ${cutoffHz} Hz`)
    const args = [
      '-hide_banner',
      '-loglevel', 'info',
      '-nostats',
      '-i', filePath,
      '-filter_complex', `highpass=f=${cutoffHz},astats=metadata=1:reset=1`,
      '-f', 'null',
      '-'
    ]

    const child = spawn(FFMPEG_PATH, args)
    let stderr = ''

    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })

    child.on('error', error => {
      console.warn('Unable to start ffmpeg for quality probe:', error)
      qualityDebug('ffmpeg spawn error:', error)
      resolve(null)
    })

    child.on('close', code => {
      if (code !== 0) {
        console.warn(`ffmpeg quality probe failed (code ${code})`)
        qualityDebug(`ffmpeg exited with code ${code}`)
        resolve(null)
        return
      }
      const rms = extractRmsFromAstStats(stderr)
      if (rms === null) {
        qualityDebug('No RMS matches in ffmpeg stderr output; raw stderr follows:')
        qualityDebug(stderr.slice(-2000))
        resolve(null)
        return
      }
      qualityDebug('Parsed RMS value:', rms)
      resolve(rms)
    })
  })
}

function extractRmsFromAstStats(output) {
  const regexes = [
    /Overall\.RMS_level:\s*(-?\d+(?:\.\d+)?)/i,
    /RMS level dB:\s*(-?\d+(?:\.\d+)?)/i,
    /RMS_level dB:\s*(-?\d+(?:\.\d+)?)/i
  ]

  for (const pattern of regexes) {
    const match = pattern.exec(output)
    if (match) {
      const value = Number(match[1])
      return Number.isFinite(value) ? value : null
    }
  }

  return null
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
