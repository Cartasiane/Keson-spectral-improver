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

const BOT_TOKEN = process.env.BOT_TOKEN
const SOUNDCLOUD_OAUTH_TOKEN =
  process.env.SOUNDCLOUD_OAUTH_TOKEN || process.env.SOUNDCLOUD_OAUTH
const ACCESS_PASSWORD = process.env.BOT_PASSWORD
const YT_DLP_BINARY_PATH = process.env.YT_DLP_BINARY_PATH
const BINARY_CACHE_DIR = path.join(__dirname, '..', 'bin')
const DATA_DIR = path.join(__dirname, '..', 'data')
const AUTH_STORE_PATH = path.join(DATA_DIR, 'authorized-users.json')
const YT_DLP_RELEASE_BASE =
  process.env.YT_DLP_DOWNLOAD_BASE ||
  'https://github.com/yt-dlp/yt-dlp/releases/latest/download/'
const MAX_CONCURRENT_DOWNLOADS = Number(process.env.MAX_CONCURRENT_DOWNLOADS || 3)
const TELEGRAM_MAX_FILE_BYTES = 50 * 1024 * 1024
const downloadQueue = createTaskQueue(MAX_CONCURRENT_DOWNLOADS)

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
const SOUND_CLOUD_REGEX = /(https?:\/\/(?:m\.)?soundcloud\.com\/[\w\-./?=&%+#]+)/i

bot.api
  .setMyCommands([{ command: 'start', description: 'Show bot instructions' }])
  .catch(error => console.warn('Unable to set bot commands:', error))

bot.command('start', async ctx => {
  await ctx.reply(
    'Cc, je suis là pour que le spectre de tes tracks soit autant large que le tien!'
  )

  const userId = ctx.from?.id
  if (!userId) {
    await ctx.reply('Unable to verify user id.')
    return
  }

  if (authorizedUsers.has(userId)) {
    await ctx.reply('You are already authorized—just send a SoundCloud link!')
  } else {
    await promptForPassword(ctx, userId)
  }
})

bot.on('message:text', async ctx => {
  if (isBotCommand(ctx)) {
    return
  }

  const userId = ctx.from?.id
  if (!userId) {
    await ctx.reply('Unable to verify user id.')
    return
  }

  if (!authorizedUsers.has(userId)) {
    await handlePasswordFlow(ctx, userId)
    return
  }

  const url = extractSoundCloudUrl(ctx.message.text)
  if (!url) {
    await ctx.reply('Balance un lien soundcloud valide bb')
    return
  }

  await ctx.reply('exspectro partronumb')

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

async function handleDownloadJob(ctx, url) {
  let download
  try {
    download = await downloadTrack(url)
    const stats = await fsp.stat(download.path)
    if (stats.size > TELEGRAM_MAX_FILE_BYTES) {
      const sizeMb = (stats.size / (1024 * 1024)).toFixed(2)
      await ctx.reply(
        `Ton son est trop gros bb :( telegram a la flemmmmme`
      )
      return
    }

    const inputFile = new InputFile(fs.createReadStream(download.path), download.filename)
    await ctx.replyWithDocument(inputFile, {
      caption: buildCaption(download.metadata)
    })
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

  await ytdlp(url, {
    output: outputTemplate,
    format: 'http_aac_1_0/bestaudio/best',
    addHeader: headers,
    noPlaylist: true,
    noCheckCertificates: true,
    retries: 3,
    noPart: true,
    quiet: true,
    addMetadata: true,
    embedThumbnail: true,
    convertThumbnails: 'jpg',
    writeInfoJson: true
  })

  const files = await fsp.readdir(tmpDir)
  if (!files.length) {
    const err = new Error('SoundCloud returned no downloadable audio for this link.')
    err.userMessage =
      'SoundCloud did not provide an audio file for that link. Please try another track.'
    throw err
  }

  const { audioFile, metadata } = await pickAudioFile(tmpDir, files)
  return { tempDir: tmpDir, path: audioFile.path, filename: audioFile.name, metadata }
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

function buildCaption(metadata) {
  if (!metadata) return 'Enjoy bb!'
  const title = metadata.title || metadata.fulltitle
  const artist = metadata.uploader || metadata.artist
  if (title && artist) {
    return `${artist} – ${title}`
  }
  if (title) return title
  return 'enjpoy bb!'
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
    if (THUMB_EXTENSIONS.has(ext)) {
      continue
    }

    audioCandidates.push({ name: file, path: path.join(tmpDir, file) })
  }

  if (!audioCandidates.length) {
    throw new Error('Download finished but no audio file was located.')
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
  console.log(`Authorized users loaded: ${authorizedUsers.size}`)
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

function scheduleAuthorizedPersist() {
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
}

function createTaskQueue(desiredConcurrency) {
  const limit = Number.isFinite(desiredConcurrency) && desiredConcurrency > 0
    ? desiredConcurrency
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
      await ctx.reply('bravo t kool')
    } else {
      await ctx.reply('pas le bon mdp lol')
      awaitingPassword.add(userId)
    }
    return
  }

  await promptForPassword(ctx, userId)
}

async function promptForPassword(ctx, userId) {
  awaitingPassword.add(userId)
  await ctx.reply('mdp stp bb')
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

  return 'dsl je trouve pas ton bail, check ton lien.'
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
