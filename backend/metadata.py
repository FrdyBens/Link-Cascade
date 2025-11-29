
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
        micro = player.get("microformat", {}).get("playerMicroformatRenderer", {})
        title = video_details.get("title")
        author = video_details.get("author")
        # thumbnails
        thumb_url = None
        thumbs = video_details.get("thumbnail", {}).get("thumbnails") or []
        if thumbs:
            # pick highest resolution
            thumb_url = thumbs[-1].get("url")
        duration_seconds = None
        if video_details.get("lengthSeconds"):
            try:
                duration_seconds = int(video_details.get("lengthSeconds"))
            except Exception:
                duration_seconds = None
        channel_avatar = None
        avatars = micro.get("ownerProfileImage", {}).get("thumbnails") or []
        if avatars:
            channel_avatar = avatars[-1].get("url")
        publish_date = micro.get("publishDate")
        video_type = "short" if "shorts" in micro.get("availableCountries", []) else None
        return {
            "title": title,
            "author": author,
            "thumbnail_url": thumb_url,
            "duration_seconds": duration_seconds,
            "publish_date": publish_date,
            "video_type": video_type,
            "channel_avatar": channel_avatar,
        }
    except Exception:
        return None

def get_metadata_for_video(original_url: str, normalized_url: str) -> Dict[str, Optional[str]]:
    """Best-effort metadata pull using oEmbed then get_video_info."""
    meta: Dict[str, Any] = {
        "title": None,
        "author": None,
        "thumbnail_url": None,
        "duration": None,
        "duration_seconds": None,
        "publish_date": None,
        "video_type": None,
        "channel_avatar": None,
    }

    oembed = fetch_oembed(normalized_url)
    if oembed:
        meta["title"] = oembed.get("title")
        meta["author"] = oembed.get("author_name")
        meta["thumbnail_url"] = oembed.get("thumbnail_url")

    vid = extract_video_id_from_normalized_url(normalized_url)
    if not vid:
        return meta

    info = fetch_video_info(vid) or {}
    meta["title"] = info.get("title") or meta.get("title")
    meta["author"] = info.get("author") or meta.get("author")
    meta["thumbnail_url"] = info.get("thumbnail_url") or meta.get("thumbnail_url")
    meta["duration_seconds"] = info.get("duration_seconds")
    if meta["duration_seconds"]:
        dur_s = meta["duration_seconds"]
        meta["duration"] = f"{dur_s // 60}:{dur_s % 60:02d}"
    meta["publish_date"] = info.get("publish_date")
    meta["video_type"] = info.get("video_type")
    meta["channel_avatar"] = info.get("channel_avatar")

    return meta
