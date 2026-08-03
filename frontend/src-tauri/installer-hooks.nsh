; Windows 安裝／解安裝老毛病根治：先終止仍在跑的 sidecar，否則 NSIS 覆寫或刪除
; tqe-sidecar.exe 時檔案被鎖，安裝停在 2/3、解安裝直接失敗。
;
; app 端已經讓 sidecar 跟著父行程結束，但那救不了「舊版本已經留下的孤兒」——
; 安裝程式面對的正是那些。主程式關閉由 Tauri NSIS 既有流程處理，這裡只補殺 sidecar。
!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /IM "tqe-sidecar.exe" /T'
  Sleep 500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /IM "tqe-sidecar.exe" /T'
  Sleep 500
!macroend
