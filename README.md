# Emulingo

**Play Game Boy games and learn a language.**

Emulingo is a web app that runs retro games (Game Boy / GBC / GBA and more) in your browser and turns the game's text into a live language lesson. It watches the game screen with OCR, translates the dialogue, pronounces it, and collects vocabulary into a spaced-repetition flashcard deck - Duolingo-style, but you learn by actually playing.

> Like the original "Emulingo" concept: you supply your own legally obtained ROM, the app does the rest.

## Features

- 🎮 **Built-in emulator** (EmulatorJS): GB, GBC, GBA, NES, SNES, Genesis, NDS. Keyboard + gamepad supported.
- 💾 **Game saves** - full save states (💾 Save / 📂 Load, auto-saved every 60 s and restored when you return to a game) plus battery-SRAM flushing so in-game saves (Pokémon "Save" menu) persist across sessions.
- 🌍 **Any language pair** - 28 languages, cross-translate any direction (e.g. German game → English, or Spanish → French).
- 🔍 **Live OCR translation** - detects every text region on screen (dialog boxes, menus, battle text, HP plates, clock screens), reads them all, spell-corrects OCR misreads against a real dictionary and translates each region separately (Tesseract.js + Hunspell/nspell + translation engine chain).
- 📖 **Dictionary** - every word and sentence you encounter is recorded with its translation; searchable, with on-demand lookup for unseen words and one-tap speak/add-to-deck.
- 🖱 **Tap-to-look-up** - tap any word in the live translation panel for an instant dictionary popup.
- 🎧 **Text-to-speech** - every translation is pronounced with the Web Speech API (adjustable speed and voice).
- 🃏 **Spaced-repetition flashcards** - tap "+ Flashcard" or enable auto-collect; SM-2-style scheduler with due queue, mature-card tracking and daily streak.
- 🧠 **Review mode** - flashcard sessions with Again/Good/Easy grading.
- 📊 **Progress tracking** - weekly activity chart, deck stats, dictionary stats, CSV export.
- 💽 **Backup & restore** - one-click JSON export/import of your deck, dictionary, history and settings.
- 🕹 **ROM library** - your ROMs are stored locally in your browser (IndexedDB); nothing is ever uploaded.
- 📱 **PWA** - installable, works offline for cached parts, responsive layout for tablets/phones.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173, then:

1. Go to **Play** and drop in a legally obtained ROM (`.gb`, `.gbc`, `.gba`, ...).
2. In **Settings**, set the *game language* (what the ROM text is written in) and the language to translate to.
3. Play! Dialogue appears in the live-translation panel on the right; flashcards are collected automatically.

For production hosting:

```bash
npm run build   # outputs dist/
npm run preview # serve the build locally
```

## Hosting on GitHub Pages

Yes, GitHub Pages works perfectly - Emulingo is a **fully static, client-side app** (no server, no database). All paths are relative, so it works from a subpath like `username.github.io/emulingo/`.

To deploy:

1. Create a GitHub repository and push this project to it (the included `.github/workflows/deploy.yml` handles the build).
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push to `main` (or run the workflow manually). Your app goes live at `https://<user>.github.io/<repo>/`.

Notes:
- Nothing problematic is hosted: the app ships no ROMs - users supply their own legally obtained game files, which stay on their device.
- Works the same on any other static host (Netlify, Vercel, Cloudflare Pages, etc.) - just serve the `dist/` folder.
- The ROM library, save states, flashcards and dictionary are per-device (IndexedDB/localStorage), so progress does not sync between devices - use **Settings → Export backup** to move progress manually.

## Mobile

Emulingo is designed to work well on phones and tablets:

- **Installable PWA** - "Add to Home Screen" on Android (Chrome) and iOS (Safari) launches it fullscreen like a native app.
- EmulatorJS shows its **virtual gamepad** automatically on touch devices.
- Layout, tab bar, buttons and inputs are sized for touch (44px targets, no iOS input zoom, safe-area aware for notched phones).
- **Battery saver**: OCR pauses automatically when the app is backgrounded, scan interval defaults are gentler on touch devices, and the game canvas renders with crisp pixel scaling.
- One iOS quirk: automatic background pronunciation may stay silent until you tap the screen once (Apple requires a user gesture before audio).

## How the translation loop works

1. Every ~1.2 s the game canvas is snapshotted (the emulator canvas is preserved).
2. A multi-region detector finds all text areas on screen - light boxes with dark text, tall START-menu columns and dark GBA battle boxes with light text (validated against Pokémon Crystal/GS and FireRed/Emerald reference screenshots). You can also drag a custom region with **Zone: Manual**.
3. The regions are upscaled in two stages and grayscaled, then read by a Tesseract worker in the target ROM language. Unchanged regions are cached and skipped.
4. Identical frames are skipped; text must appear stable for N scans before translating (reduces noise).
5. OCR misreads are spell-corrected against a Hunspell dictionary for the game language (candidate generation + dictionary check; never rewrites a word unless a single unambiguous dictionary word fits). Dictionaries download once per language (~1 MB) and are cached in IndexedDB. Toggle in Settings → OCR → "Fix OCR misreads".
6. Each region is translated separately (Google translate endpoints first, MyMemory as fallback - all keyless; cached in localStorage) and shown as its own row in the live panel, spoken via TTS, and optionally saved as a flashcard.

## Important notes

- **ROMs are not included.** Only use games you legally own.
- **Internet is required** at runtime for the emulator core, OCR language data, translations and speech voices (all fetched/loaded from CDNs and free APIs).
- **Best in Chrome/Edge** - the widest TTS voice selection. Firefox works but has fewer built-in voices.
- OCR works best on games with clear bitmap fonts (Pokémon, Zelda, classic RPGs). Cursive/stylized fonts may need the manual zone tool.

## Tech stack

- Vite + vanilla ES modules (no framework)
- EmulatorJS (emulator core, loaded from CDN)
- Tesseract.js (OCR, loaded from CDN)
- Hunspell dictionaries + nspell (OCR spell-correction, loaded from CDN)
- Google Translate public endpoints + MyMemory (translation chain, no API keys)
- Web Speech API (TTS)
- Service worker + PWA manifest

## Privacy

Everything - ROMs, flashcards, history, settings, caches - lives in your browser's storage. There is no server, no account and no tracking. "Erase everything" in Settings wipes it all.

## Roadmap

- Android app (Capacitor wrapper) - planned once the web app is polished.
- Anki `.apkg` export.
- Better auto-detection for multi-language ROM patches.
- Offline translation fallback.
