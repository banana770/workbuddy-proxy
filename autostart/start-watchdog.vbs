' WorkBuddy 反代看门狗 —— 隐藏窗口常驻，每 60 秒巡检四个端口(8400-8403)
' 谁挂了就拉起来；四个反代的自愈由它统一负责，不必逐个自启
Option Explicit

Dim sh, fso, here, script
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
script = fso.BuildPath(here, "proxy-watchdog.mjs")

If Not fso.FileExists(script) Then
  WScript.Quit 1
End If

sh.CurrentDirectory = here
sh.Run "cmd /c node proxy-watchdog.mjs", 0, False
