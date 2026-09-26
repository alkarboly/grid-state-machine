from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles

from gridsim.config import WEB
from gridsim.state import fleet


@asynccontextmanager
async def lifespan(_app: FastAPI):
    fleet.start()
    yield
    fleet.stop()


app = FastAPI(title="gridsim", lifespan=lifespan)


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


@app.get("/api/site/{site_id}")
def site(site_id: str):
    detail = fleet.site_detail(site_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="unknown site")
    return detail


app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
