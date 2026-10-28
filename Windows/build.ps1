param(
    [string]$LlamaRef = "v0.7.0",
    [string]$LlamaCommit = "757cad021b357f417065ddbc41a6e8f87c1f8136",
    [switch]$SkipLlama
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not $SkipLlama) {
    $source = ".build/llama.cpp"
    if (-not (Test-Path $source)) {
        git clone --depth 1 --branch $LlamaRef https://github.com/ggml-org/llama.cpp.git $source
        if ($LASTEXITCODE -ne 0) { throw "No se pudo descargar llama.cpp $LlamaRef" }
    }
    if ($LlamaCommit) {
        $actualCommit = (git -C $source rev-parse HEAD).Trim()
        if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $LlamaCommit) {
            throw "La copia de llama.cpp no coincide con $LlamaCommit. Elimina Windows/.build y vuelve a compilar."
        }
    }
    $build = ".build/windows-x64"
    # Intel B830: SSE4.2 sí; AVX/AVX2/FMA/F16C no. Runtime MSVC estático.
    cmake -S $source -B $build -A x64 `
        "-DCMAKE_BUILD_TYPE=Release" `
        "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded`$<`$<CONFIG:Debug>:Debug>" `
        "-DGGML_NATIVE=OFF" `
        "-DGGML_BACKEND_DL=OFF" `
        "-DGGML_SSE42=ON" `
        "-DGGML_AVX=OFF" `
        "-DGGML_AVX2=OFF" `
        "-DGGML_FMA=OFF" `
        "-DGGML_F16C=OFF" `
        "-DGGML_OPENMP=OFF" `
        "-DGGML_RPC=ON" `
        "-DBUILD_SHARED_LIBS=OFF" `
        "-DLLAMA_CURL=OFF"
    if ($LASTEXITCODE -ne 0) { throw "Error configurando llama.cpp" }
    cmake --build $build --config Release --target llama-server ggml-rpc-server --parallel 2
    if ($LASTEXITCODE -ne 0) { throw "Error compilando llama-server o el worker RPC" }

    New-Item -ItemType Directory -Force -Path "runtime" | Out-Null
    $server = Get-ChildItem -Path $build -Recurse -Filter "llama-server.exe" | Select-Object -First 1
    $worker = Get-ChildItem -Path $build -Recurse -Filter "ggml-rpc-server.exe" | Select-Object -First 1
    if (-not $server) { throw "No se generó llama-server.exe" }
    if (-not $worker) { throw "No se generó ggml-rpc-server.exe" }
    Copy-Item $server.FullName "runtime/llama-server.exe" -Force
    Copy-Item $worker.FullName "runtime/ggml-rpc-server.exe" -Force
    Get-ChildItem -Path $server.Directory.FullName -Filter "*.dll" -ErrorAction SilentlyContinue |
        Copy-Item -Destination "runtime" -Force
}

if (-not (Test-Path ".venv")) { python -m venv .venv }
& ".venv/Scripts/python.exe" -m pip install --disable-pip-version-check -r requirements-build.txt
if ($LASTEXITCODE -ne 0) { throw "No se pudieron instalar las dependencias" }
& ".venv/Scripts/python.exe" -m PyInstaller --noconfirm --clean Nova.spec
if ($LASTEXITCODE -ne 0) { throw "PyInstaller no pudo generar Nova.exe" }

$archive = "dist/Nova-Windows-x64.zip"
if (Test-Path $archive) { Remove-Item $archive -Force }
Compress-Archive -Path "dist/Nova/*" -DestinationPath $archive -CompressionLevel Optimal
Get-FileHash $archive -Algorithm SHA256 | Format-List
Write-Host "Nova listo: $archive" -ForegroundColor Green
