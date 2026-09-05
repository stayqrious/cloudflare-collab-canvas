#!/usr/bin/env python3
"""Dependency-free SpaceScale parent-backend integration example."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
import uuid
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request, urlopen


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


ORIGIN = os.environ.get("SPACESCALE_ORIGIN", "https://your-spacescale.example").rstrip("/")
HOSTNAME = urlparse(ORIGIN).hostname
if not HOSTNAME:
    raise RuntimeError("SPACESCALE_ORIGIN must contain a hostname")

ORGANISATION_ID = required("SPACESCALE_ORGANISATION_ID")
KEY_ID = required("SPACESCALE_KEY_ID")
SIGNING_KEY = required("SPACESCALE_SIGNING_KEY")
SPACE_ID = os.environ.get("SPACESCALE_SPACE_ID", f"sample-space-{int(time.time())}")
SYNTHETIC_TEMPLATE_AUTHOR = "a_" + ("A" * 22)
SYNTHETIC_SOURCE_BOARD = "b_" + ("A" * 22)


def base64url_bytes(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def base64url_json(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return base64url_bytes(encoded)


def create_launch_token(
    *,
    hostname: str,
    organisation_id: str,
    space_id: str,
    key_id: str,
    signing_key: str,
    role: str,
    display_name: str,
    participant_id: str,
    features: dict[str, bool] | None = None,
    organisation_admin: bool | None = None,
    expires_in_seconds: int = 60 * 60,
) -> str:
    if role not in {"owner", "editor", "viewer"}:
        raise ValueError("role must be owner, editor, or viewer")
    if not 1 <= expires_in_seconds <= 24 * 60 * 60:
        raise ValueError("expires_in_seconds must be between 1 and 86400")

    now = int(time.time())
    payload: dict[str, Any] = {
        "v": 1,
        "aud": hostname,
        "organisation_id": organisation_id,
        "space_id": space_id,
        "key_id": key_id,
        "role": role,
        "display_name": display_name,
        "participant_id": participant_id,
        "iat": now,
        "exp": now + expires_in_seconds,
    }
    if features is not None:
        payload["features"] = features
    if organisation_admin is not None:
        payload["organisation_admin"] = organisation_admin

    encoded_payload = base64url_json(payload)
    signed = f"el1.{encoded_payload}"
    signature = hmac.new(
        signing_key.encode("utf-8"),
        signed.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return f"{signed}.{base64url_bytes(signature)}"


def create_embed_url(
    *,
    origin: str,
    launch_token: str,
    initial_template: dict[str, Any] | None = None,
) -> str:
    fragment = {"launch": launch_token}
    if initial_template is not None:
        fragment["import"] = base64url_json(initial_template)
    return f"{origin.rstrip('/')}/embed#{urlencode(fragment)}"


def sample_items(version: int, *, lock_sections: bool = False) -> list[dict[str, Any]]:
    response_section_id = str(uuid.uuid4())
    return [
        {
            "id": str(uuid.uuid4()),
            "kind": "text",
            "z": 1,
            "version": version,
            "createdBy": SYNTHETIC_TEMPLATE_AUTHOR,
            "style": {
                "kind": "text",
                "color": "#1f2937",
                "fontSize": 32,
                "fontFamily": "sans",
                "opacity": 1,
            },
            "transform": [1, 0, 0, 1, 0, 0],
            "geometry": {
                "x": 80,
                "y": 70,
                "text": "What did you notice? What do you wonder?",
            },
        },
        {
            "id": response_section_id,
            "kind": "zone",
            "z": 2,
            "version": version,
            "createdBy": SYNTHETIC_TEMPLATE_AUTHOR,
            "style": {
                "kind": "zone",
                "borderColor": "#60a5fa",
                "fill": "#eff6ff",
                "textColor": "#1e3a8a",
                "fontSize": 20,
                "opacity": 0.8,
            },
            "transform": [1, 0, 0, 1, 0, 0],
            "geometry": {
                "x": 80,
                "y": 130,
                "width": 700,
                "height": 360,
                "title": "Participant responses",
                "locked": lock_sections,
            },
        },
        {
            "id": str(uuid.uuid4()),
            "kind": "sticky",
            "z": 3,
            "version": version,
            "createdBy": SYNTHETIC_TEMPLATE_AUTHOR,
            "sectionId": response_section_id,
            "style": {
                "kind": "sticky",
                "fill": "#FFE7A8",
                "textColor": "#20201E",
                "fontSize": 20,
                "opacity": 1,
            },
            "transform": [1, 0, 0, 1, 0, 0],
            "geometry": {
                "x": 100,
                "y": 150,
                "width": 240,
                "height": 180,
                "text": "Add your response",
            },
        },
    ]


def create_initial_template(
    title: str,
    *,
    lock_sections: bool = False,
) -> dict[str, Any]:
    return {
        "format": "cf-whiteboard-json",
        "version": 1,
        "boardId": SYNTHETIC_SOURCE_BOARD,
        "seq": 0,
        "createdAt": int(time.time() * 1000),
        "settings": {"title": title},
        "items": sample_items(0, lock_sections=lock_sections),
    }


def http_json(
    path: str,
    *,
    method: str = "GET",
    token: str | None = None,
    body: dict[str, Any] | None = None,
    origin_header: str | None = None,
) -> Any:
    headers = {"Accept": "application/json"}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    if origin_header is not None:
        headers["Origin"] = origin_header
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    request = Request(f"{ORIGIN}{path}", data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=30) as response:
            if response.status == 204:
                return None
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {path} failed ({error.code}): {detail}") from error


def resolve_space(
    owner_token: str,
    initial_template: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"token": owner_token}
    if initial_template is not None:
        body["importSnapshot"] = base64url_json(initial_template)
    return http_json(
        "/api/v1/embed/session",
        method="POST",
        origin_header=ORIGIN,
        body=body,
    )


def organisation_path(suffix: str) -> str:
    return f"/api/v1/organisations/{quote(ORGANISATION_ID, safe='')}{suffix}"


def list_organisation_templates(owner_token: str) -> dict[str, Any]:
    return http_json(organisation_path("/templates"), token=owner_token)


def create_organisation_template(
    owner_token: str,
    template: dict[str, Any],
) -> dict[str, Any]:
    return http_json(
        organisation_path("/templates"),
        method="POST",
        token=owner_token,
        body=template,
    )


def update_organisation_template(
    owner_token: str,
    template_id: str,
    changes: dict[str, Any],
) -> dict[str, Any]:
    return http_json(
        organisation_path(f"/templates/{quote(template_id, safe='')}"),
        method="PATCH",
        token=owner_token,
        body=changes,
    )


def delete_organisation_template(owner_token: str, template_id: str) -> None:
    http_json(
        organisation_path(f"/templates/{quote(template_id, safe='')}"),
        method="DELETE",
        token=owner_token,
    )


def delete_board(owner_token: str, board_id: str) -> None:
    http_json(
        organisation_path(f"/boards/{quote(board_id, safe='')}"),
        method="DELETE",
        token=owner_token,
    )


def main() -> None:
    initial_template = create_initial_template("Notice and wonder", lock_sections=True)
    common = {
        "hostname": HOSTNAME,
        "organisation_id": ORGANISATION_ID,
        "space_id": SPACE_ID,
        "key_id": KEY_ID,
        "signing_key": SIGNING_KEY,
    }
    owner_token = create_launch_token(
        **common,
        role="owner",
        display_name="Coach Sample",
        participant_id="service:coach-sample",
        features={"organisationTemplates": True, "templates": True},
    )
    editor_token = create_launch_token(
        **common,
        role="editor",
        display_name="Student Sample",
        participant_id="student:sample-001",
    )
    admin_token = create_launch_token(
        **common,
        role="owner",
        display_name="Organisation administrator",
        participant_id="service:organisation-admin",
        organisation_admin=True,
        expires_in_seconds=15 * 60,
    )

    print("Owner iframe URL:")
    print(
        create_embed_url(
            origin=ORIGIN,
            launch_token=owner_token,
            initial_template=initial_template,
        )
    )
    print("\nStudent iframe URL:")
    print(create_embed_url(origin=ORIGIN, launch_token=editor_token))
    print("\nOrganisation admin URL:")
    print(f"{ORIGIN}/organisation/admin#launch={quote(admin_token, safe='')}")

    # Optional backend preflight: creates the Space and atomically applies the
    # initial template before any iframe is rendered.
    launch = resolve_space(owner_token, initial_template)
    board_id = launch["board"]["id"]
    print("\nResolved board ID:", board_id)

    api_token = create_launch_token(
        **common,
        role="owner",
        display_name="Partner API",
        participant_id="service:partner-api",
        expires_in_seconds=5 * 60,
    )
    canonical = http_json(
        organisation_path(f"/boards/{board_id}/export.json"),
        token=api_token,
    )
    attributed = http_json(
        organisation_path(f"/boards/{board_id}/export.attributed.json"),
        token=api_token,
    )
    print("Canonical objects:", len(canonical["items"]))
    print("Attributed participants:", len(attributed["participants"]))

    created = create_organisation_template(
        api_token,
        {
            "name": "Notice and wonder",
            "description": "Reusable prompt and response card",
            "items": sample_items(1),
        },
    )
    print("Created Organisation template:", created["id"])

    updated = update_organisation_template(
        api_token,
        created["id"],
        {
            "name": "Notice, wonder, connect",
            "description": "Updated from the parent backend",
            # Include "items" here as well to replace the template objects.
        },
    )
    print("Updated Organisation template:", updated["name"])

    listed = list_organisation_templates(api_token)
    print("Organisation template count:", len(listed["templates"]))

    # Destructive operations are available when needed, but are not run by this sample:
    # delete_organisation_template(api_token, created["id"])
    # delete_board(api_token, board_id)


if __name__ == "__main__":
    main()
