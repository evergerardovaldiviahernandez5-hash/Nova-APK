# NOVA APK

NOVA es un asistente local para **Android y Windows** que ejecuta modelos **GGUF** mediante `llama.cpp`, sin depender de una API de IA en la nube. Android ocupa la raíz del repositorio; todo lo específico del ejecutable de escritorio está en `Windows/`.

## Funciones

- Chat local con streaming, cancelación, regeneración y medición de tokens/s.
- Conversaciones persistentes, búsqueda, renombrado, copia, reenvío y exportación a Markdown.
- Adjuntos de imágenes y documentos de texto/código, con límites para proteger la memoria.
- Visión mediante un modelo multimodal compatible y su archivo `mmproj` GGUF; NOVA avisa si falta el proyector en lugar de simular análisis visual.
- Importación GGUF validada por extensión, cabecera, tamaño y copia completa.
- Interfaz compartida, responsive y sin CDN: SVG locales, fuentes locales, animación Matrix acotada y modo de movimiento reducido.
- Contexto, hilos y lote configurables; caché KV `q8_0`, una secuencia paralela y arranque sin warmup.
- Clúster real mediante el backend RPC de `llama.cpp`, con hasta ocho workers.
- Diagnóstico de proceso y registros acotados. Los servicios HTTP escuchan únicamente en loopback.

## Requisitos

### Android

- Android 9 o superior (API 28).
- ABI `arm64-v8a` recomendada; el workflow también genera `armeabi-v7a`.
- Espacio suficiente para el APK, el modelo y una copia temporal durante la importación.
- Un modelo GGUF compatible con `llama.cpp`. **El modelo no está incluido.**

### Windows

- Windows 10/11 x64 y Microsoft Edge WebView2 Runtime.
- Python 3.12, Git, CMake y Visual Studio 2022 Build Tools con C++ solamente para compilar.
- El ejecutable final se distribuye como carpeta `onedir`; no requiere Python instalado.

La build x64 evita AVX, AVX2, FMA y F16C para ser compatible con Intel Celeron B830 y usa SSE4.2. NOVA no puede ejecutarse como x64 en una edición Windows de 32 bits.

## Configuración recomendada para 4 GB de RAM

Como punto de partida prudente para un Celeron B830 con 4 GB DDR3:

| Ajuste | Valor inicial |
|---|---:|
| Modelo | 0.5B–1B, cuantización Q4 |
| Contexto | 1024 tokens |
| Hilos | 2 |
| Lote | 32 o 64 |
| Aplicaciones exigentes en segundo plano | Cerradas |

Un modelo de 1.5B Q4 puede ser viable según el sistema y la memoria disponible, pero será lento. Modelos de 3B o más, contextos de 4096/8192 y varios adjuntos grandes pueden agotar la memoria o provocar uso intensivo del archivo de paginación. Estas cifras son orientativas, no una garantía de velocidad o compatibilidad.

## Uso

1. Instala o abre NOVA.
2. Selecciona el archivo `.gguf` principal.
3. Para visión, selecciona también el `mmproj` correspondiente **a ese mismo modelo**.
4. Ajusta contexto, hilos y lote. Al guardar, el motor se reinicia con la nueva configuración.
5. Envía texto o adjunta hasta cuatro archivos por mensaje.

Límites del cliente: imágenes de hasta 12 MB y documentos de hasta 512 KB; el texto extraído se recorta a 180 000 caracteres para evitar picos de memoria. Las conversaciones y configuraciones permanecen en almacenamiento local. Windows conserva la configuración en `%LOCALAPPDATA%\Nova`; el modelo seleccionado permanece en su ubicación original.

## Compilación Android

Requisitos: JDK 17, Android SDK 34, build-tools 34, CMake 3.22.1 y NDK `27.0.12077973`.

```bash
export ANDROID_HOME=/ruta/al/android-sdk
export NDK_VERSION=27.0.12077973

git clone --depth 1 --branch v0.7.0 https://github.com/ggml-org/llama.cpp.git llama.cpp
test "$(git -C llama.cpp rev-parse HEAD)" = "757cad021b357f417065ddbc41a6e8f87c1f8136"

cmake -S llama.cpp -B llama.cpp/build-android \
  -DCMAKE_TOOLCHAIN_FILE="$ANDROID_HOME/ndk/$NDK_VERSION/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI=arm64-v8a \
  -DANDROID_PLATFORM=android-28 \
  -DANDROID_STL=c++_static \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_OPENMP=OFF \
  -DGGML_LLAMAFILE=OFF \
  -DGGML_RPC=ON \
  -DLLAMA_CURL=OFF \
  -DCMAKE_BUILD_TYPE=Release
cmake --build llama.cpp/build-android --parallel 2 --target llama-server

mkdir -p app/src/main/jniLibs/arm64-v8a
cp llama.cpp/build-android/bin/llama-server \
  app/src/main/jniLibs/arm64-v8a/libllama_server.so
"$ANDROID_HOME/ndk/$NDK_VERSION/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip" \
  --strip-unneeded app/src/main/jniLibs/arm64-v8a/libllama_server.so

./gradlew testDebugUnitTest assembleDebug -PnovaAbi=arm64-v8a
```

