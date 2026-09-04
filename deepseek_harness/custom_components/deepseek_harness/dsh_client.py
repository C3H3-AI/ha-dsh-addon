"""HTTP client bridging Home Assistant to the DeepSeek Harness add-on API.

The add-on (ha-dsh-addon) exposes a small, stable HTTP API
(``/api/session``, ``/api/status``, ``/api/restart``) that
wraps the volatile DSH runtime. This client only depends on that stable
contract, so upstream DSH breaking changes only require updating the add-on,
never this component.

``chat_session`` walks the multi-turn session relay (DSH session memory);
uses the multi-turn session relay (/api/session), keeping the DSH sessionId
as the HA conversation_id so context survives across turns.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import aiohttp
import async_timeout

_LOGGER = logging.getLogger(__name__)


class DSHClientError(Exception):
    """Raised when communication with the DSH add-on fails."""


class DSHClient:
    """Thin async client for the DSH add-on bridge API."""

    def __init__(
        self,
        base_url: str,
        session: aiohttp.ClientSession | None = None,
        timeout: int = 180,
        api_token: str | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._session = session
        self._timeout = timeout
        self._owned = session is None
        self._api_token = api_token

    def _headers(self) -> dict[str, str]:
        """Return headers, attaching the shared API token when configured."""
        headers: dict[str, str] = {}
        if self._api_token:
            headers["Authorization"] = f"Bearer {self._api_token}"
        return headers

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None:
            self._session = aiohttp.ClientSession()
        return self._session

    async def close(self) -> None:
        """Close the underlying session if we own it."""
        if self._owned and self._session is not None:
            await self._session.close()
            self._session = None

    async def chat_session(
        self,
        message: str,
        session_id: str | None = None,
    ) -> tuple[str, str | None]:
        """Send a message to a DSH session and return (text, sessionId).

        ``session_id`` of None lets the add-on reuse/create a session and
        returns the generated ``sessionId`` as the next turn conversation id.
        """
        session = await self._get_session()
        payload: dict[str, Any] = {"message": message}
        if session_id:
            payload["session"] = session_id
        try:
            async with async_timeout.timeout(self._timeout):
                async with session.post(
                    f"{self._base_url}/api/session",
                    json=payload,
                    headers=self._headers(),
                ) as resp:
                    if resp.status != 200:
                        body = await resp.text()
                        if resp.status == 401:
                            raise DSHClientError(
                                "DSH 返回 401：API token 不匹配，请在 addon 与集成配置中填入相同的 api_token"
                            )
                        raise DSHClientError(
                            f"DSH 返回 {resp.status}: {body[:200]}"
                        )
                    data = await resp.json()
                    return data.get("text", ""), data.get("sessionId")
        except asyncio.TimeoutError as err:
            raise DSHClientError("DSH 响应超时") from err
        except aiohttp.ClientError as err:
            raise DSHClientError(f"无法连接 DSH：{err}") from err

    async def status(self) -> dict[str, Any]:
        """Return runtime status dict; always includes ``online``."""
        session = await self._get_session()
        try:
            async with async_timeout.timeout(10):
                async with session.get(
                    f"{self._base_url}/api/status", headers=self._headers()
                ) as resp:
                    if resp.status != 200:
                        return {"online": False, "error": f"status {resp.status}"}
                    return await resp.json()
        except aiohttp.ClientError:
            return {"online": False}

    async def update_status(self) -> dict[str, Any]:
        """Return DSH update info (current/latest/next, vendor in use)."""
        session = await self._get_session()
        try:
            async with async_timeout.timeout(20):
                async with session.get(
                    f"{self._base_url}/api/update/status",
                    headers=self._headers(),
                ) as resp:
                    if resp.status != 200:
                        return {"ok": False, "error": f"status {resp.status}"}
                    return await resp.json()
        except (aiohttp.ClientError, asyncio.TimeoutError) as err:
            return {"ok": False, "error": str(err)}

    async def trigger_update(self, channel: str = "next") -> dict[str, Any]:
        """Ask the add-on to update the DSH runtime in place.

        The add-on runs npm install into /data/dsh/vendor and swaps it
        atomically; it restarts DSH itself when it succeeds.
        """
        session = await self._get_session()
        try:
            async with async_timeout.timeout(300):
                async with session.post(
                    f"{self._base_url}/api/update",
                    json={"channel": channel},
                    headers=self._headers(),
                ) as resp:
                    body = await resp.text()
                    # 桥接层成功时返回 202 Accepted（后台异步执行）；429 表示已在更新
                    if resp.status not in (200, 202):
                        return {"ok": False, "error": f"status {resp.status}: {body[:200]}"}
                    try:
                        return await resp.json()
                    except Exception:  # noqa: BLE001 - non-JSON body is tolerable
                        return {"ok": True, "raw": body[:200]}
        except (aiohttp.ClientError, asyncio.TimeoutError) as err:
            return {"ok": False, "error": str(err)}

    async def restart(self) -> bool:
        """Ask the add-on to restart the DSH runtime."""
        session = await self._get_session()
        try:
            async with async_timeout.timeout(30):
                async with session.post(
                    f"{self._base_url}/api/restart", headers=self._headers()
                ) as resp:
                    return resp.status == 200
        except aiohttp.ClientError:
            return False
