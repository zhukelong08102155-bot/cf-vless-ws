@echo off
setlocal enabledelayedexpansion

REM Push cf-vless-ws to GitHub.
REM
REM Prerequisite: an EMPTY repo named cf-vless-ws must already exist at
REM   https://github.com/wujunjr/cf-vless-ws
REM Create it at https://github.com/new  --  set it Public, and do NOT tick
REM "Add a README file" / ".gitignore" / "license" (this repo already has them).
REM
REM If you would rather let gh create the repo itself, run these instead:
REM   gh auth refresh -s repo -h github.com
REM   gh repo create cf-vless-ws --public --source=. --remote=origin --push
REM
REM Secret scanning:
REM   Patterns are read from secrets-scan-patterns.txt (one per line).
REM   That file is gitignored on purpose -- if the real values lived inside
REM   this script, the script itself would leak them. See the .example file.

cd /d "%~dp0"

echo.
echo === checking prerequisites ===
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo [ERROR] not a git repository: %CD%
  exit /b 1
)

echo.
echo === remote ===
git remote get-url origin >nul 2>&1
if errorlevel 1 (
  echo adding origin ...
  git remote add origin https://github.com/wujunjr/cf-vless-ws.git
) else (
  echo origin already set:
  git remote get-url origin
)

echo.
echo === current branch ===
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set BR=%%b
echo %BR%
if not "%BR%"=="main" (
  echo renaming %BR% -^> main ...
  git branch -M main
)

echo.
echo === pre-push secret scan ===
set "PATFILE=secrets-scan-patterns.txt"
if not exist "%PATFILE%" (
  echo [WARN] %PATFILE% not found - skipping secret scan.
  echo        Copy secrets-scan-patterns.txt.example to %PATFILE% and fill in
  echo        your real values. It is gitignored, so it will not be committed.
  goto push
)

set "LEAK=0"
set "N=0"
for /f "usebackq delims=" %%P in ("%PATFILE%") do (
  set /a N+=1
  git grep -qF "%%P" HEAD >nul 2>&1
  if not errorlevel 1 (
    echo [ABORT] secret matched in tracked files: %%P
    set "LEAK=1"
  )
)
if "%LEAK%"=="1" (
  echo.
  echo Aborted. Remove the secret before pushing.
  exit /b 1
)
echo scanned %N% pattern^(s^) - clean

:push
echo.
echo === pushing ===
git push -u origin main
if errorlevel 1 (
  echo.
  echo [FAILED] If the error says the repository does not exist, go create it first:
  echo   https://github.com/new   name=cf-vless-ws  Public  leave everything else unticked
  exit /b 1
)

echo.
echo === done ===
echo   https://github.com/wujunjr/cf-vless-ws
endlocal
