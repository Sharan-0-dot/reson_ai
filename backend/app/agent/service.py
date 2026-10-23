"""High-level agent orchestration service.

Handles caching, LLM execution with 1-second rate-limiting, error fallbacks,
number-truthfulness checks in explain mode, op application, and response construction.
"""

import copy
import hashlib
import json
import os
from pathlib import Path
import re
import threading
import time
from typing import Any, Dict, List, Optional, Set, Tuple, Union

from app.agent.fallback import fallback_chat, template_explanation
from app.agent.ops import OpError, apply_ops, describe_op
from app.agent.prompts import build_messages, build_system_prompt, compact_design
from app.agent.provider import GeminiLLM, OpenRouterLLM, LLMError, get_llm
from app.cache import canonical_design_dict
from app.schemas import AgentChatRequest, AgentChatResponse, ChatMessage

# Cache file path in backend/cache/agent_cache.json
CACHE_DIR = Path(__file__).resolve().parent.parent.parent / "cache"
CACHE_FILE = CACHE_DIR / "agent_cache.json"

_rate_limit_lock = threading.Lock()
_last_live_call_time: float = 0.0


def _load_cache() -> Dict[str, Any]:
    """Load JSON cache from disk if available."""
    if not CACHE_FILE.exists():
        return {}
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_cache(cache_data: Dict[str, Any]) -> None:
    """Save JSON cache to disk safely."""
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(cache_data, f, indent=2)
    except Exception:
        pass


def _compute_cache_key(
    mode: str,
    design: Optional[Dict[str, Any]],
    messages: List[Any],
    analysis: Optional[Dict[str, Any]] = None,
) -> str:
    """Compute sha256 cache key from request parameters."""
    clean_d = canonical_design_dict(design)
    findings = analysis.get("findings", []) if analysis else []

    msg_history = []
    for m in (messages or []):
        r = m.get("role") if isinstance(m, dict) else getattr(m, "role", "user")
        c = m.get("content") if isinstance(m, dict) else getattr(m, "content", "")
        msg_history.append({"role": r, "content": c})

    key_payload = {
        "mode": mode,
        "design": clean_d,
        "messages": msg_history[-6:],
        "findings": findings,
    }
    raw_str = json.dumps(key_payload, sort_keys=True)
    return hashlib.sha256(raw_str.encode("utf-8")).hexdigest()


def _extract_all_numbers(data: Any) -> Set[float]:
    """Recursively extract all numeric values from a JSON structure."""
    numbers: Set[float] = set()

    def _walk(obj: Any):
        if isinstance(obj, (int, float)) and not isinstance(obj, bool):
            numbers.add(float(obj))
        elif isinstance(obj, dict):
            for v in obj.values():
                _walk(v)
        elif isinstance(obj, list):
            for item in obj:
                _walk(item)

    _walk(data)
    return numbers


def _verify_numbers_in_text(text: str, input_numbers: Set[float]) -> bool:
    """Verify that every number with a decimal point or >= 2 digits in text is within 1% of an input number."""
    if not input_numbers:
        return True

    # Find all floats or integers >= 2 digits
    pattern = re.compile(r"[-+]?(?:\d+\.\d+|\b\d{2,}\b)")
    matches = pattern.findall(text)

    for m in matches:
        try:
            val = float(m)
        except ValueError:
            continue

        # Check if val is within 1% of ANY number in input_numbers
        is_close = any(
            abs(val - ref) <= (0.01 * max(1e-4, abs(ref)))
            for ref in input_numbers
        )
        if not is_close:
            return False

    return True


