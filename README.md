# Keson Spectral Improver

Telegram bot built with [grammY](https://grammy.dev/) that accepts a SoundCloud URL, downloads the track via `yt-dlp` using an OAuth token (preferring the `http_aac_1_0` audio profile or the original file when available), and sends the audio file back to the user. Brand-new users must unlock the bot with a password (or a list of passwords, one per 25-user block) before they can request downloads.

## Requirements
- Node.js 18+
- Telegram bot token (from @BotFather)
- SoundCloud OAuth token (grab the `oauth_token` value from logged-in browser requests or cookies)
- [FFmpeg](https://ffmpeg.org/) available on the host `PATH` (needed for embedding metadata & cover art). `ffprobe` must also be available for the spectral analysis decode step.

## Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the environment template and fill it out:
   ```bash
   cp .env.example .env
   ```
   - `BOT_TOKEN`: Telegram bot token.
   - `SOUNDCLOUD_OAUTH_TOKEN`: OAuth token to authenticate `yt-dlp` requests against SoundCloud (format: `1-123456-abcdef...`). You can also set `SOUNDCLOUD_OAUTH` if you already have that env var in another system.
   - `BOT_PASSWORDS`: Comma-separated list of passwords, one per 25 authorized users (e.g., `firstBatch,nextBatch`). The bot uses the next password every time a block of 25 new users is filled. If you prefer a single password, `BOT_PASSWORD` is still supported as shorthand for the first 25 users only.
   - *(optional)* `YT_DLP_BINARY_PATH`: Absolute path to a pre-installed `yt-dlp` binary if you do not want the app to download one automatically.
   - *(optional)* `MAX_CONCURRENT_DOWNLOADS`: Limit how many yt-dlp jobs can run at once (default: `3`).
   - *(optional)* `MAX_PENDING_DOWNLOADS`: Maximum queued download jobs waiting for a worker before new requests are rejected (default: `25`).
  - *(optional)* `ENABLE_QUALITY_ANALYSIS`: Set to `false` to skip the built-in Fake Lossless Checker port entirely (enabled by default).
  - *(optional)* `FFMPEG_PATH`: Absolute path to the ffmpeg binary to use for decoding/loudness (default: `ffmpeg`).
  - *(optional)* `FFPROBE_PATH`: Absolute path to ffprobe when it is not on `PATH` (default: `ffprobe`).
  - *(optional)* `QUALITY_ANALYSIS_DEBUG`: Set to `true` to emit verbose console logs for every spectral probe (useful when the caption is missing quality info).
   - *(optional)* `YT_DLP_SKIP_CERT_CHECK`: Set to `true` only if you must temporarily bypass TLS certificate validation for `yt-dlp` (e.g., corporate MITM proxy). Defaults to `false` for safety.

## Run the bot
```bash
npm start
```
The bot runs in long-polling mode and logs startup info to the console.

## Usage
- `/start` – displays quick instructions and, if needed, prompts for the shared password.
- Reply to the password prompt with the active secret. Passwords advance every 25 new users; if no further passwords are configured the bot will politely say it’s full.
- Send a public SoundCloud track/playlist URL (only the first entry of playlists is fetched). The bot enforces the `http_aac_1_0` format and falls back to the best/original file when that profile is missing. The resulting audio is sent back as a document with the track metadata + cover art embedded.

## Notes & troubleshooting
- Telegram bots can only send files up to 50 MB (server-side limit). The bot now checks file size before uploading and will warn you when the limit is exceeded.
- The first time the bot runs it automatically downloads the appropriate stand-alone `yt-dlp` binary for your OS/architecture and caches it in `bin/`. If you prefer to ship your own executable, set `YT_DLP_BINARY_PATH` to point to it.
- Authorized user IDs are persisted to `data/authorized-users.json`, so unlocking survives restarts. Delete the file if you need to revoke all users quickly.
- Concurrency is capped by `MAX_CONCURRENT_DOWNLOADS`; bump it up (e.g., `5`) only if your host has the bandwidth/CPU for multiple yt-dlp processes.
- Requests beyond `MAX_PENDING_DOWNLOADS` are rejected immediately with a friendly "queue is full" response so the bot cannot be overwhelmed while long transfers are active.
- Spectral quality hints rely on ffmpeg/ffprobe to decode PCM audio and run the Fake Lossless Checker logic inside Node.js, which can take noticeable CPU time. Set `ENABLE_QUALITY_ANALYSIS=false` if you prefer to skip this extra processing, and use `QUALITY_ANALYSIS_DEBUG=true` to troubleshoot missing captions without enabling debug logs globally.
- FFmpeg is required for embedding album art/metadata. If it’s missing, yt-dlp falls back to plain downloads and the bot will log warnings; install it via `brew install ffmpeg`, `apt install ffmpeg`, etc.
