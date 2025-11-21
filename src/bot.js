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
const { downloadTrack, cleanupTempDir, fetchPlaylistTracks } = require('./downloader')
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
  isBotCommand,
  isSoundCloudPlaylist
} = require('./utils')

validateRequiredEnv()

const bot = new Bot(BOT_TOKEN)
const awaitingPassword = new Set()
const downloadQueue = createTaskQueue(MAX_CONCURRENT_DOWNLOADS, MAX_PENDING_DOWNLOADS)
let isShuttingDown = false
const playlistSessions = new Map()
const PLAYLIST_CHUNK_SIZE = 10
const PLAYLIST_MAX_ITEMS = 100
const PLAYLIST_GROUP_SIZE = 10

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

  if (isSoundCloudPlaylist(url)) {
    await handlePlaylistRequest(ctx, url)
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

bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data || ''
  if (!data.startsWith('pl:')) return
  const [, action, sessionId] = data.split(':')
  const session = playlistSessions.get(sessionId)
  if (!session) {
    await ctx.answerCallbackQuery({ text: 'Session expirée', show_alert: false })
    return
  }
  if (ctx.from?.id !== session.userId) {
    await ctx.answerCallbackQuery({ text: "Ce n'est pas ta playlist ;)", show_alert: true })
    return
  }

  if (action === 'stop') {
    playlistSessions.delete(sessionId)
    await ctx.answerCallbackQuery({ text: 'Arrêté' })
    await ctx.editMessageText(messages.playlistStopped())
    return
  }

  if (action === 'cont') {
    session.awaitingPrompt = false
    playlistSessions.set(sessionId, session)
    await ctx.answerCallbackQuery({ text: 'On continue' })
    enqueueNextTrack(ctx, sessionId, true)
  }
})

initializeBot().catch(error => {
  console.error('Failed to start bot:', error)
  process.exit(1)
})

async function handlePlaylistRequest(ctx, url) {
  const entries = await fetchPlaylistTracks(url, PLAYLIST_MAX_ITEMS)
  if (!entries.length) {
    await ctx.reply(messages.playlistNoEntries())
    return
  }
  const sessionId = `${ctx.from.id}-${Date.now()}`
  const session = {
    id: sessionId,
    userId: ctx.from.id,
    tracks: entries,
    nextIndex: 0,
    promptMessageId: null,
    awaitingPrompt: false,
    buffer: []
  }
  playlistSessions.set(sessionId, session)
  await ctx.reply(messages.playlistDetected(entries.length, PLAYLIST_CHUNK_SIZE, PLAYLIST_MAX_ITEMS))
  enqueueNextTrack(ctx, sessionId)
}

async function enqueueNextTrack(ctx, sessionId, force = false) {
  const session = playlistSessions.get(sessionId)
  if (!session) return

  if (session.nextIndex >= session.tracks.length) {
    if (session.buffer.length) {
      await sendPlaylistGroup(ctx, sessionId)
    }
    await ctx.reply(messages.playlistDone())
    playlistSessions.delete(sessionId)
    return
  }

  if (!force && session.nextIndex > 0 && session.nextIndex % PLAYLIST_CHUNK_SIZE === 0) {
    if (session.awaitingPrompt) return
    const msg = await ctx.reply(
      messages.playlistChunkPrompt(session.nextIndex, session.tracks.length, PLAYLIST_CHUNK_SIZE),
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '▶️ Continuer', callback_data: `pl:cont:${sessionId}` },
              { text: '🛑 Stop', callback_data: `pl:stop:${sessionId}` }
            ]
          ]
        }
      }
    )
    session.promptMessageId = msg.message_id
    session.awaitingPrompt = true
    playlistSessions.set(sessionId, session)
    return
  }

  const trackUrl = session.tracks[session.nextIndex]
  session.nextIndex += 1
  playlistSessions.set(sessionId, session)

  try {
    await downloadQueue.add(async () => {
      const result = await handleDownloadJob(ctx, trackUrl, { skipSend: true })
      if (!result) return
      session.buffer.push({
        download: result.download,
        qualityInfo: result.qualityInfo
      })
      if (
        session.buffer.length >= PLAYLIST_GROUP_SIZE ||
        session.nextIndex >= session.tracks.length
      ) {
        await sendPlaylistGroup(ctx, sessionId)
      }
    })
    await enqueueNextTrack(ctx, sessionId)
  } catch (error) {
    console.error('Playlist track failed:', error)
    await ctx.reply(formatUserFacingError(error))
    // if queue full, stop playlist
    if (error?.code === 'QUEUE_FULL') {
      playlistSessions.delete(sessionId)
      return
    }
    await enqueueNextTrack(ctx, sessionId)
  }
}

async function sendPlaylistGroup(ctx, sessionId) {
  const session = playlistSessions.get(sessionId)
  if (!session || !session.buffer.length) return

  const media = session.buffer.map((item, idx) => {
    const inputFile = new InputFile(
      fs.createReadStream(item.download.path),
      item.download.filename
    )
    const caption = idx === 0 ? buildCaption(item.download.metadata, item.qualityInfo) : undefined
    return {
      type: 'document',
      media: inputFile,
      caption
    }
  })

  const warnLines = []

  try {
    await ctx.replyWithMediaGroup(media)
  } catch (error) {
    // Fallback to individual sends if media group is too large (e.g., 413)
    if (error?.description && /entity too large/i.test(error.description)) {
      for (const item of session.buffer) {
        const inputFile = new InputFile(
          fs.createReadStream(item.download.path),
          item.download.filename
        )
        const caption = buildCaption(item.download.metadata, item.qualityInfo)
        await ctx.replyWithDocument(inputFile, { caption })
      }
    } else {
      throw error
    }
  } finally {
    for (const item of session.buffer) {
      if (item.qualityInfo?.warning) {
        const meta = item.download.metadata || {}
        const name = meta.title || meta.fulltitle || item.download.filename
        warnLines.push(`- ${name}: ${item.qualityInfo.warning}`)
      }
      incrementDownloadCount()
      await cleanupTempDir(item.download.tempDir)
    }
    if (warnLines.length) {
      await ctx.reply(`⚠️ Qualité réduite sur:\n${warnLines.join('\n')}`)
    }
    session.buffer = []
    playlistSessions.set(sessionId, session)
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

async function handleDownloadJob(ctx, url, opts = {}) {
  const skipSend = opts.skipSend === true
  let download
  try {
    download = await downloadTrack(url)
    const stats = await fsp.stat(download.path)
    if (stats.size > TELEGRAM_MAX_FILE_BYTES) {
      if (!skipSend) {
        await ctx.reply(messages.fileTooLarge())
      }
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

    if (skipSend) {
      return { download, qualityInfo }
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
    if (download && !skipSend) {
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
