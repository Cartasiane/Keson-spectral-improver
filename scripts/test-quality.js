'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { analyzeTrackQuality } = require('../src/quality')

async function main() {
  const input = process.argv[2]
  if (!input) {
    console.error('Usage: node scripts/test-quality.js <audio-file>')
    process.exit(1)
  }

  const filePath = path.resolve(process.cwd(), input)
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`)
    process.exit(1)
  }

  const result = await analyzeTrackQuality(filePath, null)
  console.log(JSON.stringify(result, null, 2))
}

main().catch(error => {
  console.error('Analysis failed:', error)
  process.exit(1)
})