El APK de prueba queda en `app/build/outputs/apk/debug/app-debug.apk`. Para `armeabi-v7a`, repite la compilación nativa con esa ABI, copia el binario a su carpeta y usa `-PnovaAbi=armeabi-v7a`.

`app/src/main/jniLibs/` no se versiona: los workflows compilan el motor desde la revisión fijada antes de empaquetar.

### Release y firma

El workflow genera `Nova-2.0.0-<ABI>-unsigned.apk`. Debes alinearlo y firmarlo con tu propia clave:

```bash
zipalign -p -f 4 Nova-unsigned.apk Nova-aligned.apk
apksigner sign --ks tu-clave.jks --out Nova.apk Nova-aligned.apk
apksigner verify Nova.apk
```

No publiques la clave ni sus contraseñas. El `applicationId` se conserva como `com.jarvis.app` para permitir actualizar una instalación Jarvis existente; el nombre visible y la versión del producto son NOVA 2.0.0.

## Compilación Windows

Desde PowerShell, en la raíz del repositorio:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File Windows/build.ps1
```

El script:

1. Descarga y verifica `llama.cpp v0.7.0` por commit.
2. Compila `llama-server` y `ggml-rpc-server` con opciones compatibles con B830.
3. Empaqueta la interfaz compartida y el runtime con PyInstaller en modo `onedir`.
4. Genera `Windows/dist/Nova-Windows-x64.zip`.

Para probar el código Python sin generar el ejecutable:

```powershell
python -m pip install -r Windows/requirements.txt
$env:PYTHONPATH = "$PWD/Windows"
python -m unittest discover -s Windows/tests -v
```

## Clúster RPC en una LAN de confianza

**RPC es experimental, frágil y no cifrado. No lo expongas a Internet, redes públicas o equipos no confiables.** Limita el firewall a una red privada y, si es posible, a las IP concretas de los nodos. Un clúster puede ser más lento que un único equipo si la red o los workers son lentos.

En cada worker Windows, usa la IP privada de ese equipo:

```powershell
.\ggml-rpc-server.exe -H 192.168.1.20 -p 50052 -c
```

Después, en NOVA (Android o Windows), abre **Configuración → Clúster RPC**, activa **Distribuir inferencia** y añade un nodo por línea:

```text
192.168.1.20:50052
192.168.1.21:50052
```

Utiliza la misma revisión `v0.7.0` en coordinador y workers. Android actúa como coordinador; el paquete Windows incluye tanto el coordinador como el worker. La activación reinicia el motor y pasa realmente `--rpc host:puerto,...` a `llama-server`.

## CI y estructura

- `.github/workflows/build.yml`: pruebas y APK release sin firmar para `arm64-v8a` y `armeabi-v7a` en `master`.
- `.github/workflows/windows.yml`: pruebas, `Nova.exe` y ZIP portable x64 en `master`.
- `app/src/main/assets/ui/`: interfaz compartida.
- `app/src/main/java/com/jarvis/app/`: ciclo de vida Android, importación y proceso nativo.
- `Windows/nova/`: configuración, proceso, proxy loopback y API `pywebview`.

Las versiones de Gradle, plugins Android, NDK, `llama.cpp`, `pywebview` y PyInstaller están fijadas para evitar builds que cambian silenciosamente.

## Privacidad y límites de verificación

No hay analítica, cuentas, sincronización ni inferencia en servidores de NOVA. Los enlaces externos se abren fuera de la aplicación. La red HTTP local se restringe a `127.0.0.1`; RPC es la excepción deliberada cuando el usuario lo activa.

La compilación y las pruebas automatizadas no sustituyen una prueba en tu teléfono o en el B830 real. La velocidad, el consumo y la compatibilidad de cada GGUF dependen del modelo, su arquitectura, cuantización y memoria disponible.

Consulta `CREDITS.md` para las dependencias y licencias de terceros.