def handle_chat(
    req: Union[AgentChatRequest, Dict[str, Any]],
    llm: Optional[Any] = None,
) -> AgentChatResponse:
    """Execute conversational agent request with caching, LLM reasoning, and offline fallback."""
    global _last_live_call_time

    # Normalize input
    if isinstance(req, dict):
        mode = req.get("mode", "continue")
        design = req.get("design")
        analysis = req.get("analysis")
        candidates = req.get("candidates")
        messages_raw = req.get("messages", [])
    else:
        mode = req.mode
        design = req.design
        analysis = req.analysis
        candidates = req.candidates
        messages_raw = req.messages

    last_user_prompt = ""
    for m in reversed(messages_raw):
        role = m.get("role") if isinstance(m, dict) else getattr(m, "role", "user")
        content = m.get("content") if isinstance(m, dict) else getattr(m, "content", "")
        if role == "user":
            last_user_prompt = content
            break

    # 1. Cache Lookup
    cache_key = _compute_cache_key(mode, design, messages_raw, analysis)
    cache = _load_cache()
    if cache_key in cache:
        cached_entry = cache[cache_key]
        ops = cached_entry.get("ops", [])
        try:
            patched_design, warnings = apply_ops(design, ops)
        except OpError as e:
            patched_design = copy.deepcopy(design) if design else {}
            warnings = [f"Cached ops could not be applied: {e}"]
            ops = []

        op_desc = [describe_op(op) for op in ops]
        return AgentChatResponse(
            assistant_message=cached_entry.get("assistant_message", ""),
            ops=ops,
            op_descriptions=op_desc,
            design=patched_design,
            warnings=warnings,
            action=cached_entry.get("action"),
            clarifying_question=cached_entry.get("clarifying_question"),
            source="cache",
        )

    # 2. Prepare LLM Call
    client = llm or get_llm()
    system_prompt = build_system_prompt(mode)
    prompt_messages = build_messages(mode, design, analysis, candidates, messages_raw)

    llm_output: Optional[Dict[str, Any]] = None
    llm_failed = False
    warning_list: List[str] = []

    # Number verification input ground-truth set for explain mode
    input_numbers: Set[float] = set()
    if mode == "explain":
        if analysis:
            input_numbers.update(_extract_all_numbers(analysis))
        if candidates:
            input_numbers.update(_extract_all_numbers(candidates))

    # Rate limiting: enforce minimum 1 second spacing between live LLM calls
    if isinstance(client, (GeminiLLM, OpenRouterLLM)):
        with _rate_limit_lock:
            now = time.perf_counter()
            elapsed = now - _last_live_call_time
            if elapsed < 1.0:
                time.sleep(1.0 - elapsed)
            _last_live_call_time = time.perf_counter()

    try:
        # Initial attempt
        raw_resp = client.chat_json(system_prompt, prompt_messages)
        if isinstance(raw_resp, dict) and "assistant_message" in raw_resp:
            llm_output = raw_resp
        else:
            raise LLMError("LLM output missing 'assistant_message'")

        # In explain mode: check number veracity
        if mode == "explain" and input_numbers:
            msg_text = llm_output.get("assistant_message", "")
            if not _verify_numbers_in_text(msg_text, input_numbers):
                # Retry once with strict feedback
                retry_messages = copy.deepcopy(prompt_messages)
                retry_messages.append({"role": "model", "content": json.dumps(llm_output)})
                retry_messages.append({
                    "role": "user",
                    "content": "Correction: Some numbers in your explanation do not match the input JSON. Repeat using ONLY the exact numbers from the findings and candidates JSON.",
                })
                with _rate_limit_lock:
                    time.sleep(1.0)
                    _last_live_call_time = time.perf_counter()

                raw_resp2 = client.chat_json(system_prompt, retry_messages)
                if isinstance(raw_resp2, dict) and "assistant_message" in raw_resp2:
                    if _verify_numbers_in_text(raw_resp2.get("assistant_message", ""), input_numbers):
                        llm_output = raw_resp2
                    else:
                        # Fallback to deterministic template explanation
                        llm_output = {
                            "assistant_message": template_explanation(analysis, candidates),
                            "ops": [],
                            "action": None,
                            "clarifying_question": None,
                        }

    except Exception as exc:
        # Transient failure: retry ONCE with error feedback if not already retried
        try:
            with _rate_limit_lock:
                time.sleep(1.0)
                _last_live_call_time = time.perf_counter()

            retry_messages = copy.deepcopy(prompt_messages)
            retry_messages.append({
                "role": "user",
                "content": f"The previous output failed validation: {exc}. Please return valid JSON conforming to the schema.",
            })
            raw_retry = client.chat_json(system_prompt, retry_messages)
            if isinstance(raw_retry, dict) and "assistant_message" in raw_retry:
                llm_output = raw_retry
            else:
                llm_failed = True
        except Exception:
            llm_failed = True

    # 3. Fallback when LLM is unavailable or failed
    if llm_failed or not llm_output:
        warning_list.append("AI unavailable, used offline rules")
        fallback_res = fallback_chat(
            user_text=last_user_prompt,
            design=design,
            mode=mode,
            analysis=analysis,
            candidates=candidates,
        )
        assistant_msg = fallback_res["assistant_message"]
        ops = fallback_res["ops"]
        action = fallback_res["action"]
        clarifying_q = fallback_res["clarifying_question"]
        source = "fallback"
    else:
        assistant_msg = str(llm_output.get("assistant_message", ""))
        ops = llm_output.get("ops", [])
        action = llm_output.get("action")
        clarifying_q = llm_output.get("clarifying_question")
        source = "llm"

    # 4. Apply Operations to Design
    try:
        patched_design, op_warnings = apply_ops(design, ops)
        warning_list.extend(op_warnings)
    except OpError as oe:
        warning_list.append(f"Failed to apply operations: {oe}")
        patched_design = copy.deepcopy(design) if design else {}
        ops = []

    op_descriptions = [describe_op(op) for op in ops]

    response_obj = AgentChatResponse(
        assistant_message=assistant_msg,
        ops=ops,
        op_descriptions=op_descriptions,
        design=patched_design,
        warnings=warning_list,
        action=action,
        clarifying_question=clarifying_q,
        source=source,
    )

    # 5. Save to Cache on LLM success
    if source == "llm":
        cache[cache_key] = {
            "assistant_message": assistant_msg,
            "ops": ops,
            "action": action,
            "clarifying_question": clarifying_q,
        }
        _save_cache(cache)

    return response_obj
