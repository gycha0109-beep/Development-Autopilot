# Synthetic GUI control validation. No token, Bot API, Windows credentials or SMS.
param([string]$ScriptPath=(Join-Path $PSScriptRoot '..\local\telegram-credentials.ps1'))
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if([Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA'){
  throw 'TEST_REQUIRES_STA'
}
$original=[IO.File]::ReadAllText((Resolve-Path $ScriptPath).Path)
function Get-GuiCode([string]$begin,[string]$stop){
  $a=$original.IndexOf($begin,[StringComparison]::Ordinal)
  if($a -lt 0){throw 'GUI_SEGMENT_START_NOT_FOUND'}
  $b=$original.IndexOf($stop,$a,[StringComparison]::Ordinal)
  if($b -le $a){throw 'GUI_SEGMENT_STOP_NOT_FOUND'}
  return $original.Substring($a,$b-$a)
}
$tokenSegment=Get-GuiCode '    $form=New-Object System.Windows.Forms.Form' '      $answer=$form.ShowDialog()'
# Do not execute the pending try { preceding ShowDialog.
$tokenSegment=$tokenSegment.Substring(0,$tokenSegment.LastIndexOf('    try {'))
. ([scriptblock]::Create($tokenSegment))
try{
  if($form.ActiveControl -ne $tokenBox){throw 'TOKEN_FIELD_NOT_FOCUSED'}
  if($tokenBox.UseSystemPasswordChar -ne $true -or
     $tokenBox.ShortcutsEnabled -ne $true){throw 'TOKEN_FIELD_NOT_PASTE_READY'}
  if($form.AcceptButton -ne $ok){throw 'TOKEN_FORM_BAD_ACCEPT_BUTTON'}
  if($form.CancelButton -ne $cancel){throw 'TOKEN_FORM_BAD_CANCEL_BUTTON'}
  # Exercise the real modal ShowDialog path, including its native Cancel.
  # Callback uses only its sender and open form collection, never $input.
  $modalTimer=New-Object System.Windows.Forms.Timer
  $modalTimer.Interval=120
  $modalTimer.Add_Tick({
    param($sender,$eventArgs)
    $sender.Stop()
    foreach($visibleForm in [System.Windows.Forms.Application]::OpenForms){
      if($visibleForm.Text -eq 'Development Autopilot - Telegram bot setup'){
        foreach($control in $visibleForm.Controls){
          if($control -is [System.Windows.Forms.Button] -and
             $control.Text -eq 'Cancel'){$control.PerformClick();break}
        }
      }
    }
  })
  $modalTimer.Start()
  $modalResult=$form.ShowDialog()
  if($modalResult -ne [System.Windows.Forms.DialogResult]::Cancel){
    throw 'TOKEN_MODAL_CANCEL_DID_NOT_WORK'
  }
  $modalTimer.Dispose()
}finally{
  $form.Close()
  $form.Dispose()
}
$me=[pscustomobject]@{result=[pscustomobject]@{username='synthetic_test_bot'}}
$candidates=@(
  [pscustomobject]@{Id='123456789';Display='Synthetic One'},
  [pscustomobject]@{Id='123456780';Display='Synthetic Two'}
)
$chooseSegment=Get-GuiCode '    $choose=New-Object System.Windows.Forms.Form' '      $chosen=$choose.ShowDialog()'
$chooseSegment=$chooseSegment.Substring(0,$chooseSegment.LastIndexOf('    try {'))
. ([scriptblock]::Create($chooseSegment))
try{
  if($choose.AcceptButton -ne $confirm){throw 'CHOICE_FORM_BAD_ACCEPT'}
  if($choose.CancelButton -ne $cancelChoice){throw 'CHOICE_FORM_BAD_CANCEL'}
  if($confirm.DialogResult -ne [System.Windows.Forms.DialogResult]::OK){
    throw 'CHOICE_CONFIRM_BAD_RESULT'
  }
  if($list.Items.Count -ne 2){throw 'CHOICE_CANDIDATES_LOST'}
  if($list.SelectedIndex -ne -1){throw 'CHOICE_PRESELECTED_WITHOUT_CONSENT'}
  # Validate selecting a private chat then the native OK button completes.
  $choiceTimer=New-Object System.Windows.Forms.Timer
  $choiceTimer.Interval=120
  $choiceTimer.Add_Tick({
    param($sender,$eventArgs)
    $sender.Stop()
    foreach($visibleForm in [System.Windows.Forms.Application]::OpenForms){
      if($visibleForm.Text -like 'Confirm your private Telegram chat*'){
        foreach($control in $visibleForm.Controls){
          if($control -is [System.Windows.Forms.ListBox]){
            $control.SelectedIndex=0
          }
        }
        foreach($control in $visibleForm.Controls){
          if($control -is [System.Windows.Forms.Button] -and
             $control.Text -eq 'Save to Windows'){
            $control.PerformClick()
            break
          }
        }
      }
    }
  })
  $choiceTimer.Start()
  $choiceResult=$choose.ShowDialog()
  if($choiceResult -ne [System.Windows.Forms.DialogResult]::OK -or
     $list.SelectedIndex -ne 0){
    throw 'CHOICE_MODAL_CONFIRM_DID_NOT_WORK'
  }
  $choiceTimer.Dispose()
}finally{
  $choose.Close()
  $choose.Dispose()
}
[Console]::Out.WriteLine('TELEGRAM_GUI_SYNTHETIC_WINDOWS_PASS')
