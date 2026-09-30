' WorkBuddy 反代 —— Codex 侧（端口 8401）
' 开机登录后隐藏窗口启动，跟 DSH 的 start-dsh-web-hidden.vbs 同一套路
Option Explicit

Dim sh, fso, here, proxyDir
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
proxyDir = fso.BuildPath(fso.GetParentFolderName(here), "codex-workbuddy-proxy")

If Not fso.FileExists(fso.BuildPath(proxyDir, "proxy.mjs")) Then
  WScript.Quit 1
End If

sh.CurrentDirectory = proxyDir
sh.Run "cmd /c node proxy.mjs", 0, False
