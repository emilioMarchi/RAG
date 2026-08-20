@echo off
setlocal EnableDelayedExpansion

echo ============================================
echo   RAG Studio - Launcher
echo ============================================
echo.
cd /d "%~dp0"

REM 1. Check Docker running
echo [1/7] Checking Docker Desktop...
docker info >nul 2>&1
if errorlevel 1 goto nodocker
echo       Docker OK.

REM 2. Install dependencies if missing
echo [2/7] Checking dependencies...
if exist "node_modules" goto deps_ok
echo   Installing dependencies (this may take a while)...
call npm install
if errorlevel 1 goto npm_fail
:deps_ok
echo   node_modules already present.

REM 3. Ensure .env exists
echo [3/7] Checking .env...
if exist ".env" goto env_ok
echo   Creating .env from template...
copy /y ".env.example" ".env" >nul
if not exist ".env" goto env_fail
echo   .env created. Fill in the API keys before using.
:env_ok

REM 4. Start database container
echo [4/7] Starting database (PostgreSQL + pgvector)...
docker container inspect pgvector >nul 2>&1
if errorlevel 1 goto compose_up
echo   Existing container found, starting it...
docker start pgvector >nul 2>&1
goto wait_db

:compose_up
docker compose up -d

:wait_db
echo   Waiting for PostgreSQL to be ready...
set /a tries=0
:wait_db
timeout /t 1 /nobreak >nul
docker exec pgvector pg_isready -U postgres >nul 2>&1
if not errorlevel 1 goto db_ready
set /a tries+=1
if %tries% GEQ 40 goto db_fail
goto wait_db

:db_ready
echo   Database ready.

REM 5. Run migrations
echo [5/7] Running migrations...
call npm run migrate
if errorlevel 1 goto migrate_fail

REM 6. Pre-cargar modelos locales (embedding + reranker)
echo [6/7] Pre-cargando modelos locales (primera vez descarga ~200MB)...
call npx tsx src/warmup.ts
if errorlevel 1 goto warmup_fail

REM 7. Launch app (web interface)
echo [7/7] Starting RAG Studio (web)...
start "" http://localhost:3000
call npm run dev
echo.
goto end

:nodocker
echo.
echo   [ERROR] Docker Desktop is not running.
echo   Please open Docker Desktop, wait until ready, then rerun this file.
echo.
goto end

:npm_fail
echo.
echo   [ERROR] npm install failed.
echo.
goto end

:env_fail
echo.
echo   [ERROR] Could not create .env
echo.
goto end

:db_fail
echo.
echo   [ERROR] PostgreSQL no esta listo tras 40 intentos.
echo.
goto end

:migrate_fail
echo.
echo   [ERROR] Migration failed.
echo.
goto end

:warmup_fail
echo.
echo   [ERROR] Fallo al pre-cargar modelos locales.
echo   Verifica conexion a internet (descarga de HF) y espacio en disco.
echo.
goto end

:end
pause