@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo [1/3] 准备虚拟环境 .venv ...
if not exist ".venv\Scripts\python.exe" (
    python -m venv .venv
    if errorlevel 1 (
        echo [error] 未找到 python，请先安装 Python 3.9+ 并加入 PATH
        pause
        exit /b 1
    )
)

echo [2/3] 安装依赖 ...
".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
".venv\Scripts\python.exe" -m pip install -r requirements.txt pyinstaller
if errorlevel 1 (
    echo [error] 依赖安装失败
    pause
    exit /b 1
)

echo [3/3] 打包单文件 exe ...
".venv\Scripts\python.exe" -m PyInstaller perfara.spec --noconfirm --clean
if errorlevel 1 (
    echo [error] 打包失败
    pause
    exit /b 1
)

echo.
echo 完成：dist\Perfara.exe
echo 双击运行即可；数据保存在 exe 同目录的 data\ 与 logs\ 下。
pause
