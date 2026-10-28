from __future__ import annotations

import os
from pathlib import Path
import subprocess
from typing import Any
from urllib.parse import urlparse
import webbrowser

import webview

from .config import NovaConfig
from .engine import LlamaProcess


class NovaApi:
    def __init__(self, config: NovaConfig, engine: LlamaProcess) -> None:
        self.config = config
        self.engine = engine

    def get_bootstrap(self) -> dict[str, Any]:
        return self.engine.status()

    def select_model(self) -> dict[str, Any]:
        return self._select_gguf(projector=False)

    def select_projector(self) -> dict[str, Any]:
        return self._select_gguf(projector=True)

    def _select_gguf(self, projector: bool) -> dict[str, Any]:
        if not webview.windows:
            raise RuntimeError("La ventana de Nova todavía no está disponible.")
        result = webview.windows[0].create_file_dialog(
            webview.OPEN_DIALOG,
            allow_multiple=False,
            file_types=("Modelos GGUF (*.gguf)",),
        )
        selected = self._first_path(result)
        if not selected:
            return self.engine.status()
        self.config.set_model(selected, projector=projector)
        self.engine.start_async()
        return self.engine.status()

    def apply_settings(self, settings: dict[str, Any]) -> dict[str, Any]:
        self.config.update_settings(settings)
        self.engine.start_async()
        return {"accepted": True}

    def export_text(self, filename: str, content: str) -> dict[str, Any]:
        if not webview.windows:
            raise RuntimeError("La ventana de Nova todavía no está disponible.")
        safe_name = Path(filename).name or "nova.md"
        result = webview.windows[0].create_file_dialog(webview.SAVE_DIALOG, save_filename=safe_name)
        destination = self._first_path(result)
        if not destination:
            return {"accepted": False, "cancelled": True}
        Path(destination).write_text(content, encoding="utf-8")
        return {"accepted": True}

    def share_text(self, text: str) -> dict[str, Any]:
        if os.name == "nt":
            subprocess.run(["clip.exe"], input=text[:200000], text=True, check=True, timeout=5)
            return {"accepted": True, "copied": True}
        raise RuntimeError("Usa la acción Copiar o Exportar en esta plataforma.")

    def open_external(self, url: str) -> dict[str, Any]:
        if urlparse(url).scheme not in {"http", "https"}:
            raise ValueError("Solo se permiten enlaces HTTP o HTTPS.")
        webbrowser.open(url, new=2)
        return {"accepted": True}

    def get_logs(self) -> str:
        return self.engine.logs()

    @staticmethod
    def _first_path(result: Any) -> str | None:
        if isinstance(result, (tuple, list)):
            return str(result[0]) if result else None
        return str(result) if result else None
