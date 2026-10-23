"""In-memory LRU caching and canonical design hashing utilities.

Provides thread-safe LRU caching for simulation sweeps and single-frequency animations,
and SHA-256 canonical hashing of structural designs (stripping 'ui' fields and sorting keys).
"""

from collections import OrderedDict
import copy
import hashlib
import json
import threading
from typing import Any, Dict, Optional, Tuple, Union


def canonical_design_dict(design: Any) -> Dict[str, Any]:
    """Extract canonical design dictionary stripping UI attributes and empty fields."""
    if design is None:
        return {}
    if hasattr(design, "model_dump"):
        data = design.model_dump()
    elif isinstance(design, dict):
        data = copy.deepcopy(design)
    else:
        try:
            data = copy.deepcopy(vars(design))
        except TypeError:
            return {}

    def _clean(obj: Any) -> Any:
        if isinstance(obj, dict):
            res = {}
            for k in sorted(obj.keys()):
                if k in ("ui", "mesh", "cached", "drawing"):
                    continue
                v_clean = _clean(obj[k])
                if v_clean is not None and v_clean != "" and v_clean != []:
                    res[k] = v_clean
            return res
        elif isinstance(obj, list):
            return [_clean(x) for x in obj if x is not None]
        elif isinstance(obj, float):
            return round(obj, 6)
        return obj

    return _clean(data)


def canonical_design_hash(design: Any) -> str:
    """Compute deterministic SHA-256 hex digest for a structural design model."""
    clean_d = canonical_design_dict(design)
    raw = json.dumps(clean_d, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class LRUCache:
    """Thread-safe in-memory Least Recently Used (LRU) cache."""

    def __init__(self, maxsize: int = 64):
        self.maxsize = maxsize
        self._cache: OrderedDict[Any, Any] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: Any) -> Optional[Any]:
        with self._lock:
            if key not in self._cache:
                return None
            self._cache.move_to_end(key)
            return self._cache[key]

    def set(self, key: Any, value: Any) -> None:
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
            self._cache[key] = value
            if len(self._cache) > self.maxsize:
                self._cache.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._cache.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._cache)
