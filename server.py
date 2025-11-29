import threading
import time
import os
import sys
import webbrowser
from pathlib import Path

import uvicorn

HOST = "127.0.0.1"
PORT = 8765

WATCH_FILES = [
    Path("backend/main.py"),
    Path("backend/storage.py"),
    Path("frontend/app.js"),
    Path("frontend/index.html"),
]


def run_uvicorn():
    """
    Run the FastAPI app via uvicorn in this process
    (called in a background thread).
    """
    config = uvicorn.Config(
        "backend.main:app",
        host=HOST,
        port=PORT,
        log_level="info",
        reload=False,  # we are doing our own watch/restart
    )
    server = uvicorn.Server(config)
    server.run()


def open_browser_once():
    url = f"http://{HOST}:{PORT}/"
    print(f"[server] Opening {url}")
    try:
        webbrowser.open(url)
    except Exception:
        pass


def main():
    # start uvicorn in a separate thread
    t = threading.Thread(target=run_uvicorn, daemon=True)
    t.start()

    # give it a moment to boot before opening browser
    time.sleep(1.0)
    open_browser_once()

    # initial mtimes
    mtimes = {}
    for p in WATCH_FILES:
        if p.exists():
            mtimes[p] = p.stat().st_mtime

    print("[server] Watching for changes. Press Ctrl+C to quit.")

    try:
        while True:
            time.sleep(1.0)
            for p in WATCH_FILES:
                if not p.exists():
                    continue
                new_mtime = p.stat().st_mtime
                old_mtime = mtimes.get(p)
                if old_mtime is None:
                    mtimes[p] = new_mtime
                    continue
                if new_mtime != old_mtime:
                    print(f"\n[server] Detected change in {p}")
                    ans = input(
                        "Apply changes and restart server? [y/N]: "
                    ).strip().lower()
                    mtimes[p] = new_mtime
                    if ans == "y":
                        print("[server] Restarting with new code...")
                        # restart the entire python process (works for exe too)
                        os.execv(sys.executable, [sys.executable] + sys.argv)
                    else:
                        print("[server] Ignoring change. Continuing...")
    except KeyboardInterrupt:
        print("\n[server] Shutting down.")


if __name__ == "__main__":
    main()
