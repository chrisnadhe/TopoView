"""
Network Topology Visualizer — FastAPI backend
Run: uvicorn main:app --reload --port 8000
"""

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
import json

from parser import parse_config, build_topology

app = FastAPI(title="Network Topology Visualizer", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static files (JS, CSS)
static_path = Path(__file__).parent.parent / "frontend" / "static"
app.mount("/static", StaticFiles(directory=str(static_path)), name="static")

frontend_path = Path(__file__).parent.parent / "frontend"


@app.get("/", response_class=HTMLResponse)
async def root():
    index = frontend_path / "index.html"
    return HTMLResponse(content=index.read_text(encoding="utf-8"), status_code=200)


@app.post("/api/parse")
async def parse_configs(files: list[UploadFile] = File(...)):
    """
    Accept multiple config files, parse them, return topology JSON.
    """
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")

    devices = []
    errors = []

    for upload in files:
        try:
            content = (await upload.read()).decode("utf-8", errors="replace")
            device = parse_config(content, filename=upload.filename)
            devices.append(device)
        except Exception as e:
            errors.append({"file": upload.filename, "error": str(e)})

    if not devices:
        raise HTTPException(status_code=422, detail={"message": "No valid configs parsed", "errors": errors})

    topology = build_topology(devices)
    topology["parse_errors"] = errors
    topology["file_count"] = len(devices)

    return topology


@app.post("/api/parse-demo")
async def parse_demo():
    """Load sample configs from disk for demo/testing."""
    sample_dir = Path(__file__).parent.parent / "sample_configs"
    devices = []
    for cfg_file in sorted(sample_dir.glob("*.txt")):
        content = cfg_file.read_text()
        device = parse_config(content, filename=cfg_file.name)
        devices.append(device)

    topology = build_topology(devices)
    topology["parse_errors"] = []
    topology["file_count"] = len(devices)
    return topology


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "1.0.0"}