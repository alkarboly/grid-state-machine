from contextlib import asynccontextmanager

from fastapi import FastAPI
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


app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
