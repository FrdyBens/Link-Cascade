from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import os
from pydantic import BaseModel
from .storage import AppState, Link, load_state, save_state
from datetime import datetime
import requests, json
from urllib.parse import urlparse, parse_qs


app = FastAPI()

# Serve static assets (JS, CSS, etc)
app.mount("/static", StaticFiles(directory="frontend"), name="static")

# Load stored state
state: AppState = load_state()

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --------------------------------------
# ROOT → index.html
# --------------------------------------
@app.get("/")
def serve_index():
    return FileResponse(os.path.join("frontend", "index.html"))


# --------------------------------------
# NORMALIZE YOUTUBE LINK
# --------------------------------------
def normalize(url: str):
    url = url.strip()

    if "youtu.be/" in url:
        vid = url.split("youtu.be/")[1].split("?")[0]
        return f"https://www.youtube.com/watch?v={vid}"

    if "/shorts/" in url:
        vid = url.split("/shorts/")[1].split("?")[0]
        return f"https://www.youtube.com/watch?v={vid}"

    parsed = urlparse(url)
    qs = parse_qs(parsed.query)
    if "v" in qs:
        return f"https://www.youtube.com/watch?v={qs['v'][0]}"

    return None


# --------------------------------------
# METADATA SCRAPER
# --------------------------------------
def get_metadata(url):
    vid = url.split("v=")[-1]

    title = "(unknown)"
    author = "(unknown)"
    thumb = None
    avatar = None
    dur = None
    dur_s = None

    # ---- OEmbed ----
    try:
        r = requests.get(
            f"https://www.youtube.com/oembed?url=https://youtu.be/{vid}&format=json",
            timeout=4,
        )
        if r.ok:
            j = r.json()
            title = j.get("title", title)
            author = j.get("author_name", author)
    except:
        pass

    # ---- get_video_info ----
    try:
        r = requests.get(
            f"https://www.youtube.com/get_video_info?video_id={vid}&el=detailpage",
            timeout=5,
        )
        if r.ok:
            parts = dict(x.split("=") for x in r.text.split("&") if "=" in x)

            if "player_response" in parts:
                pr = json.loads(requests.utils.unquote(parts["player_response"]))
                mi = pr.get("microformat", {}).get("playerMicroformatRenderer", {})

                if mi.get("ownerChannelName"):
                    author = mi["ownerChannelName"]

                if mi.get("title"):
                    title = mi["title"]

                thumbs = mi.get("thumbnail", {}).get("thumbnails", [])
                if thumbs:
                    thumb = thumbs[-1]["url"]

                avatars = mi.get("ownerProfileImage", {}).get("thumbnails", [])
                if avatars:
                    avatar = avatars[-1]["url"]

                dur_s = mi.get("lengthSeconds")
                if dur_s:
                    dur_s = int(dur_s)
                    m = dur_s // 60
                    s = dur_s % 60
                    dur = f"{m}:{s:02d}"

    except:
        pass

    return {
        "title": title,
        "author": author,
        "thumbnail_url": thumb,
        "channel_avatar": avatar,
        "duration": dur,
        "duration_seconds": dur_s,
    }


# --------------------------------------
# BACKEND API
# --------------------------------------

@app.get("/api/draft")
def get_draft():
    return state


@app.post("/api/categories")
def add_category(name: str):
    if name not in state.categories:
        state.categories.append(name)
        save_state(state)
    return {"ok": True}


class LinkIn(BaseModel):
    url: str
    category: str


@app.post("/api/links")
def add_link(body: LinkIn):
    norm = normalize(body.url)
    if not norm:
        raise HTTPException(400, "Invalid YouTube URL")

    # Only prevent duplicates IN SAME category
    for l in state.links:
        if l.normalized_url == norm and l.category == body.category:
            raise HTTPException(409, "Duplicate in this category")

    meta = get_metadata(norm)

    link = Link(
        id=state.next_id,
        original_url=body.url,
        normalized_url=norm,
        category=body.category,
        created_at=datetime.utcnow(),
        **meta,
    )

    state.links.append(link)
    state.next_id += 1
    save_state(state)
    return link


@app.patch("/api/links/{id}/category")
def change_category(id: int, category: str):
    for l in state.links:
        if l.id == id:
            l.category = category
            save_state(state)
            return l
    raise HTTPException(404)


@app.patch("/api/links/{id}/tags")
def update_tags(id: int, payload: dict):
    for l in state.links:
        if l.id == id:
            l.tags = payload.get("tags", [])
            save_state(state)
            return l
    raise HTTPException(404)


@app.delete("/api/links/{id}")
def delete_link(id: int):
    state.links = [l for l in state.links if l.id != id]
    save_state(state)
    return {"ok": True}


@app.post("/api/save")
def save_main():
    save_state(state)
    return {"ok": True}


@app.get("/api/export/txt")
def export_txt():
    return "\n".join([l.normalized_url for l in state.links])


@app.get("/api/export/json")
def export_json():
    return [l.model_dump(mode="json") for l in state.links]
