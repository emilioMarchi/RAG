@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1

echo ============================================
echo   RAG Studio - Inicio automatico (1ra vez)
echo ============================================
echo.

cd /d "%~dp0"

REM 1. Verificar Docker corriendo
echo [1/6] Verificando Docker Desktop...
docker info >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [AVISO] Docker no esta corriendo.
  echo   Por favor, abri Docker Desktop y espera a que termine de iniciar.
  echo   Luego volve a ejecutar este archivo.
  echo.
  pause
  exit /b 1
)
echo       Docker OK.

REM 2. Instalar dependencias si falta node_modules
echo [2/6] Verificando dependencias...
if not exist "node_modules" (
  echo   Instalando dependencias (puede tardar)...
  call npm install
  if errorlevel 1 ( echo   [ERROR] npm install fallo. & pause & exit /b 1 )
) else (
  echo   node_modules ya presente.
)

REM 3. Verificar/crear archivo .env
echo [3/6] Verificando .env...
if not exist ".env" (
  echo.
  echo   [INFO] No existe .env. Se creara una plantilla.
  echo   Completa las API keys (Gemini y OpenRouter) en el archivo .env
  echo   antes de usar la app.
  echo.
  copy ".env.example" ".env" >nul
  if not exist ".env" ( echo   No se pudo crear .env & pause & exit /b 1 )
)

REM 4. Levantar contenedor de base de datos
echo [4/6] Levantando base de datos (PostgreSQL + pgvector)...
docker compose up -d
echo   Esperando que PostgreSQL este listo...
for /l %%i in (1,1,40) do (
  timeout /t 1 /nobreak >nul
  docker exec pgvector pg_isready -U postgres >nul 2>&1
  if not errorlevel 1 goto db_ready
)
echo   [ERROR] La base de datos no respondio a tiempo.
pause
exit /b 1

:db_ready
echo   Base de datos lista.

REM 5. Migraciones
echo [5/6] Ejecutando migraciones...
call npm run migrate
if errorlevel 1 ( echo   [ERROR] Migracion fallo. & pause & exit /b 1 )

REM 6. Arrancar la app
echo [6/6] Iniciando RAG Studio...
call npm run electron:dev

echo.
pause