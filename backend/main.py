import asyncio
import os
import time
from collections import deque
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from datetime import datetime

from .metadata import get_metadata_for_video
from .storage import AppState, Link, load_state, save_state
from .youtube_utils import normalize_youtube_url, extract_video_id_from_normalized_url

app = FastAPI(title="LinkCascade")

# Serve static assets (JS, CSS)
app.mount("/static", StaticFiles(directory="frontend"), name="static")

state: AppState = load_state()

# Rate limit tracking
per_second: deque = deque()
per_minute: deque = deque()
metadata_queue: asyncio.Queue[int] = asyncio.Queue()
worker_task: Optional[asyncio.Task] = None

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class LinkIn(BaseModel):
    url: str
    category: str
    tags: Optional[List[str]] = None
    allow_duplicate: bool = False


class CategoryIn(BaseModel):
    name: str
    pinned: bool = False


class ConfigUpdate(BaseModel):
    rate_limit_per_second: Optional[int] = None
    rate_limit_per_minute: Optional[int] = None
    duplicate_policy: Optional[str] = None
    category_order_strategy: Optional[str] = None
    default_category: Optional[str] = None


async def respect_rate_limits():
    now = time.time()
    # Clean old timestamps
    while per_second and now - per_second[0] > 1:
        per_second.popleft()
    while per_minute and now - per_minute[0] > 60:
        per_minute.popleft()

    if len(per_second) >= state.config.rate_limit_per_second:
        await asyncio.sleep(0.05)
        return await respect_rate_limits()

    if len(per_minute) >= state.config.rate_limit_per_minute:
        await asyncio.sleep(0.1)
        return await respect_rate_limits()

    per_second.append(now)
    per_minute.append(now)


async def metadata_worker():
    while True:
        link_id = await metadata_queue.get()
        link = next((l for l in state.links if l.id == link_id), None)
        if not link:
            continue

        link.metadata_status = "fetching"
        _update_queue_status(link_id, "fetching")
        save_state(state)

        await respect_rate_limits()

        try:
            meta = await asyncio.get_event_loop().run_in_executor(
                None, get_metadata_for_video, link.original_url, link.normalized_url
            )
            link.title = meta.get("title") or link.title
            link.author = meta.get("author") or link.author
            link.thumbnail_url = meta.get("thumbnail_url") or link.thumbnail_url
            link.duration = meta.get("duration") or link.duration
            link.duration_seconds = meta.get("duration_seconds") or link.duration_seconds
            link.publish_date = meta.get("publish_date") or link.publish_date
            link.video_type = meta.get("video_type") or link.video_type
            link.channel_avatar = meta.get("channel_avatar") or link.channel_avatar
            link.last_refreshed = datetime.utcnow()
            link.metadata_status = "done"
            _update_queue_status(link_id, "done")
        except Exception:
            link.metadata_status = "failed"
            _update_queue_status(link_id, "failed")
        finally:
            save_state(state)
            metadata_queue.task_done()


def _update_queue_status(link_id: int, status: str):
    for item in state.queue:
        if item.get("link_id") == link_id:
            item["status"] = status
            break


@app.on_event("startup")
async def startup_event():
    global worker_task
    # hydrate queue from pending links
    for l in state.links:
        if l.metadata_status in {"pending", "failed"}:
            await metadata_queue.put(l.id)
            state.queue.append({"link_id": l.id, "status": "waiting", "url": l.normalized_url})
    worker_task = asyncio.create_task(metadata_worker())


@app.on_event("shutdown")
async def shutdown_event():
    if worker_task:
        worker_task.cancel()


@app.get("/")
def serve_index():
    return FileResponse(os.path.join("frontend", "index.html"))


@app.get("/api/draft")
def get_draft():
    return state


@app.post("/api/categories")
def add_category(payload: CategoryIn):
    name = payload.name.strip()
    if not name:
        raise HTTPException(400, "Name required")
    if name not in state.categories:
        state.categories.append(name)
    if payload.pinned and name not in state.config.pinned_categories:
        state.config.pinned_categories.append(name)
    save_state(state)
    return {"ok": True, "categories": state.categories}


