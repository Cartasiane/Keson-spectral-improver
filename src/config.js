'use strict'

const path = require('node:path')

const BOT_TOKEN = process.env.BOT_TOKEN
const SOUNDCLOUD_OAUTH_TOKEN =
  process.env.SOUNDCLOUD_OAUTH_TOKEN || process.env.SOUNDCLOUD_OAUTH
const PASSWORD_SEGMENT_SIZE = 25
const ACCESS_PASSWORDS = readPasswordList()
const MAX_AUTHORIZED_USERS = ACCESS_PASSWORDS.length * PASSWORD_SEGMENT_SIZE
const ADMIN_USER_IDS = readAdminList()
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
const SOUND_CLOUD_REGEX = /(https?:\/\/(?:[\w-]+\.)?soundcloud\.com\/[\w\-./?=&%+#]+)/i
const THUMB_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const INFO_SUFFIX = '.info.json'

module.exports = {
  ACCESS_PASSWORDS,
  AUTH_STORE_PATH,
  BINARY_CACHE_DIR,
  ADMIN_USER_IDS,
  BOT_TOKEN,
  DATA_DIR,
  DOWNLOAD_COUNT_PATH,
  ENABLE_QUALITY_ANALYSIS,
  FFPROBE_PATH,
  FFMPEG_PATH,
  IDHS_API_BASE_URL,
  IDHS_REQUEST_TIMEOUT_MS,
  IDHS_SUPPORTED_HOSTS,
  INFO_SUFFIX,
  MAX_AUTHORIZED_USERS,
  MAX_CONCURRENT_DOWNLOADS,
  MAX_PENDING_DOWNLOADS,
  PASSWORD_SEGMENT_SIZE,
  QUALITY_ANALYSIS_DEBUG,
  SHUTDOWN_SIGNALS,
  SOUND_CLOUD_REGEX,
  SOUNDCLOUD_OAUTH_TOKEN,
  TELEGRAM_MAX_FILE_BYTES,
  THUMB_EXTENSIONS,
  YT_DLP_BINARY_PATH,
  YT_DLP_RELEASE_BASE,
  YT_DLP_SKIP_CERT_CHECK,
  validateRequiredEnv
}

function validateRequiredEnv() {
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

  if (!ACCESS_PASSWORDS.length) {
    console.error('BOT_PASSWORDS (or BOT_PASSWORD) is missing. Set at least one password.')
    process.exit(1)
  }
}

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed
  }
  return fallback
}

function readPasswordList() {
  const raw = process.env.BOT_PASSWORDS || process.env.BOT_PASSWORD
  if (!raw) return []

  return raw
    .split(/[\n,;]+/)
    .map(entry => entry.trim())
    .filter(Boolean)
}

function readAdminList() {
  const raw = process.env.ADMIN_USER_IDS
  if (!raw) return []

  return raw
    .split(/[\n,;\s]+/)
    .map(entry => Number.parseInt(entry.trim(), 10))
    .filter(value => Number.isFinite(value))
}
