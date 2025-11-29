
from pydantic import BaseModel, HttpUrl
from typing import Optional, List
from datetime import datetime

class LinkCreate(BaseModel):
    url: HttpUrl
    category: str

class Link(BaseModel):
    id: int
    original_url: HttpUrl
    normalized_url: HttpUrl
    category: str
    title: Optional[str] = None
    author: Optional[str] = None
    thumbnail_url: Optional[HttpUrl] = None
    created_at: datetime

class AppState(BaseModel):
    links: List[Link] = []
    categories: List[str] = ["Unsorted"]
    next_id: int = 1
