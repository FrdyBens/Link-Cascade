import json
from pathlib import Path
from pydantic import BaseModel
from typing import List
from datetime import datetime

STATE_FILE = Path("draft_state.json")


class Link(BaseModel):
    id: int
    original_url: str
    normalized_url: str
    category: str
    title: str | None = None
    author: str | None = None
    thumbnail_url: str | None = None
    channel_avatar: str | None = None
    duration: str | None = None
    duration_seconds: int | None = None
    tags: list[str] = []
    created_at: datetime = datetime.utcnow()


class AppState(BaseModel):
    next_id: int = 1
    categories: List[str] = ["Unsorted"]
    links: List[Link] = []


def load_state() -> AppState:
    if not STATE_FILE.exists():
        return AppState()
    with open(STATE_FILE, "r") as f:
        data = json.load(f)
    return AppState.model_validate(data)


def save_state(state: AppState):
    STATE_FILE.write_text(
        json.dumps(state.model_dump(mode="json"), indent=2)
    )
