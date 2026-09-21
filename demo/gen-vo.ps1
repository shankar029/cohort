param(
  [string]$LinesFile = "vo-lines.txt",
  [string]$OutDir = "audio",
  [string]$Voice = "Microsoft Zira Desktop",
  [int]$Rate = 0
)
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice($Voice)
$synth.Rate = $Rate
if (!(Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$raw = Get-Content -Raw -Path $LinesFile
$blocks = $raw -split "(?m)^====\s*$"
$i = 0
foreach ($b in $blocks) {
  $text = $b.Trim()
  if ([string]::IsNullOrWhiteSpace($text)) { continue }
  $i++
  $out = Join-Path $OutDir ("scene{0:D2}.wav" -f $i)
  $synth.SetOutputToWaveFile($out)
  $synth.Speak($text)
  Write-Host "wrote $out"
}
$synth.SetOutputToNull()
$synth.Dispose()
Write-Host "done: $i scenes"
