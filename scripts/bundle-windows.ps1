param(
    [Parameter(Mandatory = $true)][ValidateSet('zip', 'verify')][string]$Action,
    [Parameter(Mandatory = $true)][string]$Source,
    [string]$Destination
)
$ErrorActionPreference = 'Stop'
if ($Action -eq 'zip') {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($Source, $Destination, [IO.Compression.CompressionLevel]::Optimal, $false)
} else {
    $signature = Get-AuthenticodeSignature -LiteralPath $Source
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike '*Microsoft Corporation*') {
        throw 'The bundled WebView2 executable must have a valid Microsoft signature.'
    }
}
