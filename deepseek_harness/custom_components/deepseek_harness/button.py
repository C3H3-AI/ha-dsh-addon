"""Control buttons for the DeepSeek Harness add-on.

Exposes the add-on bridge's restart and one-click DSH update as HA button
entities, so both are reachable from the UI and from automations without
curl. The bridge still enforces its own api_token (fail-closed).
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the DeepSeek Harness control buttons."""
    client = hass.data[DOMAIN][entry.entry_id]["client"]
    async_add_entities([DSHRestartButton(entry, client), DSHUpdateButton(entry, client)])


class _DSHBaseButton(ButtonEntity):
    """Common plumbing for the add-on control buttons."""

    _attr_has_entity_name = True

    def __init__(self, entry: ConfigEntry, client: Any, key: str, name: str) -> None:
        self._entry = entry
        self._client = client
        self._attr_unique_id = f"{entry.entry_id}_{key}"
        self._attr_name = name
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="DeepSeek Harness",
            manufacturer="DeepSeek",
            model="Harness",
        )


class DSHRestartButton(_DSHBaseButton):
    """Restart the DSH runtime inside the add-on."""

    def __init__(self, entry: ConfigEntry, client: Any) -> None:
        super().__init__(entry, client, "restart", "重启 DSH")

    async def async_press(self) -> None:
        """Handle the button press."""
        ok = await self._client.restart()
        if not ok:
            _LOGGER.warning("DSH restart request was not accepted by the add-on")


class DSHUpdateButton(_DSHBaseButton):
    """Trigger the add-on's one-click DSH update."""

    def __init__(self, entry: ConfigEntry, client: Any) -> None:
        super().__init__(entry, client, "update", "更新 DSH")
        self._attr_extra_state_attributes: dict[str, Any] = {}

    async def async_press(self) -> None:
        """Handle the button press."""
        result = await self._client.trigger_update()
        if not result.get("ok"):
            _LOGGER.warning("DSH update failed: %s", result.get("error"))
        else:
            self._attr_extra_state_attributes = {
                "last_update_version": result.get("version"),
            }
            self.async_write_ha_state()
