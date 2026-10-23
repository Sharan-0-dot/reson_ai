"""LLM provider adapter for Google Gemini with structured JSON output.

Security rules:
- API keys are NEVER logged or printed.
- Keys are passed via headers (x-goog-api-key), not URL query parameters.
- Error messages never expose secrets or raw authorization headers.
"""

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Union
import httpx
from dotenv import load_dotenv

# Ensure environment variables are loaded from backend/.env
backend_dir = Path(__file__).resolve().parent.parent.parent
env_path = backend_dir / ".env"
load_dotenv(dotenv_path=env_path)


class LLMError(Exception):
    """Raised when an LLM provider request fails."""

    pass


class GeminiLLM:
    """Client for Google Gemini REST API using generateContent with JSON response schema."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        timeout_s: Optional[float] = None,
    ):
        self.api_key = api_key or os.getenv("GEMINI_API_KEY", "")
        self.model = model or os.getenv("GEMINI_MODEL", "gemini-3.5-flash")
        timeout_val = timeout_s or os.getenv("LLM_TIMEOUT_S", "20")
        try:
            self.timeout_s = float(timeout_val)
        except ValueError:
            self.timeout_s = 20.0

    def chat_json(
        self,
        system: str,
        messages: List[Dict[str, str]],
    ) -> Dict[str, Any]:
        """Send chat messages and return parsed JSON dictionary."""
        if not self.api_key:
            raise LLMError("GEMINI_API_KEY is not configured in backend/.env")
        if not self.model:
            raise LLMError("GEMINI_MODEL is not configured in backend/.env")

        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": self.api_key,
        }

        # Format contents
        formatted_contents = []
        for msg in messages:
            role = "model" if msg.get("role") in ("assistant", "model") else "user"
            formatted_contents.append({
                "role": role,
                "parts": [{"text": str(msg.get("content", ""))}],
            })

        body = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": formatted_contents,
            "generationConfig": {
                "responseMimeType": "application/json",
                "temperature": 0.2,
            },
        }

        candidate_models = [self.model]
        for fb in ["gemini-3.5-flash", "gemini-3.5-flash-lite"]:
            if fb not in candidate_models:
                candidate_models.append(fb)

        last_error = None
        for current_model in candidate_models:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{current_model}:generateContent"
            for attempt in range(2):
                try:
                    with httpx.Client(timeout=self.timeout_s) as client:
                        resp = client.post(url, headers=headers, json=body)

                    if resp.status_code == 200:
                        data = resp.json()
                        candidates = data.get("candidates", [])
                        if not candidates:
                            raise LLMError("Gemini returned no candidates in response")

                        parts = candidates[0].get("content", {}).get("parts", [])
                        if not parts or "text" not in parts[0]:
                            raise LLMError("Gemini response missing text part")

                        raw_text = parts[0]["text"].strip()
                        try:
                            return json.loads(raw_text)
                        except json.JSONDecodeError as jde:
                            raise LLMError(f"Failed to parse LLM response as JSON: {jde}") from jde

                    status = resp.status_code
                    if status in (404, 429):
                        # Switch to next candidate model if available
                        last_error = f"Gemini API {status} on {current_model}"
                        break
                    elif status == 400:
                        raise LLMError(f"Gemini API 400: Bad request. Response: {resp.text[:120]}")
                    elif status == 403:
                        raise LLMError("Gemini API 403: Forbidden or invalid API key.")
                    else:
                        raise LLMError(f"Gemini API failed with HTTP {status}: {resp.text[:120]}")

                except httpx.RequestError as exc:
                    if attempt == 0:
                        continue
                    last_error = f"Network error communicating with Gemini API: {type(exc).__name__}"
                    break
                except LLMError as le:
                    if status not in (404, 429):
                        raise
                    last_error = str(le)
                    break

        raise LLMError(f"LLM call failed across all candidate models: {last_error}")


class OpenRouterLLM:
    """Client for OpenRouter API using OpenAI-compatible chat completions with structured JSON output."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        timeout_s: Optional[float] = None,
    ):
        self.api_key = (
            api_key
            or os.getenv("OPENROUTER_API_KEY")
            or os.getenv("GEMINI_API_KEY", "")
        )
        raw_model = (
            model
            or os.getenv("OPENROUTER_MODEL")
            or os.getenv("GEMINI_MODEL", "google/gemini-2.5-flash")
        )
        # Normalize model name if user provided shorthand like 'gemini-2.5-flash'
        if "/" not in raw_model and "gemini" in raw_model:
            raw_model = f"google/{raw_model}"
        self.model = raw_model

        timeout_val = timeout_s or os.getenv("LLM_TIMEOUT_S", "25")
        try:
            self.timeout_s = float(timeout_val)
        except ValueError:
            self.timeout_s = 25.0

    def chat_json(
        self,
        system: str,
        messages: List[Dict[str, str]],
    ) -> Dict[str, Any]:
        """Send chat messages to OpenRouter and return parsed JSON dictionary."""
        if not self.api_key:
            raise LLMError("OpenRouter API key is not configured in backend/.env")
        if not self.model:
            raise LLMError("OpenRouter model is not configured in backend/.env")

        url = "https://openrouter.ai/api/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:3000",
            "X-Title": "ResonAI",
        }

        openai_messages = [{"role": "system", "content": system}]
        for msg in messages:
            role = "assistant" if msg.get("role") in ("assistant", "model") else "user"
            openai_messages.append({
                "role": role,
                "content": str(msg.get("content", "")),
            })

        body = {
            "model": self.model,
            "messages": openai_messages,
            "response_format": {"type": "json_object"},
            "temperature": 0.2,
        }

        for attempt in range(2):
            try:
                with httpx.Client(timeout=self.timeout_s) as client:
                    resp = client.post(url, headers=headers, json=body)

                if resp.status_code == 200:
                    data = resp.json()
                    choices = data.get("choices", [])
                    if not choices:
                        raise LLMError("OpenRouter returned no choices in response")

                    raw_text = choices[0].get("message", {}).get("content", "").strip()
                    try:
                        return json.loads(raw_text)
                    except json.JSONDecodeError as jde:
                        raise LLMError(f"Failed to parse LLM response as JSON: {jde}") from jde

                status = resp.status_code
                if status in (401, 403):
                    raise LLMError("OpenRouter API 401/403: Invalid or unauthorized API key.")
                elif status == 429:
                    raise LLMError("OpenRouter API 429: Rate limit exceeded or credit limit reached.")
                elif status == 400:
                    raise LLMError(f"OpenRouter API 400: Bad request. Response: {resp.text[:120]}")
                else:
                    raise LLMError(f"OpenRouter API failed with HTTP {status}: {resp.text[:120]}")

            except httpx.RequestError as exc:
                if attempt == 0:
                    continue
                raise LLMError(f"Network error communicating with OpenRouter: {type(exc).__name__}") from exc
            except LLMError:
                raise

        raise LLMError("OpenRouter call failed after retry")


def get_llm() -> Union[GeminiLLM, OpenRouterLLM]:
    """Factory returning configured LLM client (auto-detects Gemini vs OpenRouter)."""
    provider = os.getenv("LLM_PROVIDER", "").lower()
    key = os.getenv("OPENROUTER_API_KEY", "") or os.getenv("GEMINI_API_KEY", "")
    if provider == "openrouter" or key.startswith("sk-or-"):
        return OpenRouterLLM()
    return GeminiLLM()
