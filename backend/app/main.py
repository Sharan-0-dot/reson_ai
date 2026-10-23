"""ResonAI backend FastAPI application.

Provides structural dynamics analysis, component isolation optimization,
conversational agent triage, and analytical suite validation.
"""

import json
import os
from pathlib import Path
import platform
import threading
import time
from typing import Any, Dict, List, Optional, Union
import numpy as np
import scipy
from scipy import linalg

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.cache import LRUCache, canonical_design_hash
from app.presets import get_all_presets, get_demo_design
from app.schemas import (
    AgentChatRequest,
    AgentChatResponse,
    AgentHealthResponse,
    AnalyzeResponse,
    ComponentResponse,
    DesignModel,
    LocksModel,
    NodeResponse,
    OptimizeRequest,
    OptimizeResponse,
    ResponseAtRequest,
    ResponseAtResponse,
)
from app.agent.service import handle_chat
from app.optimizer.optimize import optimize_design
from app.solver.pipeline import solve_design
from app.solver.post import build_response
from app.validation.suite import run_validation

# Load environment variables
load_dotenv()

# CORS configuration supporting comma-separated FRONTEND_ORIGIN
raw_origins = os.getenv("FRONTEND_ORIGIN", "http://localhost:3000,http://127.0.0.1:3000")
ALLOWED_ORIGINS = [origin.strip() for origin in raw_origins.split(",") if origin.strip()]
for default_origin in ["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:5173"]:
    if default_origin not in ALLOWED_ORIGINS:
        ALLOWED_ORIGINS.append(default_origin)

