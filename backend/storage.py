import json
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Dict, Any
from datetime import datetime

STATE_FILE = Path("draft_state.json")


class Link(BaseModel):
    id: int
    original_url: str
    normalized_url: str
    categories: List[str] = Field(default_factory=list)
    primary_category: str = "Unsorted"
    title: str | None = None
    author: str | None = None
    thumbnail_url: str | None = None
    channel_avatar: str | None = None
    duration: str | None = None
    duration_seconds: int | None = None
    publish_date: str | None = None
    video_type: str | None = "normal"
    tags: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_refreshed: datetime | None = None
    metadata_status: str = "pending"  # pending | fetching | done | failed
    manual_order: int | None = None


class Config(BaseModel):
    rate_limit_per_second: int = 20
    rate_limit_per_minute: int = 150
    duplicate_policy: str = "block_category"  # block_category | warn_global | allow_all
    category_order_strategy: str = "recent"  # recent | alphabetical | most_items | pinned_first
    pinned_categories: List[str] = Field(default_factory=list)
    default_category: str = "Unsorted"
    view_defaults: Dict[str, Any] = Field(
        default_factory=lambda: {
            "columns": 5,
            "viewMode": "grid",
            "sortMode": "newest",
        }
    )


class AppState(BaseModel):
    next_id: int = 1
    categories: List[str] = ["Unsorted"]
    links: List[Link] = Field(default_factory=list)
    config: Config = Field(default_factory=Config)
    queue: List[Dict[str, Any]] = Field(default_factory=list)


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
