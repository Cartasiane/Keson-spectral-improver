'use strict'

const QUALITY_LABELS = {
  lossless: '≈lossless / ≥256 kbps',
  kbps224: '≈224 kbps',
  kbps192: '≈192 kbps',
  kbps160: '≈160 kbps',
  kbps128: '≈128 kbps',
  fallback: '≤15 kHz coupure (≤96 kbps)'
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
  genericError() {
    return 'dsl je trouve pas ton bail, check ton lien.'
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
    return QUALITY_LABELS.fallback
  },
  qualityLabel(key) {
    return QUALITY_LABELS[key] || key
  },
  opusOnlyMessage() {
    return 'Impossible de DL en opus bb, trouve une autre version.'
  },
  missingAudioFile() {
    return 'SoundCloud did not provide an audio file for that link. Please try another track.'
  }
}
