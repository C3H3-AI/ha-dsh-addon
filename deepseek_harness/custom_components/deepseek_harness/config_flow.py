"""Config flow for DeepSeek Harness."""

from __future__ import annotations

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResult

from .const import (
    CONF_API_TOKEN,
    CONF_HOST,
    CONF_PORT,
    CONF_TIMEOUT,
    DEFAULT_HOST,
    DEFAULT_PORT,
    DEFAULT_TIMEOUT,
    DOMAIN,
)


class DeepseekConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle the config flow for DeepSeek Harness."""

    VERSION = 1

    async def async_step_user(self, user_input=None) -> FlowResult:
        """Handle the initial step."""
        errors: dict[str, str] = {}
        if user_input is not None:
            return self.async_create_entry(
                title=f"DeepSeek Harness ({user_input[CONF_HOST]})",
                data=user_input,
            )

        data_schema = vol.Schema(
            {
                vol.Required(CONF_HOST, default=DEFAULT_HOST): str,
                vol.Required(CONF_PORT, default=DEFAULT_PORT): int,
                vol.Required(CONF_TIMEOUT, default=DEFAULT_TIMEOUT): int,
                vol.Optional(CONF_API_TOKEN, default=""): str,
            }
        )
        return self.async_show_form(
            step_id="user", data_schema=data_schema, errors=errors
        )

    async def async_step_reconfigure(self, user_input=None) -> FlowResult:
        """Handle reconfiguration from the HA UI."""
        entry = self._get_reconfigure_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            return self.async_update_reconfigure_and_continue(
                data=user_input,
                title=f"DeepSeek Harness ({user_input[CONF_HOST]})",
            )

        data_schema = vol.Schema(
            {
                vol.Required(CONF_HOST, default=entry.data.get(CONF_HOST, DEFAULT_HOST)): str,
                vol.Required(CONF_PORT, default=entry.data.get(CONF_PORT, DEFAULT_PORT)): int,
                vol.Required(CONF_TIMEOUT, default=entry.data.get(CONF_TIMEOUT, DEFAULT_TIMEOUT)): int,
                vol.Optional(CONF_API_TOKEN, default=entry.data.get(CONF_API_TOKEN, "")): str,
            }
        )
        return self.async_show_form(
            step_id="reconfigure", data_schema=data_schema, errors=errors
        )
