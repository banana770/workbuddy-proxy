' WorkBuddy 反代 —— ZCode 侧（端口 8400）
' 开机登录后隐藏窗口启动，跟 DSH 的 start-dsh-web-hidden.vbs 同一套路
Option Explicit

Dim sh, fso, here, proxyDir
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
proxyDir = fso.BuildPath(fso.GetParentFolderName(here), "zcode-workbuddy-proxy")

If Not fso.FileExists(fso.BuildPath(proxyDir, "proxy.mjs")) Then
  WScript.Quit 1
End If

' 已经在跑就不重复启动（端口 8400 被占则跳过）
sh.CurrentDirectory = proxyDir
sh.Run "cmd /c node proxy.mjs", 0, False
