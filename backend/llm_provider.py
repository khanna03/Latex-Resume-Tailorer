# ==============================================================================
# LaTeX Resume Tailorer — Multi-Provider LLM Abstraction Layer
# ==============================================================================
#
# PURPOSE:
#   This module provides a single, universal function `generate_json_content()`
#   that can route LLM requests to any of the following providers:
#     1. Google Gemini (default, detected by non-prefixed API keys)
#     2. OpenAI / GPT (detected by "sk-" prefix)
#     3. Anthropic / Claude (detected by "sk-ant-" prefix)
#     4. Local models via vLLM/Ollama (detected by LOCAL_LLM_BASE_URL config)
#
# STUDY NOTES — Why an Abstraction Layer?
#   Each LLM provider has a different SDK, authentication method, and response
#   format. By centralizing all LLM calls here, the rest of the codebase
#   (tailor.py, parser.py, etc.) can simply call `generate_json_content()`
#   without worrying about which provider is being used. This is the
#   "Strategy Pattern" in software design.
#
# HOW PROVIDER DETECTION WORKS:
#   - "sk-ant-*" → Anthropic (Claude models)
#   - "sk-*"     → OpenAI (GPT models)
#   - ""         → Falls through to local LLM or Gemini
#   - Gemini is the default fallback for all other API key formats
# ==============================================================================

import json
import re

# Google's Generative AI SDK for Gemini models.
# STUDY NOTE: genai.configure() sets the API key globally for the module.
# genai.GenerativeModel() creates a model instance that can generate content.
import google.generativeai as genai

# OpenAI's official Python SDK. Also used for local inference servers
# (vLLM, Ollama, text-generation-webui) because they expose OpenAI-compatible APIs.
# STUDY NOTE: The OpenAI client accepts a `base_url` parameter, which lets us
# redirect requests to any OpenAI-compatible server (not just api.openai.com).
from openai import OpenAI

# Anthropic's official Python SDK for Claude models.
from anthropic import Anthropic

# Import our settings to check if a LOCAL_LLM_BASE_URL is configured.
from backend.config import settings


def _clean_json_response(response_text: str) -> dict:
    """
    Robustly extracts a JSON object from an LLM's raw text response.

    STUDY NOTES — Why is this needed?
    -----------------------------------
    LLMs sometimes wrap their JSON output in markdown code fences (```json ... ```)
    or add conversational preamble text before/after the JSON object.
    This function handles those cases:
      1. First, try to parse the entire response as JSON directly.
      2. If that fails, use a regex to find the first {...} block in the text.
      3. If no valid JSON is found, raise a descriptive ValueError.

    Parameters:
        response_text: The raw string returned by the LLM API

    Returns:
        A parsed Python dictionary from the JSON content

    Raises:
        ValueError: If no valid JSON object can be extracted
    """
    try:
        return json.loads(response_text.strip())
    except Exception:
        # Fallback: Use regex to find the outermost { ... } block.
        # [\s\S]* matches any character including newlines (unlike .* which doesn't).
        match = re.search(r"\{[\s\S]*\}", response_text)
        if match:
            return json.loads(match.group(0))
        raise ValueError("LLM returned invalid JSON structure: " + response_text[:200])


def generate_json_content(api_key: str, model_name: str, prompt: str) -> dict:
    """
    Universal wrapper for generating structured JSON content from any LLM provider.

    STUDY NOTES — Provider Routing Logic:
    ----------------------------------------
    The function uses a simple "prefix-based routing" strategy:
      1. If api_key starts with "sk-ant-" → route to Anthropic (Claude)
      2. If api_key starts with "sk-" OR LOCAL_LLM_BASE_URL is set → route to OpenAI SDK
         (The OpenAI SDK is also used for local models because vLLM/Ollama expose
          OpenAI-compatible REST APIs at /v1/chat/completions)
      3. Everything else → route to Google Gemini (the default)

    Parameters:
        api_key:    The user's API key (can be empty if LOCAL_LLM_BASE_URL is set)
        model_name: The model identifier (e.g., "gemini-2.5-flash", "gpt-4o", "claude-3-opus")
        prompt:     The text prompt to send to the model

    Returns:
        A parsed Python dictionary containing the model's JSON response

    Raises:
        ValueError: If no API key or local URL is configured
    """
    # ---- Guard: Ensure at least one provider is available ----
    if not api_key and not settings.LOCAL_LLM_BASE_URL:
        raise ValueError("API key or local LLM base URL is required.")

    # ---- Provider 1: Anthropic (Claude) ----
    # Detected by the "sk-ant-" prefix unique to Anthropic API keys.
    if api_key and api_key.startswith("sk-ant-"):
        client = Anthropic(api_key=api_key)
        response = client.messages.create(
            model=model_name,
            max_tokens=4096,
            # Anthropic uses a flat messages array (no system parameter in messages API)
            messages=[{"role": "user", "content": prompt}]
        )
        # Anthropic returns content as a list of content blocks; we take the first text block.
        return _clean_json_response(response.content[0].text)

    # ---- Provider 2: OpenAI / Local LLM (vLLM, Ollama) ----
    # The OpenAI SDK is reused for local models because they expose the same REST API.
    # STUDY NOTE: We prioritize LOCAL_LLM_BASE_URL even if no api_key is provided,
    # because local models typically don't require authentication.
    elif (api_key and api_key.startswith("sk-")) or settings.LOCAL_LLM_BASE_URL:
        # Build the client configuration dynamically.
        # If no API key is provided (local mode), we pass "local" as a dummy key
        # because the OpenAI SDK requires a non-empty api_key string.
        client_kwargs = {"api_key": api_key if api_key else "local"}
        
        # If a local LLM server is configured, override the base URL.
        # Example: "http://localhost:11434/v1" for Ollama
        #          "http://localhost:8080/v1" for vLLM
        if settings.LOCAL_LLM_BASE_URL:
            client_kwargs["base_url"] = settings.LOCAL_LLM_BASE_URL
            
        client = OpenAI(**client_kwargs)
        
        # STUDY NOTE: When using the official OpenAI API, we enforce a compatible
        # model name (gpt-4o). But for local models, we pass the model name as-is
        # because the user might be running "unsloth/llama-3-8b" or any custom name.
        if not settings.LOCAL_LLM_BASE_URL and not model_name.startswith("gpt-"):
            model_name = "gpt-4o"
            
        response = client.chat.completions.create(
            model=model_name,
            # response_format forces the model to output valid JSON (not all models support this)
            response_format={"type": "json_object"},
            messages=[{"role": "user", "content": prompt}]
        )
        # OpenAI returns choices[0].message.content as a string.
        return _clean_json_response(response.choices[0].message.content)

    else:
        # ---- Provider 3: Google Gemini (Default) ----
        # Gemini is the fallback for any API key that doesn't match OpenAI or Anthropic.
        genai.configure(api_key=api_key)
        
        # Ensure the model name is a valid Gemini model. If the user passed an
        # OpenAI/Anthropic model name by mistake, default to gemini-2.5-flash.
        if not model_name.startswith("gemini-"):
            model_name = "gemini-2.5-flash"
            
        model = genai.GenerativeModel(model_name)
        response = model.generate_content(
            prompt,
            # STUDY NOTE: This generation_config tells Gemini to return its response
            # as raw JSON instead of markdown or prose. This is Gemini's equivalent
            # of OpenAI's response_format={"type": "json_object"}.
            generation_config={"response_mime_type": "application/json"}
        )
        return _clean_json_response(response.text)
