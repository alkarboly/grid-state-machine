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


@app.get("/api/site/{site_id}")
def site(site_id: str):
    detail = fleet.site_detail(site_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="unknown site")
    return detail


app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
