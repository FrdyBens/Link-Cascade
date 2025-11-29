
# YouTube Link Organizer (Tailwind + Metadata)

Features:

- Drag & drop or paste YouTube URLs
- Normalizes URLs (no playlist params, no dupes)
- Fetches metadata using:
  - YouTube oEmbed API (fast, no key)
  - Fallback: `get_video_info` trick (unofficial)
- Organize into categories
- Export per-category or full list as JSON / TXT
- Tailwind UI with 3 selectable themes:
  - B — Glassmorphic
  - C — Neo Neon
  - D — TikTok Dark
- Draft auto-saved on backend, "Save Library" writes main JSON

## How to run (Python)

1. Install Python 3.10+.
2. From this folder:

```bash
pip install -r requirements.txt
python server.py
```

This will:

- Auto-install any missing Python packages (FastAPI, uvicorn, requests).
- Start the server on `http://127.0.0.1:8765/`.
- Open your browser to the app.

## How to build a single EXE (Windows)

> Note: I can't prebuild the `.exe` inside this environment, but this project
> includes a script that will build it on your machine in one step.

1. Install Python 3.10+ and `pip`.
2. Install PyInstaller:

```bash
pip install pyinstaller
```

3. From the project root, run:

```bash
build_exe.bat
```

PyInstaller will create:

- `dist/server.exe`

Double-click `server.exe`:

- It will start the FastAPI server on `127.0.0.1:8765`.
- It will open your default browser to the app automatically.
- All dependencies are bundled, so no extra installs needed.

If you run `server.py` directly with Python:

- The bootstrap will attempt to install missing dependencies automatically
  using `pip` (FastAPI, uvicorn, requests).

## Notes

- The EXE auto-installer for Python packages is *not* needed because the
  EXE already bundles dependencies. The auto-install logic is mainly for
  when running `server.py` directly with Python.
- oEmbed and get_video_info are best-effort. If metadata cannot be fetched,
  the app will still store and organize the URLs without crashing.
