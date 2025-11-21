'use strict'

const http = require('node:http')
const https = require('node:https')
const {
  IDHS_API_BASE_URL,
  IDHS_REQUEST_TIMEOUT_MS,
  IDHS_SUPPORTED_HOSTS,
  SOUND_CLOUD_REGEX
} = require('./config')
const { extractSoundCloudUrl } = require('./utils')

async function resolveLinkViaIdhs(originalLink) {
  if (!IDHS_API_BASE_URL) return null
  let endpoint
  try {
    endpoint = new URL('/api/search?v=1', IDHS_API_BASE_URL)
  } catch (error) {
    console.error('Invalid IDHS base URL:', error)
    throw error
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

    return pickSoundCloudLink(parsed)
  } catch (error) {
    console.error('Failed to resolve link via IDHS:', error)
    throw error
  }
}

function isIdhsSupportedLink(rawUrl) {
  try {
    const { hostname } = new URL(rawUrl)
    return IDHS_SUPPORTED_HOSTS.some(pattern => pattern.test(hostname))
  } catch {
    return false
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

module.exports = {
  isIdhsSupportedLink,
  resolveLinkViaIdhs
}
