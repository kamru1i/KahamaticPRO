# KahamaticPRO

**KahamaticPRO** (`com.kahamatic.pro`) is a single-panel, dark-theme **Adobe Premiere Pro CEP Extension** built with **Svelte 5 + TypeScript + Tailwind v4**, powered on macOS by a zero-dependency native **Apple Silicon Swift 6 engine** (`AVFoundation`, `Accelerate/vDSP`, `CoreText`, `CoreGraphics`) and **Google Gemini AI**.

---

## Features & Workflows

1. **Named Version Backup (`Backup` bar)**
   - Enter any label (`v1`, `v2`, `before_cuts`) and click **Save Copy**.
   - Saves `<ProjectName>_<label>.prproj` in the exact same folder as your active project while keeping Premiere Pro on your working project.
2. **Phase 1 Auto Cut (`Cut` tab)**
   - Runs Apple `vDSP_rmsqv` 10 ms RMS silence detection + micro-valley scanning directly on timeline V1 clips.
   - **AI + Silence Mode**: Packs speech into compressed AAC `.m4a` batches and uses **Gemini** (`gemini-4-hydrogen` / `gemini-3.8-flash`) to detect false starts, retakes, and filler segments (supports Bangla, Banglish, English, or Auto).
   - Optionally color-codes V1 clips (`KEEP` = Green, `SILENCE` = Cyan, `BAD TAKE` = Red).
3. **Kinetic Text on I/O (`Text I/O` tab)**
   - Mark **In (`I`)** and **Out (`O`)** on your sequence, type any Bangla or English phrase, and pick from **4 kinetic styles**:
     - `Clean Rise` (smooth upward ease + fade)
     - `Pop Bounce` (108% scale punch overshoot)
     - `Kinetic Stack` (multi-row word-by-word stack)
     - `Slide Whip` (horizontal whip entry)
   - Uses native macOS **CoreText** for accurate Bangla & Latin shaping metrics, auto-aligns words to vocal onsets, and scans rendered frames for empty space (`Auto Empty-Space Scan`) or places on a `3×3` grid across automatic free video tracks (`V2..Vn`).
4. **Crop-Safe Smooth Camera (`Camera` tab)**
   - **Manual I/O Zoom**: Click/drag anywhere on the aspect-aware Target Pad (`16:9` / `9:16` etc.) for smooth 8-step Hermite zoom punch-ins without disturbing Anchor Points or `AE.ADBE Crop` edges.
   - **Auto Slide Tracker**: Detects Red Pen / Ink annotations or slide motion deltas and generates keyframed camera pans/zooms.
   - **Reset Clip**: One-click camera transform reset at the current playhead clip.
5. **Smart Badge (`Badge` tab)**
   - Picks a transparent PNG logo/badge and places it seamlessly on the top free video track (`V7+`).
   - Supports **AUTO** collision-avoidance corner switching (avoiding both busy slide content and V2–V6 text layers) or fixed `BR` / `TL` / `TR` / `BL`.
6. **Universal Preset Profiles + Persistent User Settings**
   - Includes **Bullet Crash Course (16:9)**, **Reels / Shorts Kinetic (9:16)**, and **Talking Head Clean (YouTube)**, plus unlimited custom presets (`+ Save`).
   - Stored outside the extension bundle in `~/.kahamatic-pro/settings.json` so your Gemini API key, GitHub repo, badge PNG path, and custom presets survive `.zxp` reinstalls and auto-updates.

---

## Mac Installation (Zero Extra Dependencies)

You do **not** need Python, FFmpeg, Whisper, Node.js, or Swift installed on your Mac to use KahamaticPRO. Everything is bundled inside the extension.

### Option A — Install `.zxp` via ZXPInstaller / Anastasiy’s Extension Manager
1. Download `KahamaticPRO.zxp` from the repository’s **GitHub Releases** page.
2. Drag `KahamaticPRO.zxp` into **ZXPInstaller** to install for Adobe Premiere Pro.
3. Restart Premiere Pro and open **`Window > Extensions > KahamaticPRO`**.

*(If macOS Premiere Pro blocks unsigned debug panels during local testing, run `defaults write com.adobe.CSXS.12 PlayerDebugMode 1` — `npm run deploy:mac` does this automatically for `CSXS.9..14`.)*

### Option B — Local Windows -> Mac SSH Dev Sync
From this Windows workspace:
```bash
npm install
npm run deploy:mac
```
This builds `dist-cep/`, streams it via `tar | ssh` to `~/Library/Application Support/Adobe/CEP/extensions/com.kahamatic.pro`, and compiles `native/KahamaticHelper.swift` natively on your Mac.

---

## Settings & Gemini API Setup

1. Open the **`⚙`** Settings drawer inside **KahamaticPRO**.
2. Paste your **Gemini API Key** (`AIza...`), select `gemini-4-hydrogen` (or `gemini-3.8-flash`), and click **Test**.
3. *(Optional)* Enter your **GitHub Repository** (`owner/KahamaticPRO`) and a token if the repo is private, then click **Save Settings**.

---

## GitHub Actions Release & In-App Auto-Updater

Whenever you push a version tag:
```bash
git tag v0.2.0
git push origin v0.2.0
```
GitHub Actions (`.github/workflows/release.yml`) runs on `macos-latest`:
- Runs `npm ci && npm test && npm run build`
- Compiles `native/KahamaticHelper.swift` (`arm64-apple-macos13.0`) + ad-hoc `codesign`
- Packages `KahamaticPRO.zxp` + `KahamaticPRO-update.zip` + `latest.json` onto GitHub Releases

When Premiere Pro opens **KahamaticPRO** with internet access, it silently checks GitHub Releases in the background. When a newer tag exists, a glowing **`Update vX.Y.Z`** pill appears in the panel header — click it to download, unpack via `/usr/bin/ditto`, re-sign the helper binary, and hot-reload the panel automatically.

---

## Banglish Quick-Start (বাংলায় দ্রুত গাইড)

১. **সেটিংস (`⚙`)**: প্যানেলের ডানদিকে `⚙` এ ক্লিক করে আপনার **Gemini API Key** বসিয়ে **Test** ও **Save Settings** দিন।
২. **ব্যাকআপ (`Backup`)**: বড় কোনো কাটের আগে হেডারের **Backup** বাটনে ক্লিক করে `v1`, `v2` নাম দিয়ে কপি সেভ করে নিন — আপনি মেইন প্রজেক্টেই থাকবেন।
৩. **কাট (`Cut` ট্যাব)**: `AI + Silence` দিয়ে অপ্রয়োজনীয় নীরবতা ও ভুল টেক (Bad Takes) এক ক্লিকে কাটুন ও কালার করুন।
৪. **টেক্সট (`Text I/O` ট্যাব)**: টাইমলাইনে `I` এবং `O` মার্ক করে **`Grab I/O`** দিন, টেক্সট লিখে স্টাইল সিলেক্ট করে **`Insert Animated Text`** চাপুন।
৫. **ক্যামেরা ও ব্যাজ**: `Camera` ট্যাবে টার্গেট প্যাডে ক্লিক করে স্মুথ জুম বা Auto Red-Pen ট্র্যাক করুন, আর `Badge` ট্যাবে PNG লোগো দিয়ে অটো-কর্নার প্লেসমেন্ট চালু করুন।
