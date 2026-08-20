"""Runtime status sensor for DeepSeek Harness."""

from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo

from .const import DOMAIN
from .dsh_client import DSHClient


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities,
) -> None:
    """Set up the runtime status sensor."""
    client: DSHClient = hass.data[DOMAIN][entry.entry_id]["client"]
    async_add_entities([DSHRuntimeSensor(entry, client)])


class DSHRuntimeSensor(SensorEntity):
    """Reports whether the DSH add-on API is reachable."""

    _attr_has_entity_name = True
    _attr_name = "运行时状态"
    _attr_translation_key = "runtime_status"

    def __init__(self, entry: ConfigEntry, client: DSHClient) -> None:
        self._entry = entry
        self._client = client
        self._attr_unique_id = f"{entry.entry_id}_runtime_status"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="DeepSeek Harness",
            manufacturer="DeepSeek",
            model="Harness",
        )

    async def async_update(self) -> None:
        """Poll the add-on status endpoint."""
        status = await self._client.status()
        self._attr_native_value = "online" if status.get("online") else "offline"
        self._attr_extra_state_attributes = {
            key: value for key, value in status.items() if key != "online"
        }
