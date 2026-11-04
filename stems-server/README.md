# MotionDJ stems server

Servidor local que usa Meta Demucs para separar canciones en VOZ, BATERÍA, BAJO y RESTO. Procesa un trabajo a la vez y conserva los resultados en caché.

Arrancar desde PowerShell:

```powershell
.\stems-server\start.ps1
```

Escucha en `127.0.0.1:8765`. Opciones: `--host`, `--port`, `--cache` y `--device` (`cuda` o `cpu`). Por defecto, la caché está en `D:\MotionDJ-ia\cache` y se usa CUDA si está disponible.

- `GET /health`: estado, modelo y dispositivo.
- `POST /separate`: audio en bruto (máximo 60 MiB), con `X-Filename` opcional codificado como URL; devuelve el ID SHA-256 y el estado.
- `GET /status/<id>`: estado, progreso y error.
- `GET /stems/<id>/<vocals|drums|bass|other>.wav`: descarga un stem.

Las canciones del usuario y la caché NO se suben al repositorio: se guardan localmente fuera del proyecto por defecto.