app = FastAPI(
    title="ResonAI Solver Backend",
    version="0.1.0",
    description="Pre-FEM vibration triage simulator for beam/frame structures with vibrating components.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def limit_request_size(request: Request, call_next):
    """Enforce a strict 1 MB payload size limit on incoming requests."""
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > 1_048_576:
                return JSONResponse(
                    status_code=413,
                    content={
                        "error": "payload_too_large",
                        "detail": "Request body exceeds maximum allowed size of 1 MB (1048576 bytes)",
                    },
                )
        except ValueError:
            pass
    return await call_next(request)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Global exception handler returning clean JSON error without raw tracebacks."""
    if isinstance(exc, HTTPException):
        headers = getattr(exc, "headers", None)
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail},
            headers=headers,
        )
    if isinstance(exc, RequestValidationError):
        return JSONResponse(
            status_code=422,
            content={"detail": exc.errors()},
        )
    return JSONResponse(
        status_code=500,
        content={"error": "internal_error", "detail": str(exc)},
    )


# In-memory caches and concurrency locks
MOCK_FILE = Path(__file__).resolve().parent / "mock_analyze.json"
_VALIDATION_CACHE: Optional[Dict[str, Any]] = None
_ANALYZE_CACHE = LRUCache(maxsize=64)
_RESPONSE_AT_CACHE = LRUCache(maxsize=256)
_OPTIMIZE_LOCK = threading.Lock()


def check_guard_rails(design: DesignModel) -> None:
    """Validate physical and computational boundary limits on incoming designs."""
    if len(design.members) > 60:
        raise HTTPException(
            status_code=422,
            detail=f"Design exceeds maximum allowed members: {len(design.members)} > 60",
        )
    if len(design.components) > 25:
        raise HTTPException(
            status_code=422,
            detail=f"Design exceeds maximum allowed components: {len(design.components)} > 25",
        )
    if not design.supports:
        raise HTTPException(
            status_code=422,
            detail="structure is unstable or under-constrained: no supports or grounded springs defined",
        )

    # Check for zero-length members
    node_map = {n.id: n for n in design.nodes}
    for m in design.members:
        n1 = node_map.get(m.n1)
        n2 = node_map.get(m.n2)
        if n1 is not None and n2 is not None:
            dx = n2.x - n1.x
            dy = n2.y - n1.y
            dz = n2.z - n1.z
            length = (dx * dx + dy * dy + dz * dz) ** 0.5
            if length <= 1e-7:
                raise HTTPException(
                    status_code=422,
                    detail=f"Member '{m.id}' has zero length",
                )

    # Check analysis bounds
    if design.analysis:
        extra_dict = getattr(design.analysis, "__pydantic_extra__", {}) or {}
        n_pts = extra_dict.get("rpm_points", getattr(design.analysis, "n_points", None))
        if n_pts is not None and (n_pts < 10 or n_pts > 2000):
            raise HTTPException(
                status_code=422,
                detail=f"Analysis rpm_points must be between 10 and 2000, got {n_pts}",
            )
        rpm_max = extra_dict.get("rpm_max", getattr(design.analysis, "rpm_max", None))
        if rpm_max is not None and rpm_max > 60000.0:
            raise HTTPException(
                status_code=422,
                detail=f"Analysis rpm_max must not exceed 60000 RPM, got {rpm_max}",
            )

    # Check DOF ceiling (max 3000 free DOFs)
    n_elem = design.analysis.n_elements_per_member if design.analysis else 4
    est_mesh_nodes = len(design.nodes) + len(design.members) * (n_elem - 1)
    est_free_dofs = est_mesh_nodes * 3 + len(design.components)
    if est_free_dofs > 3000:
        raise HTTPException(
            status_code=422,
            detail=f"Design exceeds maximum allowed free DOFs: {est_free_dofs} > 3000",
        )


def check_finite(data: Any) -> None:
    """Ensure no NaN or Infinite values appear in simulation outputs."""
    if isinstance(data, dict):
        for v in data.values():
            check_finite(v)
    elif isinstance(data, (list, tuple)):
        for item in data:
            check_finite(item)
    elif isinstance(data, (float, np.floating)):
        if not np.isfinite(data):
            raise HTTPException(
                status_code=422,
                detail="Numerical instability: calculation produced NaN or Inf values in response",
            )


def get_cached_or_live_validation(refresh: bool = False) -> Dict[str, Any]:
    global _VALIDATION_CACHE
    if not refresh and _VALIDATION_CACHE is not None:
        return _VALIDATION_CACHE

    val_data = run_validation()

    from scripts.benchmark import run_benchmark_row

    live_row = run_benchmark_row(20, n_points=400, label="live_20_elements")
    bench_live = {
        "n_dof": live_row["n_dofs"],
        "dense_ms": round(live_row["dense_ms"], 2),
        "sparse_ms": round(live_row["sparse_ms"], 2),
        "rom_setup_ms": round(live_row["rom_setup_ms"], 2),
        "rom_sweep_ms": round(live_row["rom_sweep_ms"], 2),
        "rom_total_ms": round(live_row["rom_total_ms"], 2),
        "speedup_vs_dense": round(live_row["speedup_vs_dense"], 1),
        "speedup_vs_sparse": round(live_row["speedup_vs_sparse"], 1),
        "max_error_pct": round(live_row["max_error_pct"], 4),
    }

    bench_json_path = Path(__file__).resolve().parent.parent.parent / "benchmark_report.json"
    if not bench_json_path.exists():
        bench_json_path = Path(__file__).resolve().parent / "benchmark_report.json"

    bench_cached = {}
    if bench_json_path.exists():
        try:
            with open(bench_json_path, "r", encoding="utf-8") as f:
                bench_cached = json.load(f)
        except Exception:
            bench_cached = {}

    environment = {
        "os": f"{platform.system()} {platform.release()} ({platform.machine()})",
        "cpu": platform.processor() or platform.machine(),
        "cores": os.cpu_count() or 16,
        "python": platform.python_version(),
        "numpy": np.__version__,
        "scipy": scipy.__version__,
    }

    payload = {
        "cases": val_data["cases"],
        "summary": val_data["summary"],
        "mesh_convergence": val_data["mesh_convergence"],
        "mesh_convergence_pass": val_data["mesh_convergence_pass"],
        "benchmark": bench_cached.get("summary", {}),
        "benchmark_cached": bench_cached,
        "benchmark_live": bench_live,
        "environment": environment,
    }

    _VALIDATION_CACHE = payload
    return payload


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok", "app": "ResonAI", "version": "0.1.0"}


@app.get("/presets")
def presets() -> Dict[str, Any]:
    return get_all_presets()


@app.get("/presets/{name}/design")
def preset_design(name: str) -> Dict[str, Any]:
    """Return fully specified preset design model by name."""
    try:
        return get_demo_design(name)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/validate")
def validate_get(refresh: bool = Query(default=False)) -> Dict[str, Any]:
    """Return solver validation report and benchmark performance."""
    return get_cached_or_live_validation(refresh=refresh)


@app.post("/validate")
def validate_post(refresh: bool = Query(default=False)) -> Dict[str, Any]:
    """Execute/retrieve solver validation report (per 00_MASTER_CONTEXT.md 6.5)."""
    return get_cached_or_live_validation(refresh=refresh)


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(design: DesignModel, response: Response) -> AnalyzeResponse:
    """Execute real reduced-order vibration analysis on the provided design."""
    d_hash = canonical_design_hash(design)
    cached = _ANALYZE_CACHE.get(d_hash)
    if cached is not None:
        response.headers["X-Cache"] = "HIT"
        return cached

    check_guard_rails(design)
    try:
        result = solve_design(design, method="rom")
        response_dict = build_response(design, result)
        check_finite(response_dict)
        res_obj = AnalyzeResponse.model_validate(response_dict)
        _ANALYZE_CACHE.set(d_hash, res_obj)
        response.headers["X-Cache"] = "MISS"
        return res_obj
    except HTTPException:
        raise
    except (scipy.linalg.LinAlgError, np.linalg.LinAlgError) as e:
        raise HTTPException(
            status_code=422,
            detail=f"structure is unstable or under-constrained: {str(e)}",
        )
    except ValueError as e:
        err_msg = str(e)
        if "singular" in err_msg.lower() or "not positive definite" in err_msg.lower():
            raise HTTPException(
                status_code=422,
                detail=f"structure is unstable or under-constrained: {err_msg}",
            )
        raise HTTPException(status_code=422, detail=err_msg)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Solver error: {str(e)}")


@app.post("/analyze/mock", response_model=AnalyzeResponse)
def analyze_mock() -> AnalyzeResponse:
    """Return pre-computed contract-compliant mock response for frontend development."""
    if not MOCK_FILE.exists():
        from scripts.make_mock import generate_mock_data

        data = generate_mock_data()
        with open(MOCK_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)

    with open(MOCK_FILE, "r", encoding="utf-8") as f:
        mock_data = json.load(f)

    return AnalyzeResponse.model_validate(mock_data)


@app.post("/response_at", response_model=ResponseAtResponse)
def response_at(req: ResponseAtRequest, response: Response) -> ResponseAtResponse:
    """Compute complex harmonic response at a single specified RPM for animation."""
    d_hash = canonical_design_hash(req.design)
    cache_key = (d_hash, round(float(req.rpm), 1))
    cached = _RESPONSE_AT_CACHE.get(cache_key)
    if cached is not None:
        response.headers["X-Cache"] = "HIT"
        return cached

    check_guard_rails(req.design)
    try:
        rpm = float(req.rpm)
        omega = 2.0 * np.pi * (rpm / 60.0)

        result = solve_design(req.design, rpm_array=[rpm], method="rom")

        x_orders = result.X_full_orders if result.X_full_orders else [result.X_full]
        orders = result.orders if result.orders else [1.0]

        best_norm = -1.0
        best_idx = 0
        for idx, x_mat in enumerate(x_orders):
            norm = float(np.linalg.norm(x_mat[0, : result.mesh.n_dofs]))
            if norm > best_norm:
                best_norm = norm
                best_idx = idx

        best_X = x_orders[best_idx][0]
        best_order = orders[best_idx]

        node_responses: List[NodeResponse] = []
        for i, node in enumerate(result.mesh.nodes):
            ux_c = complex(best_X[3 * i])
            uy_c = complex(best_X[3 * i + 1])
            rot_c = complex(best_X[3 * i + 2])
            node_responses.append(
                NodeResponse(
                    id=node.id,
                    ux=[float(np.real(ux_c)), float(np.imag(ux_c))],
                    uy=[float(np.real(uy_c)), float(np.imag(uy_c))],
                    rot=[float(np.real(rot_c)), float(np.imag(rot_c))],
                )
            )

        comp_responses: List[ComponentResponse] = []
        for comp in req.design.components:
            cid = comp.id
            if cid in result.model.comp_dof:
                c_dof = result.model.comp_dof[cid]
                comp_c = complex(best_X[c_dof])
                comp_responses.append(
                    ComponentResponse(
                        id=cid,
                        uy=[float(np.real(comp_c)), float(np.imag(comp_c))],
                    )
                )

        resp_obj = ResponseAtResponse(
            rpm=round(rpm, 2),
            omega=round(omega, 2),
            order=float(best_order),
            nodes=node_responses,
            components=comp_responses,
        )
        check_finite(resp_obj.model_dump())
        _RESPONSE_AT_CACHE.set(cache_key, resp_obj)
        response.headers["X-Cache"] = "MISS"
        return resp_obj
    except HTTPException:
        raise
    except (scipy.linalg.LinAlgError, np.linalg.LinAlgError) as e:
        raise HTTPException(
            status_code=422,
            detail=f"structure is unstable or under-constrained: {str(e)}",
        )
    except ValueError as e:
        err_msg = str(e)
        if "singular" in err_msg.lower() or "not positive definite" in err_msg.lower():
            raise HTTPException(
                status_code=422,
                detail=f"structure is unstable or under-constrained: {err_msg}",
            )
        raise HTTPException(status_code=422, detail=err_msg)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Response evaluation error: {str(e)}")


@app.post("/optimize", response_model=OptimizeResponse)
def optimize(req: OptimizeRequest) -> Any:
    """Optimize component mounts and positions to minimize sensor vibrations."""
    if not _OPTIMIZE_LOCK.acquire(blocking=False):
        return JSONResponse(
            status_code=409,
            content={"error": "busy", "detail": "an optimisation is already running"},
        )
    try:
        check_guard_rails(req.design)
        design_dict = req.design.model_dump()
        locks = req.locks or LocksModel()
        max_evals = req.budget.max_evals if req.budget else 1200
        seed = req.seed if req.seed is not None else 1
        movable = req.movable

        return optimize_design(
            design=design_dict,
            locks=locks,
            objective=req.objective,
            max_evals=max_evals,
            seed=seed,
            movable=movable,
        )
    except HTTPException:
        raise
    except (scipy.linalg.LinAlgError, np.linalg.LinAlgError) as e:
        raise HTTPException(
            status_code=422,
            detail=f"structure is unstable or under-constrained: {str(e)}",
        )
    except ValueError as e:
        err_msg = str(e)
        if "singular" in err_msg.lower() or "not positive definite" in err_msg.lower():
            raise HTTPException(
                status_code=422,
                detail=f"structure is unstable or under-constrained: {err_msg}",
            )
        raise HTTPException(status_code=422, detail=err_msg)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Optimization error: {str(e)}")
    finally:
        _OPTIMIZE_LOCK.release()


@app.post("/agent/chat", response_model=AgentChatResponse)
def agent_chat_endpoint(req: AgentChatRequest) -> AgentChatResponse:
    """Conversational engineering assistant for structural dynamics design and vibration triage."""
    try:
        return handle_chat(req)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Agent error: {str(e)}")


@app.get("/agent/health", response_model=AgentHealthResponse)
def agent_health_endpoint() -> AgentHealthResponse:
    """Check if LLM provider key and model are configured (booleans only, never exposes keys)."""
    api_key = (os.getenv("OPENROUTER_API_KEY") or os.getenv("GEMINI_API_KEY", "")).strip()
    model = (os.getenv("OPENROUTER_MODEL") or os.getenv("GEMINI_MODEL", "")).strip()
    return AgentHealthResponse(
        configured=bool(api_key),
        model_configured=bool(model),
    )
