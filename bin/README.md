# bin/: ErsatzTV next and ffmpeg go here

This folder holds the programs that do the actual streaming: ErsatzTV next
(`ersatztv`, `ersatztv-channel`, `ersatztv-playout-generator`) and ErsatzTV's own
ffmpeg build (`ffmpeg`, `ffprobe`, plus `libvpl` for Intel Quick Sync). They
aren't in the repo; the scheduler downloads them.

## Installing or updating

1. Start the scheduler (`npm run server`) and open **Streaming** in the web UI.
2. Under **Programs**, click **Update both** (or **Install** on each row). It
   downloads the latest tagged release of each from GitHub, checks it against
   GitHub's checksum, unpacks it here, and points the ffmpeg/ffprobe paths at
   these files.
3. Turn on **Keep ErsatzTV next running**. If it was already running, the update
   restarts it onto the new build by itself.
4. **Troubleshooting → Hardware encoders** checks whether your GPU encoder works
   with the new ffmpeg.

Come back to **Programs** any time; it shows the installed and latest versions and
offers **Update** when a newer release is out. Updating works while channels are
playing: files in use are renamed to `*.old` and deleted on the next update.

Downloads come from:

- ErsatzTV next: https://github.com/ErsatzTV/next/releases
- ErsatzTV-ffmpeg: https://github.com/ErsatzTV/ErsatzTV-ffmpeg/releases

The builds for Windows x64, Linux (x64, arm64) and macOS are picked automatically.
To use a different build, copy it here by hand (or set its paths on the Streaming
page); everything in this folder except this README is ignored by git.
