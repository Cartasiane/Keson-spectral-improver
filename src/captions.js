'use strict'

const messages = require('./messages')

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
  // Avoid duplicating warning text in caption; it is sent separately.
  if (qualityInfo.warning && qualityInfo.text === qualityInfo.warning) {
    return caption
  }
  return `${caption}\n${messages.qualityLine(qualityInfo.text)}`
}

module.exports = {
  appendQuality,
  buildCaption
}
