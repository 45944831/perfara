# 测量 Perfara 客户端启动期主进程 CPU 开销（反映启动路径上实际干了多少活：
# 模块解析、同步扫盘等）。窗口出现后再稳定采样 1.5s 的 CPU 时间。
param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [int]$Rounds = 3
)

function Measure-Cpu {
    param([string]$Path)
    $out = @()
    for ($i = 0; $i -lt $Rounds; $i++) {
        $p = Start-Process -FilePath $Path -PassThru
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $ok = $false
        while ($sw.Elapsed.TotalSeconds -lt 60) {
            $p.Refresh()
            if ($p.MainWindowHandle -ne 0 -and $p.MainWindowTitle -ne '') { $ok = $true; break }
            Start-Sleep -Milliseconds 10
        }
        $wall = $sw.Elapsed.TotalMilliseconds
        Start-Sleep -Milliseconds 1500
        $p.Refresh()
        $cpu = $p.TotalProcessorTime.TotalMilliseconds
        if ($ok) { $out += ("{0:N0}/{1:N0}" -f [math]::Round($wall), [math]::Round($cpu)) }
        try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch {}
        Start-Sleep -Seconds 2
    }
    return $out
}

$result = Measure-Cpu -Path $Exe
Write-Output ("RESULT_WALL_CPU=" + ($result -join '  '))
