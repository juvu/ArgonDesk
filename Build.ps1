#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw '需要 Windows 自带的 .NET Framework 4.x C# 编译器。' }
$sourcePath = Join-Path $PSScriptRoot 'native\ArgonDesk.cs'
$iconPath = Join-Path $PSScriptRoot 'app-icon.ico'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll ('/win32icon:' + $iconPath) ('/out:' + (Join-Path $PSScriptRoot 'ArgonDesk.exe')) $sourcePath
if ($LASTEXITCODE) { throw '桌面入口编译失败。' }
Write-Output 'ArgonDesk.exe 已生成。'
