#!/usr/bin/env python3
import base64
import json
import os
import sys
import tempfile
import urllib.request
from typing import Dict, List, Tuple

TARGET_URL = sys.argv[1] if len(sys.argv) > 1 else "https://youtu.be/YtDI-dXfP5Q"


def load_local_env() -> None:
    env_path = os.path.join(os.getcwd(), ".env")
    if not os.path.exists(env_path):
        return

    with open(env_path, "r", encoding="utf-8") as file:
        for raw_line in file:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue

            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()

            if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                value = value[1:-1]

            if key and key not in os.environ:
                os.environ[key] = value


def resolve_cookie_json_text() -> str | None:
    file_path = os.environ.get("YOUTUBE_COOKIES_FILE", "").strip()
    if file_path:
        abs_path = file_path if os.path.isabs(file_path) else os.path.join(os.getcwd(), file_path)
        if os.path.exists(abs_path):
            with open(abs_path, "r", encoding="utf-8") as file:
                return file.read()

    raw_json = os.environ.get("YOUTUBE_COOKIES_JSON", "").strip()
    if raw_json:
        return raw_json

    raw_b64 = os.environ.get("YOUTUBE_COOKIES_BASE64", "").strip()
    if raw_b64:
        try:
            return base64.b64decode(raw_b64).decode("utf-8")
        except Exception:  # noqa: BLE001
            return None

    return None


def parse_cookie_list() -> List[Dict[str, object]]:
    raw_text = resolve_cookie_json_text()
    if not raw_text:
        return []

    try:
        parsed = json.loads(raw_text)
    except Exception:  # noqa: BLE001
        return []

    if not isinstance(parsed, list):
        return []

    cookies: List[Dict[str, object]] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        value = item.get("value")
        if not isinstance(name, str) or not isinstance(value, str):
            continue
        cookies.append(item)

    return cookies


def to_netscape_cookie_line(cookie: Dict[str, object]) -> str:
    domain_raw = str(cookie.get("domain") or ".youtube.com").strip()
    domain = domain_raw if domain_raw.startswith(".") else f".{domain_raw}"
    include_subdomains = "TRUE" if domain.startswith(".") else "FALSE"
    path_value = str(cookie.get("path") or "/").strip() or "/"
    secure = "TRUE" if bool(cookie.get("secure")) else "FALSE"
    expiration = cookie.get("expirationDate")
    expires_epoch = int(expiration) if isinstance(expiration, (int, float)) and expiration > 0 else 0
    name = str(cookie.get("name") or "").replace("\t", "").replace("\r", "").replace("\n", "")
    value = str(cookie.get("value") or "").replace("\t", "").replace("\r", "").replace("\n", "")
    return "\t".join([domain, include_subdomains, path_value, secure, str(expires_epoch), name, value])


def build_cookie_file_for_ytdlp() -> str | None:
    cookies = parse_cookie_list()
    if not cookies:
        return None

    lines = ["# Netscape HTTP Cookie File"]
    lines.extend(to_netscape_cookie_line(cookie) for cookie in cookies)
    lines.append("")

    temp = tempfile.NamedTemporaryFile(prefix="yt-test-cookies-", suffix=".txt", delete=False)
    temp.write("\n".join(lines).encode("utf-8"))
    temp.close()
    return temp.name


def fetch_first_bytes(url: str, headers: Dict[str, str] | None = None, size: int = 2048) -> Tuple[bool, str]:
    req_headers = {
        "Range": f"bytes=0-{size - 1}",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    }
    if headers:
        req_headers.update({k: str(v) for k, v in headers.items()})

    request = urllib.request.Request(url, headers=req_headers)

    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = response.read(size)
            if data:
                return True, f"mulai download ({len(data)} bytes terbaca)"
            return False, "response kosong"
    except Exception as error:  # noqa: BLE001
        return False, str(error)


def test_yt_dlp_api() -> Tuple[bool, str]:
    try:
        import yt_dlp  # type: ignore
    except Exception as error:  # noqa: BLE001
        return False, f"yt_dlp tidak tersedia: {error}"

    ydl_opts = {
        "quiet": True,
        "noplaylist": True,
        "skip_download": True,
        "extractor_args": {
            "youtube": {
                "player_client": ["android", "ios", "tv", "web"],
            }
        },
    }

    proxy = os.environ.get("YOUTUBE_PROXY_URL", "").strip()
    if proxy:
        ydl_opts["proxy"] = proxy

    js_runtime = os.environ.get("YTDLP_JS_RUNTIME", "").strip() or "node"
    ydl_opts["js_runtimes"] = [js_runtime]

    cookie_file = build_cookie_file_for_ytdlp()
    if cookie_file:
        ydl_opts["cookiefile"] = cookie_file

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(TARGET_URL, download=False)

        media_url = None
        media_headers: Dict[str, str] = {}

        if isinstance(info, dict):
            media_url = info.get("url")
            media_headers = info.get("http_headers") or {}

            if not media_url:
                requested = info.get("requested_formats") or []
                if requested and isinstance(requested, list):
                    first = requested[0]
                    if isinstance(first, dict):
                        media_url = first.get("url")
                        media_headers = first.get("http_headers") or media_headers

                if not media_url:
                    formats = info.get("formats") or []
                    if formats and isinstance(formats, list):
                        for item in formats:
                            if isinstance(item, dict) and item.get("url"):
                                media_url = item.get("url")
                                media_headers = item.get("http_headers") or media_headers
                                break

        if not media_url:
            return False, "tidak dapat URL media dari yt_dlp"

        return fetch_first_bytes(str(media_url), media_headers)
    except Exception as error:  # noqa: BLE001
        return False, str(error)
    finally:
        if cookie_file and os.path.exists(cookie_file):
            os.remove(cookie_file)


def test_pytube() -> Tuple[bool, str]:
    try:
        from pytube import YouTube  # type: ignore
    except Exception as error:  # noqa: BLE001
        return False, f"pytube tidak tersedia: {error}"

    try:
        yt = YouTube(TARGET_URL)
        stream = (
            yt.streams.filter(progressive=True, file_extension="mp4")
            .order_by("resolution")
            .desc()
            .first()
        )

        if stream is None:
            return False, "stream progressive mp4 tidak ditemukan"

        return fetch_first_bytes(stream.url)
    except Exception as error:  # noqa: BLE001
        return False, str(error)


def main() -> int:
    load_local_env()

    tests: List[Tuple[str, Tuple[bool, str]]] = [
        ("python/yt_dlp_api", test_yt_dlp_api()),
        ("python/pytube", test_pytube()),
    ]

    print(f"URL: {TARGET_URL}")
    print("--- HASIL TEST PYTHON DOWNLOADER ---")

    for name, (ok, reason) in tests:
        status = "PASS" if ok else "FAIL"
        print(f"{status} {name} -> {reason}")

    for name, (ok, _reason) in tests:
        if ok:
            print(f"REKOMENDASI: pakai {name} (sudah terbukti mulai download).")
            return 0

    print("REKOMENDASI: belum ada Python downloader yang bisa mulai download dari environment/IP ini.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
