
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtu.be",
}

def normalize_youtube_url(url: str) -> str | None:
    """
    Normalize a YouTube URL:
    - Convert youtu.be/ID to https://www.youtube.com/watch?v=ID
    - Drop playlist-related params (list, index, etc.)
    - Keep only relevant params: v, t
    - Return normalized URL or None if not a direct video.
    """
    parsed = urlparse(url.strip())
    host = (parsed.hostname or "").lower()

    if host not in YOUTUBE_HOSTS:
        return None

    # Short link form: https://youtu.be/VIDEOID?t=123
    if "youtu.be" in host:
        video_id = parsed.path.lstrip("/")
        if not video_id:
            return None
        qs = parse_qs(parsed.query)
        new_qs = {"v": [video_id]}
        if "t" in qs:
            new_qs["t"] = [qs["t"][0]]
        normalized_query = urlencode(new_qs, doseq=True)
        return urlunparse((
            "https",
            "www.youtube.com",
            "/watch",
            "",
            normalized_query,
            ""
        ))

    # Standard YouTube URL
    qs = parse_qs(parsed.query)

    # Shorts -> watch
    if parsed.path.startswith("/shorts/"):
        video_id = parsed.path.split("/shorts/")[1].split("/")[0]
        qs = {"v": [video_id], **qs}

    if "v" not in qs:
        # probably not a direct video link (channel/playlist/etc.)
        return None

    allowed = {"v", "t"}
    filtered_qs = {}
    for key, value in qs.items():
        if key in allowed and value:
            filtered_qs[key] = [value[0]]

    normalized_query = urlencode(filtered_qs, doseq=True)

    return urlunparse((
        "https",
        "www.youtube.com",
        "/watch",
        "",
        normalized_query,
        ""
    ))

def extract_video_id_from_normalized_url(url: str) -> str | None:
    parsed = urlparse(url)
    qs = parse_qs(parsed.query)
    vals = qs.get("v")
    if not vals:
        return None
    return vals[0]
