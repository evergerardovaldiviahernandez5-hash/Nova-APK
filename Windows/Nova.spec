# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules

windows_dir = Path.cwd()
ui_dir = (windows_dir.parent / "app" / "src" / "main" / "assets" / "ui").resolve()
runtime_dir = windows_dir / "runtime"
if not ui_dir.is_dir():
    raise RuntimeError(f"Shared UI not found: {ui_dir}")
if not (runtime_dir / "llama-server.exe").is_file():
    raise RuntimeError("Run build.ps1 first so runtime/llama-server.exe is available")

runtime_files = [(str(path), "runtime") for path in runtime_dir.iterdir() if path.is_file()]

a = Analysis(
    ["nova/app.py"],
    pathex=[str(windows_dir)],
    binaries=runtime_files,
    datas=[(str(ui_dir), "ui"), (str(windows_dir / "assets" / "nova.png"), "assets")],
    hiddenimports=collect_submodules("webview.platforms"),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Nova",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(windows_dir / "assets" / "nova.ico"),
    version=str(windows_dir / "version_info.txt"),
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="Nova",
)
