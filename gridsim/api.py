from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from gridsim import config
from gridsim.state import fleet


@asynccontextmanager
async def lifespan(_app: FastAPI):
    fleet.start()
    yield
    fleet.stop()


app = FastAPI(title="gridsim", lifespan=lifespan)

_origins = [item.strip() for item in config.WEB_ORIGIN.split(",") if item.strip()]
if _origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_origins,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )


@app.get("/api/scene")
def scene():
    return fleet.scene()


@app.get("/api/dispatch")
def dispatch():
    return fleet.dispatch_view()


@app.post("/api/dispatch")
def post_dispatch(body: dict):
    signal = body.get("signal")
    if signal not in ("push", "pull", "hold", "auto"):
        raise HTTPException(status_code=400, detail="signal must be push, pull, hold, or auto")
    intensity = body.get("intensity")
    if intensity is not None:
        try:
            intensity = float(intensity)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="intensity must be a number") from None
        if not 0.0 <= intensity <= 1.0:
            raise HTTPException(status_code=400, detail="intensity must be from 0 to 1")
    fleet.set_order(signal, intensity)
    return fleet.dispatch_view()


@app.get("/api/agent")
def agent():
    return fleet.agent_view()


@app.post("/api/agent")
def post_agent(body: dict):
    site_id = body.get("site_id")
    if not isinstance(site_id, str) or not site_id:
        raise HTTPException(status_code=400, detail="site_id is required")
    chart_id = body.get("chart_id")
    armed = body.get("armed") if "armed" in body else None
    dispatch = body.get("dispatch") if "dispatch" in body else None
    grid = body.get("grid") if "grid" in body else None
    if chart_id is not None and not isinstance(chart_id, str):
        raise HTTPException(status_code=400, detail="chart_id must be a string")
    if armed is not None and not isinstance(armed, bool):
        raise HTTPException(status_code=400, detail="armed must be true or false")
    if dispatch is not None and not isinstance(dispatch, bool):
        raise HTTPException(status_code=400, detail="dispatch must be true or false")
    if grid is not None and not isinstance(grid, bool):
        raise HTTPException(status_code=400, detail="grid must be true or false")
    try:
        return fleet.arm(site_id, chart_id, armed, dispatch, grid)
    except KeyError:
        raise HTTPException(status_code=404, detail="unknown site") from None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None


@app.post("/api/actions")
def post_action(body: dict):
    site_id = body.get("site_id")
    kind = body.get("kind")
    if not isinstance(site_id, str) or not site_id:
        raise HTTPException(status_code=400, detail="site_id is required")
    if not isinstance(kind, str):
        raise HTTPException(status_code=400, detail="kind is required")
    payload = body.get("payload") if isinstance(body.get("payload"), dict) else {}
    note = body.get("note") if isinstance(body.get("note"), str) else ""
    try:
        return fleet.add_action(site_id, kind, note, payload, "api")
    except KeyError:
        raise HTTPException(status_code=404, detail="unknown site") from None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None


@app.get("/api/site/{site_id}")
def site(site_id: str):
    detail = fleet.site_detail(site_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="unknown site")
    return detail


if config.SERVE_STATIC:
    app.mount("/", StaticFiles(directory=config.WEB, html=True), name="web")
