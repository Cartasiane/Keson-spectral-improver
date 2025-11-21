'use strict'

const QUALITY_VERDICTS = {
  authentic: 'Authentique',
  likely_authentic: 'Authentique (probable)',
  maybe_authentic: 'Peut-être authentique',
  maybe_fake: 'Peut-être fake',
  aac_256: 'Source AAC-256 (perte attendue)',
  sub_aac_lossy: 'Source déjà dégradée (<256 kbps)',
  likely_fake: 'Probablement fake',
  fake: 'Fake',
  unknown: 'Analyse incertaine',
  fallback: 'Analyse spectrale indisponible'
}

module.exports = {
  startIntro() {
    return 'Cc, je suis là pour que le spectre de tes tracks soit autant large que le tien!'
  },
  userIdMissing() {
    return 'Unable to verify user id.'
  },
  alreadyAuthorized() {
    return 'You are already authorized—just send a SoundCloud link!'
  },
  downloadCount(count) {
    const plural = count === 1 ? '' : 's'
    return `j'ai déjà DL ${count} track${plural}.`
  },
  conversionInProgress() {
    return 'jcherche ton lien chez les autres apps, attends bb'
  },
  conversionNotFound() {
    return "je trouve pas ce track sur soundcloud :("
  },
  invalidSoundCloudLink() {
    return 'Balance un lien soundcloud valide bb'
  },
  downloadPrep() {
    return 'exspectro partronumb'
  },
  fileTooLarge() {
    return 'Ton son est trop gros bb :( telegram a la flemmmmme'
  },
  promptPassword() {
    return 'mdp stp bb'
  },
  passwordAccepted() {
    return 'bravo t kool'
  },
  passwordRejected() {
    return 'pas le bon mdp lol'
  },
  authLimitReached() {
    return 'dsl bb c full rn, plus de place :('
  },
  notAdmin() {
    return 't pas admin bb'
  },
  broadcastUsage() {
    return 'usage: /broadcast ton message ici'
  },
  broadcastNoUsers() {
    return 'ya aucun user autorisé pour recevoir le message'
  },
  broadcastResult(sent, failed) {
    const failLine = failed ? `, ${failed} fail` : ''
    return `envoyé à ${sent} user${sent === 1 ? '' : 's'}${failLine}`
  },
  adminErrorNotice(text) {
    return `⚠️ Node error:\n${text}`
  },
  userIdResponse(id) {
    return `ton user id: ${id}`
  },
  genericError() {
    return 'dsl je trouve pas ton bail, check ton lien.'
  },
  queueFull() {
    return 'trop de demandes rn, reviens dans une minute bb'
  },
  captionDefault() {
    return 'Enjoy bb!'
  },
  captionFallback() {
    return 'enjpoy bb!'
  },
  qualityLine(text) {
    return `Qualité approx: ${text}`
  },
  qualityFallbackLabel() {
    return QUALITY_VERDICTS.fallback
  },
  qualityVerdict(key, fallbackLabel) {
    return QUALITY_VERDICTS[key] || fallbackLabel || QUALITY_VERDICTS.unknown
  },
  bitrateLine(measured, source, warning) {
    return warning || ''
  },
  bitrateDropWarning(measured, source) {
    return `⚠️ Débit estimé ${measured} kbps, l'uploader a probablement up un fichier perrave :(`
  },
  lowBitrateWarning(measured, min = 256) {
    return `⚠️ Débit estimé ${measured} kbps.`
  },
  playlistDetected(count, chunkSize, cap) {
    return `Playlist détectée (${count} titres, limite ${cap}). Je lance ${chunkSize} premiers, puis je te demande si on continue.`
  },
  playlistNoEntries() {
    return "Je n'ai trouvé aucun track dans cette playlist. (privée?)"
  },
  playlistChunkPrompt(downloaded, total, chunkSize) {
    const remaining = Math.max(total - downloaded, 0)
    const nextCount = Math.min(chunkSize, remaining)
    return `J'ai envoyé ${downloaded}/${total} titres. Continuer avec ${nextCount} de plus ?`
  },
  playlistDone() {
    return 'Playlist terminée.'
  },
  playlistStopped() {
    return 'Ok, j’arrête la playlist.'
  },
  opusOnlyMessage() {
    return 'Impossible de DL en opus bb, trouve une autre version.'
  },
  missingAudioFile() {
    return 'SoundCloud did not provide an audio file for that link. Please try another track.'
  }
}