@app.post("/api/config")
def update_config(payload: ConfigUpdate):
    if payload.rate_limit_per_second:
        state.config.rate_limit_per_second = payload.rate_limit_per_second
    if payload.rate_limit_per_minute:
        state.config.rate_limit_per_minute = payload.rate_limit_per_minute
    if payload.duplicate_policy:
        state.config.duplicate_policy = payload.duplicate_policy
    if payload.category_order_strategy:
        state.config.category_order_strategy = payload.category_order_strategy
    if payload.default_category:
        state.config.default_category = payload.default_category
    save_state(state)
    return state.config


@app.get("/api/config")
def get_config():
    return state.config


@app.post("/api/links")
async def add_link(body: LinkIn):
    norm = normalize_youtube_url(body.url)
    if not norm:
        raise HTTPException(400, "Invalid YouTube URL")

    existing = next((l for l in state.links if l.normalized_url == norm), None)
    if existing:
        if body.category in existing.categories and state.config.duplicate_policy == "block_category" and not body.allow_duplicate:
            raise HTTPException(409, "Duplicate in this category")
        if body.category not in existing.categories:
            existing.categories.append(body.category)
        if not existing.primary_category:
            existing.primary_category = body.category
        save_state(state)
        return {"link": existing, "duplicate": True}

    link = Link(
        id=state.next_id,
        original_url=body.url,
        normalized_url=norm,
        categories=[body.category],
        primary_category=body.category,
        tags=body.tags or [],
    )

    state.links.insert(0, link)
    state.next_id += 1
    state.queue.append({"link_id": link.id, "status": "waiting", "url": norm})
    await metadata_queue.put(link.id)
    save_state(state)
    return {"link": link, "duplicate": False}


@app.patch("/api/links/{id}/category")
async def change_category(id: int, category: str):
    link = next((l for l in state.links if l.id == id), None)
    if not link:
        raise HTTPException(404)
    if category not in link.categories:
        link.categories.append(category)
    link.primary_category = category
    save_state(state)
    return link


@app.patch("/api/links/{id}/tags")
async def update_tags(id: int, payload: dict):
    link = next((l for l in state.links if l.id == id), None)
    if not link:
        raise HTTPException(404)
    link.tags = payload.get("tags", [])
    save_state(state)
    return link


@app.get("/api/queue")
def queue_status():
    return state.queue


@app.get("/api/search")
def advanced_search(q: str = "", category: str = "", tag: str = ""):
    res = []
    query = q.lower()
    for l in state.links:
        if category and category not in l.categories:
            continue
        if tag and tag not in (l.tags or []):
            continue
        text = " ".join(
            [
                l.title or "",
                l.author or "",
                l.normalized_url,
                " ".join(l.tags or []),
                " ".join(l.categories or []),
            ]
        ).lower()
        if query in text:
            res.append(l)
    return {"results": res, "count": len(res)}


@app.get("/api/export/json")
def export_json():
    return state


@app.get("/api/export/txt")
def export_txt():
    lines = [link.normalized_url for link in state.links]
    return "\n".join(lines)


@app.get("/api/export/yt-dlp")
def export_for_ytdlp():
    payload = {
        "entries": [
            {
                "url": l.normalized_url,
                "title": l.title,
                "channel": l.author,
                "duration": l.duration_seconds,
                "categories": l.categories,
                "tags": l.tags,
            }
            for l in state.links
        ]
    }
    return payload


@app.post("/api/save")
def persist_state():
    save_state(state)
    return {"ok": True}


@app.delete("/api/links/{id}")
async def delete_link(id: int):
    global state
    before = len(state.links)
    state.links = [l for l in state.links if l.id != id]
    if len(state.links) == before:
        raise HTTPException(404)
    save_state(state)
    return {"ok": True}
