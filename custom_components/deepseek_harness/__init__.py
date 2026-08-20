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

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import (
    CONF_API_TOKEN,
    CONF_HOST,
    CONF_PORT,
    CONF_TIMEOUT,
    DEFAULT_TIMEOUT,
    DOMAIN,
)
from .dsh_client import DSHClient

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["conversation", "sensor"]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up DeepSeek Harness from a config entry."""
    host = entry.data[CONF_HOST]
    port = entry.data[CONF_PORT]
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
