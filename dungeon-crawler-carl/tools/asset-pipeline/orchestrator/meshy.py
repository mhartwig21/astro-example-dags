"""Minimal stdlib-only Meshy API client.

Covers the pieces the pipeline needs: Text-to-3D (preview + refine),
Image-to-3D, task polling, and asset download. Async by design — create
returns a task id, poll() waits for completion.

Auth: set MESHY_API_KEY. Meshy ships a documented test-mode key
(TEST_MODE_KEY below) that exercises the API without spending credits and
returns canned sample results — useful for wiring tests.

Endpoints (per Meshy OpenAPI docs as of mid-2026):
    POST /openapi/v2/text-to-3d          {"mode": "preview"|"refine", ...}
    GET  /openapi/v2/text-to-3d/{id}
    POST /openapi/v1/image-to-3d
    GET  /openapi/v1/image-to-3d/{id}
Rigging/animation endpoints exist on paid tiers but are not wired up yet
(Phase 3) — see docs.meshy.ai/en/api/rigging-and-animation.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import time
import urllib.error
import urllib.request

BASE_URL = "https://api.meshy.ai"
TEST_MODE_KEY = "msy_dummy_api_key_for_test_mode_12345678"

TEXT_TO_3D = "/openapi/v2/text-to-3d"
IMAGE_TO_3D = "/openapi/v1/image-to-3d"


class MeshyError(RuntimeError):
    pass


class MeshyClient:
    def __init__(self, api_key: str | None = None, base_url: str = BASE_URL):
        self.api_key = api_key or os.environ.get("MESHY_API_KEY", "")
        if not self.api_key:
            raise MeshyError(
                "no API key: set MESHY_API_KEY (or use MeshyClient(TEST_MODE_KEY))"
            )
        self.base_url = base_url.rstrip("/")

    # -- transport -----------------------------------------------------------

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        url = self.base_url + path
        data = json.dumps(body).encode() if body is not None else None
        last_error: Exception | None = None
        for attempt in range(5):
            req = urllib.request.Request(
                url,
                data=data,
                method=method,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=120) as resp:
                    return json.loads(resp.read() or b"{}")
            except urllib.error.HTTPError as e:
                detail = e.read().decode(errors="replace")[:500]
                if e.code in (429, 500, 502, 503, 504) and attempt < 4:
                    last_error = MeshyError(f"{method} {path}: HTTP {e.code}: {detail}")
                    time.sleep(2**attempt * 2)
                    continue
                raise MeshyError(f"{method} {path}: HTTP {e.code}: {detail}") from e
            except urllib.error.URLError as e:
                last_error = e
                if attempt < 4:
                    time.sleep(2**attempt * 2)
                    continue
                raise MeshyError(f"{method} {path}: {e}") from e
        raise MeshyError(f"{method} {path}: retries exhausted: {last_error}")

    # -- task creation -------------------------------------------------------

    def text_to_3d_preview(
        self,
        prompt: str,
        # The live v2 API rejects everything except "realistic" (verified via
        # test mode 2026-07-05: 'ArtStyle must be one of [realistic]').
        art_style: str = "realistic",
        target_polycount: int | None = None,
        topology: str | None = None,
        seed: int | None = None,
    ) -> str:
        body: dict = {"mode": "preview", "prompt": prompt, "art_style": art_style}
        if target_polycount:
            # target_polycount is silently ignored unless should_remesh is set
            # (verified live 2026-07-08: without it a 3k-target crate came back
            # with 924k triangles).
            body["target_polycount"] = target_polycount
            body["should_remesh"] = True
        if topology:
            body["topology"] = topology
        if seed is not None:
            body["seed"] = seed
        return self._request("POST", TEXT_TO_3D, body)["result"]

    def text_to_3d_refine(self, preview_task_id: str, enable_pbr: bool = False) -> str:
        body = {
            "mode": "refine",
            "preview_task_id": preview_task_id,
            "enable_pbr": enable_pbr,
        }
        return self._request("POST", TEXT_TO_3D, body)["result"]

    def image_to_3d(
        self,
        image: str,
        target_polycount: int | None = None,
        topology: str | None = None,
        enable_pbr: bool = False,
    ) -> str:
        """image: an https URL or a local file path (sent as a data URI)."""
        if not image.startswith(("http://", "https://", "data:")):
            mime = mimetypes.guess_type(image)[0] or "image/png"
            with open(image, "rb") as f:
                image = f"data:{mime};base64,{base64.b64encode(f.read()).decode()}"
        body: dict = {"image_url": image, "enable_pbr": enable_pbr}
        if target_polycount:
            body["target_polycount"] = target_polycount
            body["should_remesh"] = True
        if topology:
            body["topology"] = topology
        return self._request("POST", IMAGE_TO_3D, body)["result"]

    # -- polling & download ----------------------------------------------------

    def get_task(self, endpoint: str, task_id: str) -> dict:
        return self._request("GET", f"{endpoint}/{task_id}")

    def poll(
        self,
        endpoint: str,
        task_id: str,
        timeout: float = 1800.0,
        interval: float = 10.0,
        on_progress=None,
    ) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            task = self.get_task(endpoint, task_id)
            status = task.get("status")
            if on_progress:
                on_progress(task)
            if status == "SUCCEEDED":
                return task
            if status in ("FAILED", "CANCELED"):
                raise MeshyError(
                    f"task {task_id} {status}: {task.get('task_error') or task}"
                )
            if time.monotonic() > deadline:
                raise MeshyError(f"task {task_id} timed out after {timeout}s")
            time.sleep(interval)

    def download(self, url: str, dest: str) -> str:
        os.makedirs(os.path.dirname(os.path.abspath(dest)), exist_ok=True)
        req = urllib.request.Request(url, headers={"User-Agent": "asset-pipeline"})
        with urllib.request.urlopen(req, timeout=300) as resp, open(dest, "wb") as f:
            while chunk := resp.read(1 << 16):
                f.write(chunk)
        return dest
