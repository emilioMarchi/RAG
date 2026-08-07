@echo off
setlocal

echo ============================================
echo   RAG Studio - Inicio automatico
echo ============================================
echo.

REM 1. Check Docker is running
docker info >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Docker no esta corriendo.
  echo Por favor, abri Docker Desktop y espera a que inicie.
  echo Luego volve a ejecutar este archivo.
  pause
  exit /b 1
)

echo [1/4] Docker detectado. Verificando contenedor de base de datos...

REM 2. Check if the container exists
docker ps -a | findstr /i "pgvector" >nul 2>&1
if errorlevel 1 (
  echo [2/4] No existe el contenedor. Creandolo...
  docker compose up -d
) else (
  echo [2/4] Contenedor existe. Iniciandolo...
  docker start pgvector
)

echo [3/4] Esperando a que PostgreSQL este listo...
REM 3. Wait for Postgres to be ready
for /l %%i in (1,1,30) do (
  timeout /t 1 /nobreak >nul
  docker exec pgvector pg_isready -U postgres >nul 2>&1
  if not errorlevel 1 goto db_ready
)
echo [ERROR] La base de datos no respondio a tiempo.
pause
exit /b 1

:db_ready
echo [4/4] Base de datos lista. Iniciando RAG Studio...

REM 4. Run migrate (idempotente) y arrancar la app
call npm run migrate >nul 2>&1
call npm run electron:dev

echo.
pause