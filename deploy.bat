@echo off
title Deploy Gemini Live Translator to Cloudflare
cls
echo ========================================================
echo   正在发布 Gemini 实时双语同传到 Cloudflare...
echo ========================================================
echo.

:: 优先从本地 .env 中读取 CLOUDFLARE_API_TOKEN（防密钥泄露）
if "%CLOUDFLARE_API_TOKEN%"=="" (
    if exist "%~dp0.env" (
        for /f "usebackq tokens=1,* delims==" %%A in ("%~dp0.env") do (
            if "%%A"=="CLOUDFLARE_API_TOKEN" set "CLOUDFLARE_API_TOKEN=%%B"
        )
    )
)

echo [1/2] 正在更新安全中继后端 (Worker)...
cd /d "%~dp0worker"
call npx wrangler deploy

echo.
echo [2/2] 正在发布生产版前端...
cd /d "%~dp0"
call npx wrangler deploy

echo.
echo ========================================================
echo   正式版发布完成！
echo   前端安全访问地址：https://gemini-live-translator.chinanetysj.workers.dev
echo   中继网关地址：    https://live-translator-backend.chinanetysj.workers.dev
echo ========================================================
echo.
pause
