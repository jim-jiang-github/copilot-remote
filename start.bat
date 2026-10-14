@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ========================================================
echo             Copilot Remote 手机/网页控制器
echo ========================================================
echo.
echo [1/2] 正在检查服务状态...

if not exist ".local\relay-probe-config.json" (
  echo.
  echo [提示] 尚未绑定协调会话。
  echo 请在 Copilot PC 端打开当前项目，在会话中执行绑定后再启动。
  echo.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; try { $response = Invoke-WebRequest -Uri 'http://127.0.0.1:8765/api/account' -TimeoutSec 3 -UseBasicParsing; if ($response.StatusCode -eq 200) { Write-Host '[2/2] 服务运行正常 (http://127.0.0.1:8765)'; Write-Host '正在打开默认浏览器...'; Start-Process 'http://127.0.0.1:8765'; exit 0; } } catch { Write-Host '[提示] 后台服务未运行。'; Write-Host '原因：本服务依托 Copilot PC 客户端运行。'; Write-Host '请在 Copilot PC 客户端打开本项目并在会话中输入 extensions_reload。'; exit 1; }"

if errorlevel 1 (
  echo.
  echo 启动失败，请先在 Copilot PC 客户端确认会话已打开。
  echo.
) else (
  echo.
  echo 控制面板已在浏览器中打开：http://127.0.0.1:8765
  echo 服务正由 Copilot PC 客户端在后台持续运行。
  echo.
)

pause
endlocal

