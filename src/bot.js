'use strict'

require('dotenv').config()

const { Bot, InputFile } = require('grammy')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const messages = require('./messages')
const {
  ACCESS_PASSWORD,
  BOT_TOKEN,
  ENABLE_QUALITY_ANALYSIS,
  MAX_CONCURRENT_DOWNLOADS,
  MAX_PENDING_DOWNLOADS,
  QUALITY_ANALYSIS_DEBUG,
  SHUTDOWN_SIGNALS,
  TELEGRAM_MAX_FILE_BYTES,
  validateRequiredEnv
} = require('./config')
const { buildCaption } = require('./captions')
const { downloadTrack, cleanupTempDir } = require('./downloader')
const { analyzeTrackQuality, qualityDebug } = require('./quality')
const { createTaskQueue } = require('./queue')
const { isIdhsSupportedLink, resolveLinkViaIdhs } = require('./idhs')
const {
  addAuthorizedUser,
  authorizedUsers,
  flushState,
  getDownloadCount,
  incrementDownloadCount,
  isAuthorized,
  loadAuthorizedUsersFromDisk,
  loadDownloadCountFromDisk
} = require('./auth-store')
const {
  extractFirstUrl,
  extractSoundCloudUrl,
  formatUserFacingError,
  isBotCommand
} = require('./utils')

validateRequiredEnv()

const bot = new Bot(BOT_TOKEN)
const awaitingPassword = new Set()
const downloadQueue = createTaskQueue(MAX_CONCURRENT_DOWNLOADS, MAX_PENDING_DOWNLOADS)
let isShuttingDown = false

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

  if (isAuthorized(userId)) {
    await ctx.reply(messages.alreadyAuthorized())
  } else {
    await promptForPassword(ctx, userId)
  }
})

bot.command('downloads', async ctx => {
  await ctx.reply(messages.downloadCount(getDownloadCount()))
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

  if (!isAuthorized(userId)) {
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

async function handlePasswordFlow(ctx, userId) {
  const text = (ctx.message.text || '').trim()

  if (awaitingPassword.has(userId)) {
    if (!text) {
      await promptForPassword(ctx, userId)
      return
    }

    if (text === ACCESS_PASSWORD) {
      awaitingPassword.delete(userId)
      addAuthorizedUser(userId)
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
        qualityInfo = await analyzeTrackQuality(download.path, download.metadata)
        if (qualityInfo) {
          qualityDebug('Bitrate analysis finished:', qualityInfo)
        } else {
          qualityDebug('Bitrate analysis returned null; using fallback caption text.')
        }
      } catch (error) {
        console.warn('Bitrate analysis failed:', error)
        qualityDebug('Bitrate analysis threw error:', error)
      }
    } else if (QUALITY_ANALYSIS_DEBUG) {
      qualityDebug('Quality analysis disabled via ENABLE_QUALITY_ANALYSIS=false; skipping probe.')
    }

    const inputFile = new InputFile(fs.createReadStream(download.path), download.filename)
    await ctx.replyWithDocument(inputFile, {
      caption: buildCaption(download.metadata, qualityInfo)
    })
    if (qualityInfo?.warning) {
      await ctx.reply(qualityInfo.warning)
    }
    incrementDownloadCount()
  } finally {
    if (download) {
      await cleanupTempDir(download.tempDir)
    }
  }
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

async function initializeBot() {
  await loadAuthorizedUsersFromDisk()
  await loadDownloadCountFromDisk()
  console.log(`Authorized users loaded: ${authorizedUsers.size}`)
  console.log(`Tracks downloaded historically: ${getDownloadCount()}`)
  console.log('Bot is up. Waiting for SoundCloud URLs...')
  await bot.start()
}
