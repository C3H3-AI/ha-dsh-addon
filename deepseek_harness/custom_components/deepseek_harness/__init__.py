"""DeepSeek Harness integration: bridges Home Assistant to the DSH add-on.

Architecture (A+B):
  * A (base): the DSH add-on connects to HA via the native MCP Server, so the
    agent can read/control real devices. This is configuration only.
  * B (this shell): a custom_component that gives HA a native face for DSH -
    an Assist conversation agent, entities, services and (later) a panel.
    It talks to the add-on through a small stable HTTP bridge API, never to
    DSH's volatile RC internals directly.
"""

from __future__ import annotations

import asyncio
import logging
import os

import aiohttp
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import (
    CONF_API_TOKEN,
    CONF_HOST,
    CONF_PORT,
    CONF_TIMEOUT,
    DEFAULT_HOST,
    DEFAULT_TIMEOUT,
    DOMAIN,
)
from .dsh_client import DSHClient

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["conversation", "sensor"]


async def _detect_addon_host(hass: HomeAssistant) -> str | None:
    """通过 Supervisor API 自动检测 DSH addon 的真实 hostname。

    HA Supervisor 为每个 addon 生成的 DNS 名 = slug.replace('_', '-')，
    而 slug = <仓库ID>_<addon名>。同一仓库在所有机器上仓库 ID 一致，
    但不同仓库（如官方仓库 vs 第三方仓库）的 ID 不同，导致默认值
    ``DEFAULT_HOST = "deepseek_harness"`` 在第三方仓库环境下解析失败。
    本函数通过 Supervisor API 遍历已安装 addon，找到 slug 中包含
    ``deepseek_harness`` 的条目，反向推导出正确的 hostname。
    """
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        return None
    try:
        async with aiohttp.ClientSession() as session:
            headers = {"Authorization": f"Bearer {token}"}
            async with session.get(
                "http://supervisor/addons", headers=headers, timeout=5
            ) as resp:
                if resp.status != 200:
                    _LOGGER.debug(
                        "Supervisor API returned %s, cannot auto-detect hostname",
                        resp.status,
                    )
                    return None
                data = await resp.json()
                for addon in data.get("data", {}).get("addons", []):
                    slug = addon.get("slug", "")
                    if "deepseek_harness" in slug and slug != "deepseek_harness":
                        detected = slug.replace("_", "-")
                        _LOGGER.info(
                            "Auto-detected DSH addon hostname: %s (slug=%s)",
                            detected,
                            slug,
                        )
                        return detected
    except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
        _LOGGER.debug("Failed to detect addon hostname via Supervisor API: %s", exc)
    return None


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up DeepSeek Harness from a config entry."""
    host = entry.data[CONF_HOST]
    port = entry.data[CONF_PORT]

    # 自动检测真实 addon hostname（解决不同仓库前缀的 slug 问题）
    # 仅在配置的 host 是默认值或检测到不一致时自动修正
    detected = await _detect_addon_host(hass)
    if detected and detected != host:
        _LOGGER.warning(
            "DSH addon hostname auto-detected as '%s' but configured as '%s'. "
            "Using detected hostname. Update your config entry to silence this warning.",
            detected,
            host,
        )
        host = detected

    timeout = entry.data.get(CONF_TIMEOUT, DEFAULT_TIMEOUT)
    api_token = entry.data.get(CONF_API_TOKEN) or None
    base_url = f"http://{host}:{port}"

    client = DSHClient(base_url, timeout=timeout, api_token=api_token)
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = {"client": client}

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        client = hass.data[DOMAIN].pop(entry.entry_id, {}).get("client")
        if client is not None:
            await client.close()
    return unloaded
