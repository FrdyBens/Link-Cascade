
import json
from typing import Optional, Dict, Any
import requests
from .youtube_utils import extract_video_id_from_normalized_url

OEMBED_ENDPOINT = "https://www.youtube.com/oembed"
GET_VIDEO_INFO_ENDPOINT = "https://www.youtube.com/get_video_info"

def fetch_oembed(url: str) -> Optional[Dict[str, Any]]:
    try:
        resp = requests.get(OEMBED_ENDPOINT, params={"url": url, "format": "json"}, timeout=5)
        if resp.status_code != 200:
            return None
        return resp.json()
    except Exception:
        return None

def fetch_video_info(video_id: str) -> Optional[Dict[str, Any]]:
    """
    Unofficial, may break if YouTube changes things.
    Tries to parse basic metadata (title, author, thumbnail).
    """
    try:
        resp = requests.get(GET_VIDEO_INFO_ENDPOINT, params={"video_id": video_id, "el": "detailpage"}, timeout=5)
        if resp.status_code != 200:
            return None
        from urllib.parse import parse_qs
        data = parse_qs(resp.text)
        player_resp_list = data.get("player_response")
        if not player_resp_list:
            return None
        player = json.loads(player_resp_list[0])
        video_details = player.get("videoDetails") or {}
        title = video_details.get("title")
        author = video_details.get("author")
        # thumbnails
        thumb_url = None
        thumbs = video_details.get("thumbnail", {}).get("thumbnails") or []
        if thumbs:
            # pick highest resolution
            thumb_url = thumbs[-1].get("url")
        return {
            "title": title,
            "author": author,
            "thumbnail_url": thumb_url,
        }
    except Exception:
        return None

def get_metadata_for_video(original_url: str, normalized_url: str) -> Dict[str, Optional[str]]:
    """
    Try fast oEmbed first, then fallback to get_video_info.
    Returns a dict with title, author, thumbnail_url (or None).
    """
    meta = {
        "title": None,
        "author": None,
        "thumbnail_url": None,
    }

    oembed = fetch_oembed(normalized_url)
    if oembed:
        meta["title"] = oembed.get("title")
        meta["author"] = oembed.get("author_name")
        meta["thumbnail_url"] = oembed.get("thumbnail_url")
        return meta

    # fallback: get_video_info
    vid = extract_video_id_from_normalized_url(normalized_url)
    if not vid:
        return meta

    info = fetch_video_info(vid)
    if info:
        meta["title"] = info.get("title")
        meta["author"] = info.get("author")
        meta["thumbnail_url"] = info.get("thumbnail_url")

    return meta
