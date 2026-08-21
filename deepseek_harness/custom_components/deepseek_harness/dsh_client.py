"""HTTP client bridging Home Assistant to the DeepSeek Harness add-on API.

The add-on (ha-dsh-addon) exposes a small, stable HTTP API
(``/api/chat``, ``/api/status``, ``/api/restart``) that wraps the volatile
DSH runtime. This client only depends on that stable contract, so upstream
DSH breaking changes only require updating the add-on, never this component.
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

    async def chat(
        self, message: str, conversation_id: str | None = None
    ) -> str:
        """Send a message to DSH and return the assistant text."""
        session = await self._get_session()
        payload: dict[str, Any] = {"message": message}
        if conversation_id:
            payload["session"] = conversation_id
        try:
            async with async_timeout.timeout(self._timeout):
                async with session.post(
                    f"{self._base_url}/api/chat",
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
                    return data.get("text", "")
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
