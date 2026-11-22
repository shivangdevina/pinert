"""Explicit frontend origins for a static Vercel client calling Render directly."""

import os
from urllib.parse import urlsplit
from fastapi.middleware.cors import CORSMiddleware
from .database import load_environment


def frontend_origins(raw):
    origins = []
    for value in raw.split(","):
        origin = value.strip().rstrip("/")
        if not origin:
            continue
        try:
            parsed = urlsplit(origin)
            local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
            valid = (parsed.hostname and "*" not in origin and not parsed.username and not parsed.password
                     and not parsed.path and not parsed.query and not parsed.fragment
                     and (parsed.scheme == "https" or (parsed.scheme == "http" and local)))
            parsed.port  # Also reject malformed port numbers.
        except ValueError:
            valid = False
        if not valid:
            raise ValueError("FRONTEND_ORIGINS must contain exact HTTPS origins, or explicit localhost HTTP origins.")
        if origin not in origins:
            origins.append(origin)
    return origins


def configure_cors(app, raw=None):
    if raw is None:
        load_environment()
        raw = os.environ.get("FRONTEND_ORIGINS", "")
    app.add_middleware(CORSMiddleware, allow_origins=frontend_origins(raw), allow_credentials=False,
                       allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type"], max_age=600)
