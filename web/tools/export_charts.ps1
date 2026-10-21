# Open CEICA calculators in a separate, hidden Excel instance and save each chart on the Charts
# sheet as a PNG next to the workbook. Only the Excel process started here is closed.
# This is how the calculator's charts were checked when they were drawn; use it after any change to
# them.
#
#   powershell -ExecutionPolicy Bypass -File export_charts.ps1 -Dir <folder> -Names utoy-creek,staf-demo
#
# Expects <folder>\<name>-calculator.xlsx and writes <folder>\<name>-chart<i>.png.
param(
    [Parameter(Mandatory = $true)][string]$Dir,
    [string[]]$Names = @('utoy-creek', 'staf-demo')
)
$ErrorActionPreference = 'Stop'
$before = @(Get-Process EXCEL -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$xl = New-Object -ComObject Excel.Application
try {
    $xl.Visible = $false
    $xl.DisplayAlerts = $false
    $xl.ScreenUpdating = $false
    foreach ($name in $Names) {
        $wb = $xl.Workbooks.Open("$Dir\$name-calculator.xlsx", 0, $true)
        try {
            $xl.CalculateFull()
            $ws = $wb.Worksheets.Item('Charts')
            $n = $ws.ChartObjects().Count
            for ($i = 1; $i -le $n; $i++) {
                $png = "$Dir\$name-chart$i.png"
                $null = $ws.ChartObjects($i).Chart.Export($png)
                Write-Output "wrote $png"
            }
        } finally {
            $wb.Close($false)
        }
    }
} finally {
    $xl.Quit()
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl)
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    Start-Sleep -Seconds 2
    Get-Process EXCEL -ErrorAction SilentlyContinue |
        Where-Object { $before -notcontains $_.Id } |
        ForEach-Object { Write-Output "closing leftover Excel $($_.Id)"; Stop-Process -Id $_.Id -Force }
}
