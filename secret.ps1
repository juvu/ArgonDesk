param([ValidateSet('Protect', 'Unprotect')][string]$Mode)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')
$value = [Console]::In.ReadToEnd()
if ($Mode -eq 'Protect') {
    $secure = ConvertTo-SecureString -String $value -AsPlainText -Force
    [Console]::Out.Write((ConvertFrom-SecureString -SecureString $secure))
} else {
    $secure = ConvertTo-SecureString -String $value
    $credential = [System.Net.NetworkCredential]::new('', $secure)
    [Console]::Out.Write($credential.Password)
}
