# Windows Credential Manager only. Never put a Telegram token in command
# arguments, Git, SQLite, log files, browser localStorage or exported messages.
param([ValidateSet('Read','Enroll','Status','SelfTest','IntegrationTest')][string]$Mode='Read', [string]$ExpectedUsername='')
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
  # Compile native WinCred helpers only when needed. Never block opening
  # the GUI token input while C# Add-Type/antivirus is still compiling.
  if ($Mode -eq 'SelfTest') {
    Add-Type -TypeDefinition $source -ErrorAction Stop
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
    Add-Type -TypeDefinition $source -ErrorAction Stop
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
      throw 'TELEGRAM_INTERACTIVE_WINDOWS_SESSION_REQUIRED'
    }
    # Windows Forms gives ordinary Ctrl+V support instead of relying on the
    # terminal's Read-Host / ^V semantics. The token is NEVER echoed.
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
      throw 'TELEGRAM_GUI_REQUIRES_STA'
    }
    $form=New-Object System.Windows.Forms.Form
    $form.Text='Development Autopilot - Telegram bot setup'
    $form.ClientSize=[System.Drawing.Size]::new(520,168)
    $form.StartPosition='CenterScreen'
    $form.FormBorderStyle='FixedDialog'
    $form.MaximizeBox=$false
    $form.MinimizeBox=$false
    $form.TopMost=$true
    $label=New-Object System.Windows.Forms.Label
    $label.Text='Paste your NEW BotFather token (Ctrl+V works here):'
    $label.Location=[System.Drawing.Point]::new(18,18)
    $label.AutoSize=$true
    $tokenBox=New-Object System.Windows.Forms.TextBox
    $tokenBox.Location=[System.Drawing.Point]::new(18,51)
    $tokenBox.Size=[System.Drawing.Size]::new(484,25)
    $tokenBox.UseSystemPasswordChar=$true
    $tokenBox.ShortcutsEnabled=$true
    $ok=New-Object System.Windows.Forms.Button
    $ok.Text='Verify bot'
    $ok.Location=[System.Drawing.Point]::new(386,109)
    $ok.Size=[System.Drawing.Size]::new(116,31)
    $ok.DialogResult=[System.Windows.Forms.DialogResult]::OK
    $cancel=New-Object System.Windows.Forms.Button
    $cancel.Text='Cancel'
    $cancel.Location=[System.Drawing.Point]::new(266,109)
    $cancel.Size=[System.Drawing.Size]::new(108,31)
    $cancel.DialogResult=[System.Windows.Forms.DialogResult]::Cancel
    $form.Controls.AddRange([System.Windows.Forms.Control[]]@($label,$tokenBox,$ok,$cancel))
    $form.AcceptButton=$ok
    $form.CancelButton=$cancel
    # Focus is set without an event callback; $input is a PowerShell
    # automatic pipeline variable inside event scriptblocks.
    $form.ActiveControl=$tokenBox
    try {
      $answer=$form.ShowDialog()
      if($answer -ne [System.Windows.Forms.DialogResult]::OK) {
        throw 'TELEGRAM_TOKEN_INPUT_CANCELLED'
      }
      $token=$tokenBox.Text.Trim()
      $tokenBox.Clear()
    } finally {
      $form.Dispose()
    }
    if($token -cnotmatch '^[0-9]{5,15}:[A-Za-z0-9_-]{30,}$') {
      throw 'TELEGRAM_TOKEN_FORMAT_INVALID'
    }
    $progress=New-Object System.Windows.Forms.Form
    $progress.Text='Autopilot Telegram - Verifying'
    $progress.ClientSize=[System.Drawing.Size]::new(480,118)
    $progress.StartPosition='CenterScreen'
    $progress.FormBorderStyle='FixedDialog'
    $progress.ControlBox=$false
    $progress.TopMost=$true
    $progress.ShowInTaskbar=$false
    $progressLabel=New-Object System.Windows.Forms.Label
    $progressLabel.Text='Checking BotFather token with Telegram...'
    $progressLabel.Location=[System.Drawing.Point]::new(18,16)
    $progressLabel.AutoSize=$true
    $bar=New-Object System.Windows.Forms.ProgressBar
    $bar.Location=[System.Drawing.Point]::new(18,52)
    $bar.Size=[System.Drawing.Size]::new(444,23)
    $bar.Style=[System.Windows.Forms.ProgressBarStyle]::Marquee
    $progress.Controls.AddRange([System.Windows.Forms.Control[]]@($progressLabel,$bar))
    $progress.Show()
    $progress.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
    # Verify the actual bot identity instead of accepting an arbitrary token.
    try {
      $me=Invoke-RestMethod -Uri ('https://api.telegram.org/bot'+$token+'/getMe') -Method Post -TimeoutSec 12 -ErrorAction Stop
    } catch {
      throw 'TELEGRAM_BOT_TOKEN_REJECTED_OR_NETWORK_ERROR'
    }
    if($me.ok -ne $true -or $me.result.is_bot -ne $true -or
       [string]::IsNullOrWhiteSpace([string]$me.result.username)) {
      throw 'TELEGRAM_BOT_IDENTITY_UNVERIFIED'
    }
    if($ExpectedUsername -and $me.result.username -ine $ExpectedUsername.TrimStart('@')) {
      throw 'TELEGRAM_BOT_USERNAME_MISMATCH'
    }
    # Telegram can keep updates for up to 24 hours. Resend /start if needed.
    $progressLabel.Text='Checking your private /start chat (up to 12 seconds)...'
    $progress.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
    try {
      $updates=Invoke-RestMethod -Uri ('https://api.telegram.org/bot'+$token+'/getUpdates') -Method Post -ContentType 'application/json' -Body '{"limit":100,"timeout":0,"allowed_updates":["message"]}' -TimeoutSec 12 -ErrorAction Stop
    } catch {
      throw 'TELEGRAM_GET_UPDATES_FAILED'
    }
    if($updates.ok -ne $true) {throw 'TELEGRAM_GET_UPDATES_FAILED'}
    $minimum=[DateTimeOffset]::UtcNow.AddHours(-23).ToUnixTimeSeconds()
    $candidates=@($updates.result | Where-Object {
      $null -ne $_.message -and
      $_.message.chat.type -eq 'private' -and
      [string]$_.message.chat.id -eq [string]$_.message.from.id -and
      $_.message.text -match '^/start(?:\s|$)' -and
      [long]$_.message.date -ge $minimum
    } | ForEach-Object {
      [pscustomobject]@{
        Id=[string]$_.message.chat.id
        Display=([string]$_.message.from.first_name + ' (@' +
          [string]$_.message.from.username + ') - ID ' +
          [string]$_.message.chat.id)
      }
    } | Sort-Object Id -Unique)
    if($candidates.Count -eq 0) {
      throw 'TELEGRAM_START_NOT_FOUND_SEND_START_AGAIN'
    }
    $progress.Hide()
    # Explicitly select the user's own private chat without typing or copying
    # numeric IDs. No auto-selection from other people who started the bot.
    $choose=New-Object System.Windows.Forms.Form
    $choose.Text='Confirm your private Telegram chat - @'+[string]$me.result.username
    $choose.ClientSize=[System.Drawing.Size]::new(580,218)
    $choose.StartPosition='CenterScreen'
    $choose.FormBorderStyle='FixedDialog'
    $choose.MaximizeBox=$false
    $choose.MinimizeBox=$false
    $choose.TopMost=$true
    $intro=New-Object System.Windows.Forms.Label
    $intro.Text='Select ONLY your own /start private chat:'
    $intro.Location=[System.Drawing.Point]::new(18,14)
    $intro.AutoSize=$true
    $list=New-Object System.Windows.Forms.ListBox
    $list.Location=[System.Drawing.Point]::new(18,42)
    $list.Size=[System.Drawing.Size]::new(543,111)
    foreach($candidate in $candidates) {[void]$list.Items.Add($candidate.Display)}
    $confirm=New-Object System.Windows.Forms.Button
    $confirm.Text='Save to Windows'
    $confirm.Location=[System.Drawing.Point]::new(411,169)
    $confirm.Size=[System.Drawing.Size]::new(150,30)
    # DialogResult avoids referencing unbound event-scriptblock variables.
    $confirm.DialogResult=[System.Windows.Forms.DialogResult]::OK
    $cancelChoice=New-Object System.Windows.Forms.Button
    $cancelChoice.Text='Cancel'
    $cancelChoice.Location=[System.Drawing.Point]::new(294,169)
    $cancelChoice.Size=[System.Drawing.Size]::new(104,30)
    $cancelChoice.DialogResult=[System.Windows.Forms.DialogResult]::Cancel
    $choose.Controls.AddRange([System.Windows.Forms.Control[]]@($intro,$list,$confirm,$cancelChoice))
    $choose.CancelButton=$cancelChoice
    $choose.AcceptButton=$confirm
    try {
      $chosen=$choose.ShowDialog()
      if($chosen -ne [System.Windows.Forms.DialogResult]::OK -or $list.SelectedIndex -lt 0){
        throw 'TELEGRAM_CHAT_SELECTION_CANCELLED'
      }
      $chatId=[string]$candidates[$list.SelectedIndex].Id
    } finally {
      $choose.Dispose()
    }
    $configuration=[pscustomobject]@{token=$token;chatId=$chatId}
    Assert-Configuration $configuration
    $value=ConvertTo-Json -Compress -InputObject $configuration
    $progress.Show()
    try {
      $progressLabel.Text='Saving to Windows Credential Manager...'
      $progress.Refresh()
      [System.Windows.Forms.Application]::DoEvents()
      Add-Type -TypeDefinition $source -ErrorAction Stop
      [AutopilotTelegramCred]::Write($target,$value)
    } catch {
      throw 'TELEGRAM_WINDOWS_CREDENTIAL_SAVE_FAILED'
    }
    if($null -ne $progress){$progress.Close();$progress.Dispose();$progress=$null}
    $token=$null;$value=$null;$configuration=$null
    [void][System.Windows.Forms.MessageBox]::Show('Telegram bot connected and stored in Windows.','Development Autopilot', 'OK','Information')
    [Console]::Out.WriteLine('TELEGRAM_CREDENTIAL_STORED')
    exit 0
  }
  Add-Type -TypeDefinition $source -ErrorAction Stop
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
  # Distinct SAFE reason codes; never print exception text, token or Bot API
  # response bodies, which can contain the token-bearing request URL.
  if($Mode -eq 'Enroll'){
    $safe=@(
      'TELEGRAM_INTERACTIVE_WINDOWS_SESSION_REQUIRED',
      'TELEGRAM_GUI_REQUIRES_STA',
      'TELEGRAM_TOKEN_INPUT_CANCELLED',
      'TELEGRAM_TOKEN_FORMAT_INVALID',
      'TELEGRAM_BOT_TOKEN_REJECTED_OR_NETWORK_ERROR',
      'TELEGRAM_BOT_IDENTITY_UNVERIFIED',
      'TELEGRAM_BOT_USERNAME_MISMATCH',
      'TELEGRAM_GET_UPDATES_FAILED',
      'TELEGRAM_START_NOT_FOUND_SEND_START_AGAIN',
      'TELEGRAM_CHAT_SELECTION_CANCELLED',
      'TELEGRAM_WINDOWS_CREDENTIAL_SAVE_FAILED'
    )
    $errorCode=[string]$_.Exception.Message
    if($errorCode -cnotin $safe){$errorCode='TELEGRAM_ENROLL_FAILED'}
    if($null -ne $progress){
      try{$progress.Close();$progress.Dispose()}catch{}
      $progress=$null
    }
    $guidance=switch($errorCode){
      'TELEGRAM_START_NOT_FOUND_SEND_START_AGAIN' {'No private /start found. Open @Johnny0109bot on your phone, send /start again, then retry.'}
      'TELEGRAM_BOT_TOKEN_REJECTED_OR_NETWORK_ERROR' {'Telegram rejected the token or the connection failed. Check that BotFather issued a NEW token.'}
      'TELEGRAM_GET_UPDATES_FAILED' {'Could not read bot messages. A webhook or another bot client may be consuming updates.'}
      'TELEGRAM_WINDOWS_CREDENTIAL_SAVE_FAILED' {'Telegram confirmed your bot, but saving to Windows Credential Manager failed.'}
      'TELEGRAM_BOT_USERNAME_MISMATCH' {'This token does not belong to @Johnny0109bot.'}
      'TELEGRAM_TOKEN_FORMAT_INVALID' {'The pasted token does not match BotFather token format.'}
      'TELEGRAM_TOKEN_INPUT_CANCELLED' {'Setup canceled; nothing was stored.'}
      'TELEGRAM_CHAT_SELECTION_CANCELLED' {'No private chat was selected; nothing was stored.'}
      default {'Setup did not finish. Error code: '+$errorCode}
    }
    if([Environment]::UserInteractive){
      try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        [void][System.Windows.Forms.MessageBox]::Show($guidance,'Telegram setup: '+$errorCode,'OK','Warning')
      }catch{}
    }
    [Console]::Error.Write($errorCode)
  } else {
    [Console]::Error.Write('TELEGRAM_CREDENTIAL_NOT_CONFIGURED')
  }
  exit 1
}
