# Windows Credential Manager only. Never put a Telegram token in command
# arguments, Git, SQLite, log files, browser localStorage or exported messages.
param([ValidateSet('Read','Enroll','Status','SelfTest','IntegrationTest')][string]$Mode='Read')
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AutopilotTelegramCred {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags, Type;
    [MarshalAs(UnmanagedType.LPWStr)]public string TargetName;
    [MarshalAs(UnmanagedType.LPWStr)]public string Comment;
    public Int64 LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist, AttributeCount;
    public IntPtr Attributes;
    [MarshalAs(UnmanagedType.LPWStr)]public string TargetAlias;
    [MarshalAs(UnmanagedType.LPWStr)]public string UserName;
  }
  [DllImport("Advapi32.dll",EntryPoint="CredReadW",CharSet=CharSet.Unicode,SetLastError=true)]
  [return:MarshalAs(UnmanagedType.Bool)]
  static extern bool CredRead(string target,UInt32 type,UInt32 flags,out IntPtr ptr);
  [DllImport("Advapi32.dll",EntryPoint="CredWriteW",CharSet=CharSet.Unicode,SetLastError=true)]
  [return:MarshalAs(UnmanagedType.Bool)]
  static extern bool CredWrite(ref CREDENTIAL credential,UInt32 flags);
  [DllImport("Advapi32.dll",EntryPoint="CredFree",SetLastError=true)]
  static extern void CredFree(IntPtr ptr);
  [DllImport("Advapi32.dll",EntryPoint="CredDeleteW",CharSet=CharSet.Unicode,SetLastError=true)]
  [return:MarshalAs(UnmanagedType.Bool)]
  static extern bool CredDelete(string target,UInt32 type,UInt32 flags);
  public static void Delete(string target) {
    if(!CredDelete(target,1,0))throw new InvalidOperationException("Scratch cleanup failed");
  }
  public static string Read(string target) {
    IntPtr ptr;
    if(!CredRead(target,1,0,out ptr))throw new InvalidOperationException("Not configured");
    try {
      CREDENTIAL c=(CREDENTIAL)Marshal.PtrToStructure(ptr,typeof(CREDENTIAL));
      if(c.CredentialBlob==IntPtr.Zero||c.CredentialBlobSize<2||c.CredentialBlobSize>2048)
        throw new InvalidOperationException("Invalid credential");
      byte[] b=new byte[c.CredentialBlobSize];
      try {
        Marshal.Copy(c.CredentialBlob,b,0,b.Length);
        return new UTF8Encoding(false,true).GetString(b);
      }finally{Array.Clear(b,0,b.Length);}
    }finally{CredFree(ptr);}
  }
  public static void Write(string target,string value) {
    byte[] b=Encoding.UTF8.GetBytes(value);
    if(b.Length<2||b.Length>2048)throw new InvalidOperationException("Invalid length");
    IntPtr mem=Marshal.AllocHGlobal(b.Length);
    try {
      Marshal.Copy(b,0,mem,b.Length);
      CREDENTIAL c=new CREDENTIAL();
      c.Type=1;c.TargetName=target;c.UserName="development-autopilot";
      c.CredentialBlobSize=(uint)b.Length;c.CredentialBlob=mem;c.Persist=2;
      if(!CredWrite(ref c,0))throw new InvalidOperationException("Windows storage unavailable");
    }finally{
      Marshal.Copy(new byte[b.Length],0,mem,b.Length);
      Marshal.FreeHGlobal(mem);
      Array.Clear(b,0,b.Length);
    }
  }
}
'@
$target = 'DevelopmentAutopilot/TelegramNotifications/v1'
function Assert-Configuration($obj) {
  if ($null -eq $obj -or
      $obj.token -cnotmatch '^[0-9]{5,15}:[A-Za-z0-9_-]{30,}$' -or
      $obj.chatId -cnotmatch '^[1-9][0-9]{4,19}$') {
    throw 'Invalid Telegram enrollment'
  }
}
try {
  Add-Type -TypeDefinition $source -ErrorAction Stop
  if ($Mode -eq 'SelfTest') {
    $test = [pscustomobject]@{token=('12345678:' + ('A'*35));chatId='123456789'}
    Assert-Configuration $test
    foreach ($bad in @(
      [pscustomobject]@{token='bad';chatId='123456789'},
      [pscustomobject]@{token=$test.token;chatId='-100123456789'},
      [pscustomobject]@{token=$test.token;chatId='not-a-chat'}
    )) {
      $rejected=$false
      try { Assert-Configuration $bad }catch{$rejected=$true}
      if(-not $rejected){throw 'Synthetic invalid value accepted'}
    }
    [Console]::Out.Write('TELEGRAM_CREDENTIAL_SELFTEST_PASS')
    exit 0
  }
  if ($Mode -eq 'IntegrationTest') {
    # Isolated synthetic target; never read/overwrite a real enrolled bot.
    $scratch='DevelopmentAutopilot/TelegramNotifications/Scratch-'+[guid]::NewGuid().ToString('N')
    $sample=ConvertTo-Json -Compress -InputObject ([pscustomobject]@{
      token=('12345678:' + ('A'*35));chatId='123456789'
    })
    try {
      [AutopilotTelegramCred]::Write($scratch,$sample)
      if([AutopilotTelegramCred]::Read($scratch) -cne $sample) {
        throw 'Scratch credential round-trip failed'
      }
    } finally {
      [AutopilotTelegramCred]::Delete($scratch)
    }
    [Console]::Out.Write('TELEGRAM_WINDOWS_CREDENTIAL_ROUNDTRIP_PASS')
    exit 0
  }
  if ($Mode -eq 'Enroll') {
    if (-not [Environment]::UserInteractive) {
      throw 'Interactive console required'
    }
    $secure=Read-Host 'Telegram BotFather token (hidden)' -AsSecureString
    $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try{$token=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}
    finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
    # The new bot must first receive /start in a PRIVATE chat.
    # Discover only recent direct-chat requests; never guess a destination or
    # silently select an unrelated subscriber. No offset is acknowledged.
    $updates=Invoke-RestMethod -Uri ('https://api.telegram.org/bot'+$token+'/getUpdates') `
      -Method Post -ContentType 'application/json' `
      -Body '{"limit":100,"timeout":0,"allowed_updates":["message"]}' `
      -TimeoutSec 12 -ErrorAction Stop
    if($updates.ok -ne $true){throw 'Telegram bot enrollment unavailable'}
    $minimum=[DateTimeOffset]::UtcNow.AddMinutes(-30).ToUnixTimeSeconds()
    $candidates=@($updates.result | Where-Object {
      $_.message.chat.type -eq 'private' -and
      [string]$_.message.chat.id -eq [string]$_.message.from.id -and
      $_.message.text -match '^/start(?:\s|$)' -and
      [long]$_.message.date -ge $minimum
    } | ForEach-Object {[string]$_.message.chat.id} | Select-Object -Unique)
    if($candidates.Count -lt 1){throw 'Send /start to the new bot privately, then retry enrollment'}
    [Console]::Out.WriteLine('Private /start chat candidates (last 30 minutes):')
    foreach($candidate in $candidates){[Console]::Out.WriteLine('  '+$candidate)}
    $chatId=[string](Read-Host 'Confirm YOUR exact private chat ID from this list')
    if($chatId -cnotin $candidates){throw 'Private chat ID not in verified candidates'}
    $configuration=[pscustomobject]@{token=$token;chatId=$chatId}
    Assert-Configuration $configuration
    $value=ConvertTo-Json -Compress -InputObject $configuration
    [AutopilotTelegramCred]::Write($target,$value)
    $token=$null;$value=$null;$configuration=$null
    [Console]::Out.WriteLine('TELEGRAM_CREDENTIAL_STORED')
    exit 0
  }
  $raw=[AutopilotTelegramCred]::Read($target)
  $config=ConvertFrom-Json -InputObject $raw -ErrorAction Stop
  Assert-Configuration $config
  if($Mode -eq 'Status'){
    [Console]::Out.Write('TELEGRAM_CREDENTIAL_PRESENT')
    exit 0
  }
  # Read is invoked ONLY by the trusted local Node process; stdout must not be
  # redirected to a human-readable log.
  [Console]::Out.Write($raw)
  exit 0
}catch{
  [Console]::Error.Write('TELEGRAM_CREDENTIAL_NOT_CONFIGURED')
  exit 1
}
