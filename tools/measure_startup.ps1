# 测量 Perfara 客户端冷启动耗时：进程启动 -> 主窗口创建完成
# 用法: powershell -ExecutionPolicy Bypass -File measure_startup.ps1 <exe路径> [轮数]
param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [int]$Rounds = 3
)

function Measure-Startup {
    param([string]$Path)
    $times = @()
    for ($i = 0; $i -lt $Rounds; $i++) {
        $p = Start-Process -FilePath $Path -PassThru
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $ok = $false
        while ($sw.Elapsed.TotalSeconds -lt 60) {
            $p.Refresh()
            if ($p.MainWindowHandle -ne 0 -and $p.MainWindowTitle -ne '') { $ok = $true; break }
            Start-Sleep -Milliseconds 10
        }
        $sw.Stop()
        if ($ok) { $times += [math]::Round($sw.Elapsed.TotalMilliseconds) }
        else { $times += -1 }
        try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch {}
        Start-Sleep -Seconds 2
    }
    return $times
}

$result = Measure-Startup -Path $Exe
Write-Output ("RESULT_MS=" + ($result -join ','))
