'use strict'

const { SOUND_CLOUD_REGEX } = require('./config')
const messages = require('./messages')

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

function isBotCommand(ctx) {
  const entities = ctx.message.entities
  if (!entities) return false
  return entities.some(entity => entity.type === 'bot_command' && entity.offset === 0)
}

function formatUserFacingError(error) {
  if (error?.userMessage) {
    return error.userMessage
  }
  if (error?.code === 'QUEUE_FULL') {
    return messages.queueFull()
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

function isSoundCloudPlaylist(url) {
  try {
    const u = new URL(url)
    return /soundcloud\.com/i.test(u.hostname) && /\/sets\//i.test(u.pathname)
  } catch {
    return false
  }
}

module.exports = {
  extractFirstUrl,
  extractReadableErrorText,
  extractSoundCloudUrl,
  formatUserFacingError,
  isBotCommand,
  isSoundCloudPlaylist,
  pickUserFriendlyLine,
  truncate
}
