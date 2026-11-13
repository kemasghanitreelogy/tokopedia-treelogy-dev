# Treelogy print agent - the bridge between the dashboard and the printer on the bench.
#
# Runs on the laptop the label printer is plugged into. Asks the server for the next
# label job (waiting up to 20 s per ask so a press on any phone prints within a second),
# feeds the job's pages to the printer as raw bytes through the Windows spooler, and
# reports back. Nothing here knows what a label is; the server renders it.
#
# Config: %LOCALAPPDATA%\Treelogy\print-agent.json  { server, token, printer, name }
# Log:    %LOCALAPPDATA%\Treelogy\print-agent.log

param([string]$ConfigPath = (Join-Path $env:LOCALAPPDATA 'Treelogy\print-agent.json'))

$ErrorActionPreference = 'Stop'
$Version = '1'
$cfg = Get-Content -Path $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$server = ([string]$cfg.server).TrimEnd('/')
$token = [string]$cfg.token
$printer = [string]$cfg.printer
$name = if ($cfg.name) { [string]$cfg.name } else { $env:COMPUTERNAME }
$logPath = Join-Path (Split-Path $ConfigPath) 'print-agent.log'

function Write-Log([string]$message) {
  $line = '[{0}] {1}' -f (Get-Date -Format 's'), $message
  Add-Content -Path $logPath -Value $line -Encoding UTF8
  Write-Host $line
  # Keep the log from growing without end: a megabyte is weeks of labels.
  if ((Get-Item $logPath).Length -gt 1MB) {
    $keep = Get-Content $logPath -Tail 500
    Set-Content -Path $logPath -Value $keep -Encoding UTF8
  }
}

# Raw printing through winspool: the bytes go to the printer exactly as sent, the
# driver only carries them. This is how every TSPL/ZPL tool on Windows prints.
if (-not ('Treelogy.RawPrinter' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Treelogy {
  public static class RawPrinter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public class DOCINFOA {
      [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
      [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
      [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }
    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string szPrinter, out IntPtr hPrinter, IntPtr pd);
    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool ClosePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
    [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);

    public static void Send(string printer, byte[] bytes) {
      IntPtr h;
      if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("printer tidak ditemukan di Windows: " + printer);
      try {
        var di = new DOCINFOA(); di.pDocName = "Treelogy label"; di.pDataType = "RAW";
        if (!StartDocPrinter(h, 1, di)) throw new Exception("spooler menolak dokumen (StartDocPrinter)");
        StartPagePrinter(h);
        IntPtr p = Marshal.AllocCoTaskMem(bytes.Length);
        int written;
        bool ok;
        try { Marshal.Copy(bytes, 0, p, bytes.Length); ok = WritePrinter(h, p, bytes.Length, out written); }
        finally { Marshal.FreeCoTaskMem(p); }
        EndPagePrinter(h);
        EndDocPrinter(h);
        if (!ok || written != bytes.Length) throw new Exception("gagal menulis ke printer (" + written + "/" + bytes.Length + " byte)");
      } finally { ClosePrinter(h); }
    }
  }
}
'@
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$headers = @{ Authorization = "Bearer $token"; 'X-Agent-Name' = $name; 'X-Agent-Printer' = $printer; 'X-Agent-Version' = $Version }

Write-Log "agen mulai: $server -> printer '$printer' sebagai '$name'"
$backoff = 5

while ($true) {
  try {
    $resp = Invoke-WebRequest -Uri "$server/api/print-agent?wait=20" -Headers $headers -TimeoutSec 60 -UseBasicParsing
    $backoff = 5
    if ($resp.StatusCode -eq 204 -or -not $resp.Content) { continue }
    $job = $resp.Content | ConvertFrom-Json
    $pages = @($job.pages)
    Write-Log ('pekerjaan {0}: {1} halaman - {2}' -f $job.id, $pages.Count, $job.label)
    $ok = $true; $err = ''
    try {
      foreach ($page in $pages) { [Treelogy.RawPrinter]::Send($printer, [Convert]::FromBase64String($page)) }
    } catch {
      $ok = $false; $err = $_.Exception.Message
      Write-Log ('GAGAL cetak {0}: {1}' -f $job.id, $err)
    }
    $status = if ($ok) { 'done' } else { 'failed' }
    $body = @{ id = $job.id; status = $status; error = $err } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "$server/api/print-agent" -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 30 | Out-Null
    Write-Log ('selesai {0}: {1}' -f $job.id, $status)
  } catch {
    Write-Log ('koneksi: {0} - coba lagi {1} detik' -f $_.Exception.Message, $backoff)
    Start-Sleep -Seconds $backoff
    if ($backoff -lt 60) { $backoff = $backoff * 2 }
  }
}
