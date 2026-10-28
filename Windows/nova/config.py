from __future__ import annotations

import ctypes
import json
import os
from pathlib import Path
import re
import sys
import threading
from typing import Any

APP_NAME = "Nova"
VERSION = "2.0.0"
NODE_PATTERN = re.compile(r"^[a-zA-Z0-9.-]+:[0-9]{1,5}$")
VALID_CONTEXTS = {512, 1024, 2048, 4096, 8192}
VALID_BATCHES = {32, 64, 128, 256, 512}


def resource_path(*parts: str) -> Path:
    """Read-only bundled resources in development and PyInstaller builds."""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        root = Path(getattr(sys, "_MEIPASS"))
        return root.joinpath(*parts)
    repository = Path(__file__).resolve().parents[2]
    if parts and parts[0] == "ui":
        return repository.joinpath("app", "src", "main", "assets", "ui", *parts[1:])
    return repository.joinpath("Windows", *parts)


def data_directory() -> Path:
    if os.name == "nt":
        root = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        root = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    path = root / APP_NAME
    path.mkdir(parents=True, exist_ok=True)
    return path


def available_memory_mb() -> int:
    if os.name == "nt":
        class MemoryStatus(ctypes.Structure):
            _fields_ = [
                ("length", ctypes.c_ulong), ("memory_load", ctypes.c_ulong),
                ("total_physical", ctypes.c_ulonglong), ("available_physical", ctypes.c_ulonglong),
                ("total_page_file", ctypes.c_ulonglong), ("available_page_file", ctypes.c_ulonglong),
                ("total_virtual", ctypes.c_ulonglong), ("available_virtual", ctypes.c_ulonglong),
                ("available_extended", ctypes.c_ulonglong),
            ]
        status = MemoryStatus()
        status.length = ctypes.sizeof(MemoryStatus)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return int(status.available_physical // (1024 * 1024))
    try:
        return int(os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE") // (1024 * 1024))
    except (AttributeError, OSError, ValueError):
        return 0


def format_bytes(size: int) -> str:
    if size >= 1024 ** 3:
        return f"{size / 1024 ** 3:.2f} GB"
    if size >= 1024 ** 2:
        return f"{size / 1024 ** 2:.1f} MB"
    return f"{size / 1024:.0f} KB"


def validate_gguf(path: str | Path) -> Path:
    candidate = Path(path).expanduser().resolve()
    if not candidate.is_file():
        raise ValueError("El archivo GGUF no existe.")
    if candidate.suffix.lower() != ".gguf":
        raise ValueError("El archivo debe tener extensión .gguf.")
    if candidate.stat().st_size <= 4:
        raise ValueError("El archivo GGUF está vacío o incompleto.")
    with candidate.open("rb") as stream:
        if stream.read(4) != b"GGUF":
            raise ValueError("La cabecera no corresponde a un archivo GGUF válido.")
    return candidate


class NovaConfig:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or data_directory() / "config.json"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._data = self._load()

    def _defaults(self) -> dict[str, Any]:
        cpu_count = os.cpu_count() or 2
        return {
            "model": "",
            "mmproj": "",
            "settings": {
                "context": 2048,
                "threads": max(1, min(4, cpu_count)),
                "batch": 64,
                "rpcEnabled": False,
                "rpcEndpoints": [],
            },
        }

    def _load(self) -> dict[str, Any]:
        defaults = self._defaults()
        if not self.path.exists():
            return defaults
        try:
            stored = json.loads(self.path.read_text(encoding="utf-8"))
            defaults["model"] = str(stored.get("model", ""))
            defaults["mmproj"] = str(stored.get("mmproj", ""))
            defaults["settings"].update(stored.get("settings", {}))
            defaults["settings"] = self.validate_settings(defaults["settings"])
            return defaults
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            corrupt = self.path.with_suffix(".invalid.json")
            try:
                self.path.replace(corrupt)
            except OSError:
                pass
            return defaults

    def _save(self) -> None:
        temp = self.path.with_suffix(".tmp")
        temp.write_text(json.dumps(self._data, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(self.path)

    @staticmethod
    def validate_settings(payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ValueError("La configuración no tiene un formato válido.")
        context = int(payload.get("context", 2048))
        threads = int(payload.get("threads", 2))
        batch = int(payload.get("batch", 64))
        if context not in VALID_CONTEXTS:
            raise ValueError("Contexto no admitido.")
        if batch not in VALID_BATCHES:
            raise ValueError("Lote no admitido.")
        if not 1 <= threads <= 16:
            raise ValueError("Los hilos deben estar entre 1 y 16.")
        raw_nodes = payload.get("rpcEndpoints", [])
        if isinstance(raw_nodes, str):
            raw_nodes = re.split(r"[,\n]+", raw_nodes)
        nodes: list[str] = []
        for value in raw_nodes:
            node = str(value).strip()
            if not node:
                continue
            if not NODE_PATTERN.fullmatch(node) or not 1 <= int(node.rsplit(":", 1)[1]) <= 65535:
                raise ValueError(f"Nodo RPC no válido: {node}")
            if node not in nodes:
                nodes.append(node)
        if len(nodes) > 8:
            raise ValueError("El límite es de 8 nodos RPC.")
        enabled = bool(payload.get("rpcEnabled", False))
        if enabled and not nodes:
            raise ValueError("Añade al menos un worker RPC o desactiva el clúster.")
        return {
            "context": context, "threads": threads, "batch": batch,
            "rpcEnabled": enabled, "rpcEndpoints": nodes,
        }

    @property
    def settings(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._data["settings"])

    @property
    def model(self) -> str:
        with self._lock:
            return self._data["model"]

    @property
    def mmproj(self) -> str:
        with self._lock:
            return self._data["mmproj"]

    def update_settings(self, payload: dict[str, Any]) -> dict[str, Any]:
        settings = self.validate_settings(payload)
        with self._lock:
            self._data["settings"] = settings
            self._save()
            return dict(settings)

    def set_model(self, path: str | Path, projector: bool = False) -> Path:
        candidate = validate_gguf(path)
        with self._lock:
            self._data["mmproj" if projector else "model"] = str(candidate)
            self._save()
        return candidate

    def bootstrap(self) -> dict[str, Any]:
        with self._lock:
            model = Path(self._data["model"]) if self._data["model"] else None
            projector = Path(self._data["mmproj"]) if self._data["mmproj"] else None
            settings = dict(self._data["settings"])
        model_exists = bool(model and model.is_file())
        projector_exists = bool(projector and projector.is_file())
        return {
            "platform": "windows",
            "version": VERSION,
            "modelName": model.name if model_exists else None,
            "modelSize": format_bytes(model.stat().st_size) if model_exists else None,
            "mmprojName": projector.name if projector_exists else None,
            "mmprojReady": projector_exists,
            "memoryAvailableMB": available_memory_mb(),
            "settings": settings,
        }
