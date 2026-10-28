from __future__ import annotations

import ctypes
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import sys

import webview

from .api import NovaApi
from .config import data_directory, resource_path
from .engine import LlamaProcess
from .gateway import NovaGateway
from .config import NovaConfig


def configure_logging() -> None:
    log_directory = data_directory() / "logs"
    log_directory.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(log_directory / "nova.log", maxBytes=512_000, backupCount=2, encoding="utf-8")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s", handlers=[handler])


def already_running() -> bool:
    if os.name != "nt":
        return False
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = kernel.CreateMutexW(None, False, "Local\\NovaLocalAI-2")
    if ctypes.get_last_error() != 183:  # ERROR_ALREADY_EXISTS
        return False
    kernel.CloseHandle(handle)
    return True


def main() -> int:
    configure_logging()
    if already_running():
        ctypes.windll.user32.MessageBoxW(None, "Nova ya está abierto.", "NOVA", 0x40)
        return 0
    config = NovaConfig()
    engine = LlamaProcess(config)
    gateway = NovaGateway(engine, resource_path("ui"))
    gateway.start()
    api = NovaApi(config, engine)
    if config.model:
        engine.start_async()
    try:
        webview.create_window(
            "NOVA · Inteligencia local",
            gateway.url,
            width=1280,
            height=800,
            min_size=(900, 600),
            background_color="#050A08",
            js_api=api,
            text_select=True,
        )
        webview.start(
            debug=os.environ.get("NOVA_DEBUG") == "1",
            private_mode=False,
            storage_path=str(data_directory() / "webview"),
        )
    except Exception:
        logging.exception("Error fatal en la interfaz de Nova")
        raise
    finally:
        engine.stop()
        gateway.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
