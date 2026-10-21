# Open every Word file (.docx) in a folder in a separate, hidden Word and every workbook (.xlsx) in
# a separate, hidden Excel, read only, and report any that opens only by being repaired. Only the
# Word and Excel processes started here are closed.
#
#   powershell -ExecutionPolicy Bypass -File office_check.ps1 -Dir <folder>
#
# Word is asked not to repair (OpenAndRepair off), so a file it must repair fails to open. Excel
# repairs without asking when alerts are off; a repaired workbook's window says "Repaired" and Excel
# writes its repair log (error*.xml) to the temp folder, so either counts as a repair.
param(
    [Parameter(Mandatory = $true)][string]$Dir
)
$ErrorActionPreference = 'Stop'
$failed = 0

function Close-New([string]$name, [int[]]$before) {
    Start-Sleep -Seconds 2
    Get-Process $name -ErrorAction SilentlyContinue |
        Where-Object { $before -notcontains $_.Id } |
        ForEach-Object { Write-Output "closing leftover $name $($_.Id)"; Stop-Process -Id $_.Id -Force }
}

$docs = @(Get-ChildItem -Path $Dir -Filter *.docx -File)
if ($docs.Count) {
    $before = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    $word = New-Object -ComObject Word.Application
    try {
        $word.Visible = $false
        $word.DisplayAlerts = 0
        foreach ($f in $docs) {
            try {
                # FileName, ConfirmConversions, ReadOnly, AddToRecentFiles, PasswordDocument,
                # PasswordTemplate, Revert, WritePasswordDocument, WritePasswordTemplate, Format,
                # Encoding, Visible, OpenAndRepair
                $d = $word.Documents.Open($f.FullName, $false, $true, $false, '', '', $false, '', '', 0, 0, $false, $false)
                $pages = $d.ComputeStatistics(2)
                Write-Output "Word opened $($f.Name): $pages pages, $($d.InlineShapes.Count) pictures, $($d.Tables.Count) tables, $($d.Sections.Count) sections"
                $d.Close($false)
            } catch {
                $failed++
                Write-Output "Word could not open $($f.Name) without repairing it: $($_.Exception.Message)"
            }
        }
    } finally {
        $word.Quit()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
        [GC]::Collect()
        [GC]::WaitForPendingFinalizers()
        Close-New 'WINWORD' $before
    }
}

$books = @(Get-ChildItem -Path $Dir -Filter *.xlsx -File)
if ($books.Count) {
    $before = @(Get-Process EXCEL -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    $xl = New-Object -ComObject Excel.Application
    try {
        $xl.Visible = $false
        $xl.DisplayAlerts = $false
        $xl.ScreenUpdating = $false
        foreach ($f in $books) {
            $logs = @(Get-ChildItem -Path $env:TEMP -Filter 'error*.xml' -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
            try {
                $wb = $xl.Workbooks.Open($f.FullName, 0, $true)
                $caption = $wb.Windows.Item(1).Caption
                $new = @(Get-ChildItem -Path $env:TEMP -Filter 'error*.xml' -File -ErrorAction SilentlyContinue |
                    Where-Object { $logs -notcontains $_.FullName })
                if ($caption -match 'Repaired' -or $new.Count) {
                    $failed++
                    Write-Output "Excel repaired $($f.Name): $caption $($new | ForEach-Object { $_.Name })"
                } else {
                    Write-Output "Excel opened $($f.Name): $($wb.Worksheets.Count) sheets"
                }
                $wb.Close($false)
            } catch {
                $failed++
                Write-Output "Excel could not open $($f.Name): $($_.Exception.Message)"
            }
        }
    } finally {
        $xl.Quit()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl)
        [GC]::Collect()
        [GC]::WaitForPendingFinalizers()
        Close-New 'EXCEL' $before
    }
}

if ($failed) { Write-Output "$failed files needed repair"; exit 1 }
Write-Output 'every file opened without repair'
