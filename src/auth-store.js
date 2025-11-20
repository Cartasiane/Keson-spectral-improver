'use strict'

const fsp = require('node:fs/promises')
const {
  AUTH_STORE_PATH,
  DATA_DIR,
  DOWNLOAD_COUNT_PATH
} = require('./config')

const authorizedUsers = new Set()
let downloadCount = 0
let authorizedUsersDirty = false
let downloadCountDirty = false
let persistAuthorizedUsersTimer
let persistDownloadCountTimer

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

function isAuthorized(userId) {
  return authorizedUsers.has(userId)
}

function addAuthorizedUser(userId) {
  authorizedUsers.add(userId)
  scheduleAuthorizedPersist()
}

function getDownloadCount() {
  return downloadCount
}

function incrementDownloadCount() {
  downloadCount += 1
  scheduleDownloadCountPersist()
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

async function persistAuthorizedUsers() {
  authorizedUsersDirty = false
  await fsp.mkdir(DATA_DIR, { recursive: true })
  const payload = JSON.stringify([...authorizedUsers])
  const tempPath = `${AUTH_STORE_PATH}.tmp-${Date.now()}`
  await fsp.writeFile(tempPath, payload, 'utf8')
  await fsp.rename(tempPath, AUTH_STORE_PATH)
}

async function persistDownloadCount() {
  downloadCountDirty = false
  await fsp.mkdir(DATA_DIR, { recursive: true })
  const tempPath = `${DOWNLOAD_COUNT_PATH}.tmp-${Date.now()}`
  await fsp.writeFile(tempPath, JSON.stringify(downloadCount), 'utf8')
  await fsp.rename(tempPath, DOWNLOAD_COUNT_PATH)
}

module.exports = {
  addAuthorizedUser,
  authorizedUsers,
  flushState,
  getDownloadCount,
  incrementDownloadCount,
  isAuthorized,
  loadAuthorizedUsersFromDisk,
  loadDownloadCountFromDisk
}
