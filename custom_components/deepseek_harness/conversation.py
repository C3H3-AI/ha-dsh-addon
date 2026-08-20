"""Conversation agent that routes HA Assist / voice to DeepSeek Harness.

Mirrors the role ha-claw's ``FallbackConversationAgent`` plays: it registers
itself as an Assist agent so that talking to HA (typed or via Whisper + Piper)
is forwarded to the DSH runtime and the reply streams back as TTS speech.
"""

from __future__ import annotations

import logging

from homeassistant.components import conversation
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import intent

from .const import DOMAIN
from .dsh_client import DSHClientError

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities,
) -> None:
    """Set up the conversation agent from a config entry."""
    async_add_entities([DeepseekConversationAgent(hass, entry)])


class DeepseekConversationAgent(
    conversation.ConversationEntity,
    conversation.AbstractConversationAgent,
):
    """Assist agent backed by the DeepSeek Harness runtime."""

    _attr_has_entity_name = True

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self._attr_name = "DeepSeek Harness"
        self._attr_unique_id = entry.entry_id

    @property
    def supported_languages(self) -> list[str] | None:
        """Support all languages."""
        return None

    async def async_added_to_hass(self) -> None:
        """Register this agent with the conversation subsystem."""
        await super().async_added_to_hass()
        conversation.async_set_agent(self.hass, self.entry, self)

    async def async_process(
        self, user_input: conversation.ConversationInput
    ) -> conversation.ConversationResult:
        """Process a single Assist turn by forwarding it to DSH."""
        client: DSHClient = self.hass.data[DOMAIN][self.entry.entry_id]["client"]
        try:
            text = await client.chat(user_input.text, user_input.conversation_id)
        except DSHClientError as err:
            _LOGGER.warning("DSH chat failed: %s", err)
            text = f"抱歉，DeepSeek Harness 暂时无法响应：{err}"

        response = intent.IntentResponse(language=user_input.language)
        response.async_set_speech(text)
        return conversation.result(
            response=response,
            conversation_id=user_input.conversation_id,
        )
