@echo off
chcp 65001 >nul
cd /d "%~dp0"
title WHUT绘跑 - 关闭本窗口即停止服务

where node >nul 2>nul || (
  echo [错误] 未找到 Node.js，请先安装 Node 18 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  echo 首次运行，正在安装依赖...
  call npm install || (
    echo [错误] 依赖安装失败
    pause
    exit /b 1
  )
)

netstat -ano | findstr ":6660" | findstr "LISTENING" >nul && (
  echo 端口 6660 已被占用，服务可能已经在运行了，直接打开页面。
  start http://localhost:6660/
  pause
  exit /b 0
)

echo 正在启动服务，3 秒后自动打开浏览器...
echo 关闭本窗口即停止服务。
echo.

rem 后台等 3 秒再开浏览器，免得页面比服务先到
start "" /b cmd /c "ping -n 4 127.0.0.1 >nul & start http://localhost:6660/"

node server.js

echo.
echo 服务已停止。
pause
