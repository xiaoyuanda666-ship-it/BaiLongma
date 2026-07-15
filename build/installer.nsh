!ifndef BUILD_UNINSTALLER
!include nsDialogs.nsh
!include FileFunc.nsh

Function BailongmaNormalizeInstallDir
  ; The directory page can return a parent folder such as D:\ or D:\Apps.
  ; Always install into an application-owned child folder.
  ${GetFileName} "$INSTDIR" $R0
  ${if} $R0 != "Bailongma"
    StrCpy $INSTDIR "$INSTDIR\Bailongma"
  ${endIf}
FunctionEnd

Function BailongmaFindForeignInstallRootItem
  ; Returns the first item in $INSTDIR that is not owned by Bailongma.
  ; Result is written to $R3. "0" means the folder is absent, empty, or safe.
  StrCpy $R3 "0"
  IfFileExists "$INSTDIR\*.*" 0 bailongmaScanInstallRootNoClose
  FindFirst $R1 $R2 "$INSTDIR\*.*"
  bailongmaScanInstallRoot:
    StrCmp $R2 "" bailongmaScanInstallRootDone
    StrCmp $R2 "." bailongmaScanInstallRootNext
    StrCmp $R2 ".." bailongmaScanInstallRootNext
    StrCmp $R2 "Bailongma.exe" bailongmaScanInstallRootNext
    StrCmp $R2 "Uninstall Bailongma.exe" bailongmaScanInstallRootNext
    StrCmp $R2 "uninstallerIcon.ico" bailongmaScanInstallRootNext
    StrCmp $R2 "locales" bailongmaScanInstallRootNext
    StrCmp $R2 "resources" bailongmaScanInstallRootNext
    StrCmp $R2 "swiftshader" bailongmaScanInstallRootNext
    StrCmp $R2 "chrome_100_percent.pak" bailongmaScanInstallRootNext
    StrCmp $R2 "chrome_200_percent.pak" bailongmaScanInstallRootNext
    StrCmp $R2 "d3dcompiler_47.dll" bailongmaScanInstallRootNext
    StrCmp $R2 "ffmpeg.dll" bailongmaScanInstallRootNext
    StrCmp $R2 "icudtl.dat" bailongmaScanInstallRootNext
    StrCmp $R2 "libEGL.dll" bailongmaScanInstallRootNext
    StrCmp $R2 "libGLESv2.dll" bailongmaScanInstallRootNext
    StrCmp $R2 "LICENSE.electron.txt" bailongmaScanInstallRootNext
    StrCmp $R2 "LICENSES.chromium.html" bailongmaScanInstallRootNext
    StrCmp $R2 "resources.pak" bailongmaScanInstallRootNext
    StrCmp $R2 "snapshot_blob.bin" bailongmaScanInstallRootNext
    StrCmp $R2 "v8_context_snapshot.bin" bailongmaScanInstallRootNext
    StrCmp $R2 "vk_swiftshader.dll" bailongmaScanInstallRootNext
    StrCmp $R2 "vk_swiftshader_icd.json" bailongmaScanInstallRootNext
    StrCmp $R2 "vulkan-1.dll" bailongmaScanInstallRootNext
    StrCpy $R3 "$R2"
    Goto bailongmaScanInstallRootDone

  bailongmaScanInstallRootNext:
    FindNext $R1 $R2
    Goto bailongmaScanInstallRoot

  bailongmaScanInstallRootDone:
    FindClose $R1
  bailongmaScanInstallRootNoClose:
FunctionEnd

Function BailongmaRescueForeignInstallRootItems
  ; During upgrades, the old uninstaller may delete the whole install folder.
  ; Move foreign items out first so third-party/user files are preserved while
  ; the upgrade can continue.
  StrCpy $R6 ""

  bailongmaRescueForeignLoop:
    Call BailongmaFindForeignInstallRootItem
    ${if} $R3 == "0"
      Return
    ${endIf}

    ${if} $R6 == ""
      CreateDirectory "$APPDATA\Bailongma"
      CreateDirectory "$APPDATA\Bailongma\install-root-rescue"
      StrCpy $R8 "1"

      bailongmaPickForeignRescueDir:
        StrCpy $R6 "$APPDATA\Bailongma\install-root-rescue\upgrade-$R8"
        IfFileExists "$R6\*.*" 0 bailongmaForeignRescueDirReady
        IntOp $R8 $R8 + 1
        IntCmp $R8 1000 bailongmaForeignRescueDirExhausted bailongmaPickForeignRescueDir bailongmaForeignRescueDirExhausted

      bailongmaForeignRescueDirReady:
        ClearErrors
        CreateDirectory "$R6"
        IfErrors bailongmaForeignRescueDirFailed
    ${endIf}

    ClearErrors
    Rename "$INSTDIR\$R3" "$R6\$R3"
    IfErrors bailongmaForeignRescueMoveFailed
    DetailPrint "Moved non-Bailongma install-root item out of upgrade path: $INSTDIR\$R3 -> $R6\$R3"
    Goto bailongmaRescueForeignLoop

  bailongmaForeignRescueDirExhausted:
    MessageBox MB_ICONSTOP|MB_OK "Bailongma could not create a unique rescue folder under:$\r$\n$\r$\n$APPDATA\Bailongma\install-root-rescue$\r$\n$\r$\nPlease move non-Bailongma content out of the install folder, then run setup again."
    Abort

  bailongmaForeignRescueDirFailed:
    MessageBox MB_ICONSTOP|MB_OK "Bailongma could not create a rescue folder:$\r$\n$\r$\n$R6$\r$\n$\r$\nPlease move non-Bailongma content out of the install folder, then run setup again."
    Abort

  bailongmaForeignRescueMoveFailed:
    MessageBox MB_ICONSTOP|MB_OK "Bailongma could not move non-Bailongma content out of the install folder:$\r$\n$\r$\n$INSTDIR\$R3$\r$\n$\r$\nTarget rescue folder:$\r$\n$R6$\r$\n$\r$\nPlease close programs that may be using this folder, or move it manually, then run setup again."
    Abort
FunctionEnd

Function BailongmaValidateInstallDir
  Call BailongmaNormalizeInstallDir

  ${GetFileName} "$INSTDIR" $R0
  ${if} $R0 != "Bailongma"
    MessageBox MB_ICONSTOP|MB_OK "Please install Bailongma into its own folder, for example:$\r$\n$\r$\nD:\Bailongma$\r$\nD:\Apps\Bailongma$\r$\n$\r$\nCurrent path:$\r$\n$INSTDIR"
    Abort
  ${endIf}

  Call BailongmaFindForeignInstallRootItem
  ${if} $R3 != "0"
    MessageBox MB_ICONSTOP|MB_OK "The selected Bailongma install folder already contains non-Bailongma content:$\r$\n$\r$\n$INSTDIR\$R3$\r$\n$\r$\nTo protect your files and other software, choose an empty folder or a folder used only by Bailongma."
    Abort
  ${endIf}

  ; Refuse a doomed install when the target drive is nearly full. The payload is
  ; ~330 MB and the installer re-extracts it once during repair, so require a
  ; safe margin instead of failing half-way through copying files. ${DriveSpace}
  ; reports free space in MB for the install drive's root.
  ${GetRoot} "$INSTDIR" $R4
  ${DriveSpace} "$R4\" "/D=F /S=M" $R5
  ${if} $R5 < 600
    MessageBox MB_ICONSTOP|MB_OK "目标磁盘可用空间不足，无法安全安装白龙马。$\r$\n$\r$\n所在磁盘：$R4$\r$\n当前可用：$R5 MB$\r$\n至少需要：600 MB$\r$\n$\r$\n请清理磁盘空间，或将白龙马安装到其他磁盘后重试。"
    Abort
  ${endIf}
FunctionEnd

Function BailongmaInstallDirSafetyPageCreate
  Call BailongmaNormalizeInstallDir
  nsDialogs::Create 1018
  Pop $R0
  ${if} $R0 == error
    Abort
  ${endIf}

  ${NSD_CreateLabel} 0 0 100% 24u "Bailongma will be installed into this application-owned folder:"
  Pop $R1
  ${NSD_CreateText} 0 28u 100% 14u "$INSTDIR"
  Pop $R2
  EnableWindow $R2 0
  ${NSD_CreateLabel} 0 52u 100% 48u "If you chose D:\ or D:\Apps, the installer automatically adds the Bailongma subfolder. Program files stay here; conversations, memories, settings, API keys, sandbox files, and downloads stay under %APPDATA%\Bailongma and are removed only if you explicitly choose to clear user data during uninstall."
  Pop $R3
  nsDialogs::Show
FunctionEnd

Function BailongmaInstallDirSafetyPageLeave
  Call BailongmaValidateInstallDir
FunctionEnd

Function BailongmaValidateInstalledPayload
  ; The installer must never report success if the Electron runtime payload is
  ; incomplete. Missing files here produce confusing launch failures later.
  IfFileExists "$INSTDIR\Bailongma.exe" 0 bailongmaPayloadMissing
  IfFileExists "$INSTDIR\d3dcompiler_47.dll" 0 bailongmaPayloadMissing
  IfFileExists "$INSTDIR\ffmpeg.dll" 0 bailongmaPayloadMissing
  IfFileExists "$INSTDIR\libEGL.dll" 0 bailongmaPayloadMissing
  IfFileExists "$INSTDIR\libGLESv2.dll" 0 bailongmaPayloadMissing
  IfFileExists "$INSTDIR\vk_swiftshader.dll" 0 bailongmaPayloadMissing
  IfFileExists "$INSTDIR\vulkan-1.dll" 0 bailongmaPayloadMissing
  IfFileExists "$INSTDIR\resources\app.asar" 0 bailongmaPayloadMissing
  IfFileExists "$INSTDIR\resources\app.asar.unpacked\node_modules\better-sqlite3\build\Release\better_sqlite3.node" 0 bailongmaPayloadMissing

  ClearErrors
  FileOpen $R1 "$INSTDIR\Bailongma.exe" r
  IfErrors bailongmaPayloadMissing
  FileSeek $R1 0 END $R3
  FileClose $R1

  ; A partially copied Electron executable can still have a valid PE header.
  ; Use a conservative lower bound (50 MB) that any complete Bailongma.exe far
  ; exceeds (~180 MB today), so gross truncation is caught without tying the
  ; check to a specific Electron version's exact size, which changes on every
  ; Electron bump. A tight threshold near the real size silently rejects valid
  ; installs after an Electron downgrade/optimization.
  IntCmp $R3 52428800 bailongmaPayloadValid bailongmaPayloadMissing bailongmaPayloadValid

  bailongmaPayloadValid:
    Return

  bailongmaPayloadMissing:
    MessageBox MB_ICONSTOP|MB_OK "Bailongma installation did not complete correctly. To avoid leaving a broken app on this computer, setup will stop now.$\r$\n$\r$\nPlease close Bailongma and run this installer again. If the problem continues, send this path to support:$\r$\n$INSTDIR"
    Abort
FunctionEnd

Function BailongmaRepairAndValidateInstalledPayload
  ; electron-builder first extracts app-64.7z to $PLUGINSDIR\7z-out and then
  ; copies that folder to $INSTDIR. In the field this copy can leave a partial
  ; install. Re-extract the embedded archive directly to $INSTDIR, then validate.
  StrCpy $R9 "$OUTDIR"
  SetOutPath "$INSTDIR"
  File /oname=$PLUGINSDIR\7za.exe "${PROJECT_DIR}\node_modules\7zip-bin\win\x64\7za.exe"

  !ifdef APP_64
    IfFileExists "$PLUGINSDIR\app-64.7z" 0 +4
    ; nsExec runs 7za.exe with a hidden window, so no console window flashes
    ; during install. ExecWait would spawn a visible console window each time.
    nsExec::ExecToLog '"$PLUGINSDIR\7za.exe" x -y -aoa "-o$INSTDIR" "$PLUGINSDIR\app-64.7z"'
    Pop $R0
    Goto bailongmaPackageExtracted
  !endif

  StrCpy $R0 "no embedded x64 package found"

  bailongmaPackageExtracted:
    SetOutPath "$R9"
    Call BailongmaValidateInstalledPayload
FunctionEnd

!macro customPageAfterChangeDir
  Page custom BailongmaInstallDirSafetyPageCreate BailongmaInstallDirSafetyPageLeave
!macroend

!macro customInstall
  Call BailongmaRepairAndValidateInstalledPayload

  ; Keep the shortcut icon outside $INSTDIR. During an upgrade the old payload
  ; is removed before the new payload is copied, so an icon that points at
  ; Bailongma.exe temporarily disappears. Explorer can cache that missing icon
  ; as a blank document and keep showing it even after the new EXE arrives.
  ; This stable copy survives upgrades and is refreshed on every install.
  CreateDirectory "$APPDATA\Bailongma"
  SetOutPath "$APPDATA\Bailongma"
  File /oname=shortcut-icon.ico "${PROJECT_DIR}\build\icon.ico"

  ; Avoid electron-builder's WinShell plugin for shortcuts. Plain NSIS
  ; shortcuts are enough because the app itself sets AppUserModelID at runtime.
  SetOutPath "$INSTDIR"
  Delete "$SMPROGRAMS\Bailongma.lnk"
  Delete "$SMPROGRAMS\Bailongma\Bailongma.lnk"
  RMDir "$SMPROGRAMS\Bailongma"
  Delete "$DESKTOP\Bailongma.lnk"
  CreateShortCut "$DESKTOP\Bailongma.lnk" "$INSTDIR\Bailongma.exe" "" "$APPDATA\Bailongma\shortcut-icon.ico" 0

  ; The shortcut path and target remain the same across upgrades. Explicitly
  ; invalidate Explorer's icon cache so it notices the restored shortcut and
  ; the stable icon location immediately instead of retaining a blank icon.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "KeepShortcuts" "true"
  ${if} $installMode == "all"
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "UninstallString" '"$INSTDIR\Uninstall Bailongma.exe" /allusers --keep-shortcuts'
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall Bailongma.exe" /allusers /S --keep-shortcuts'
  ${else}
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "UninstallString" '"$INSTDIR\Uninstall Bailongma.exe" /currentuser --keep-shortcuts'
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall Bailongma.exe" /currentuser /S --keep-shortcuts'
  ${endIf}
!macroend

!macro customInit
  ; Make upgrades invoke old uninstallers with --keep-shortcuts. That skips
  ; electron-builder's WinShell plugin, whose temp extraction can fail at scale.
  WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "KeepShortcuts" "true"

  ; Refuse unsafe legacy or scripted install locations before the installer runs
  ; the old uninstaller. Upgrades invoke the previous uninstaller first, so a
  ; bad historical InstallLocation must be stopped here, not in customRemoveFiles.
  ${GetFileName} "$INSTDIR" $R0
  ${if} $R0 != "Bailongma"
    ${if} ${FileExists} "$INSTDIR\Bailongma.exe"
    ${orIf} ${FileExists} "$INSTDIR\Uninstall Bailongma.exe"
    ${orIf} ${FileExists} "$INSTDIR\resources\app.asar"
      MessageBox MB_ICONSTOP|MB_OK "Bailongma is installed in an unsafe shared folder:$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\nTo protect other software, this installer will not continue. Please contact support or manually move/remove only the Bailongma files, then install again."
      Abort
    ${else}
      Call BailongmaNormalizeInstallDir
    ${endIf}
  ${endIf}

  ; Even a folder named Bailongma can contain user-created or third-party
  ; folders. During upgrades, electron-builder invokes the *old* uninstaller
  ; before this new safe uninstaller exists, and old uninstallers recursively
  ; remove the whole install folder. If this is an existing Bailongma install,
  ; rescue foreign items to userData first. Fresh installs still validate and
  ; refuse non-empty foreign folders on the install-directory page.
  ${if} ${FileExists} "$INSTDIR\Bailongma.exe"
  ${orIf} ${FileExists} "$INSTDIR\Uninstall Bailongma.exe"
  ${orIf} ${FileExists} "$INSTDIR\resources\app.asar"
    Call BailongmaRescueForeignInstallRootItems
  ${endIf}

  ; Do not delete native module directories in customInit. This hook runs before
  ; the new payload has been fully extracted and validated; deleting here can
  ; leave an otherwise working install broken if setup is cancelled or killed.
  ; The repaired payload extraction in customInstall overwrites owned files.
!macroend

!endif

!macro customRemoveFiles
  ; electron-builder's default uninstaller runs `RMDir /r $INSTDIR`.
  ; That is dangerous when a user accidentally installed into a shared parent
  ; folder such as AppData\Local\Programs or D:\Software. Remove only files and
  ; subdirectories Bailongma owns, then remove parent folders only if empty.
  ${if} ${isUpdated}
    ; During an upgrade, fail atomically if any app file is busy. This prevents
    ; a half-removed install folder followed by a false successful install.
    CreateDirectory "$PLUGINSDIR\old-install"
    Push ""
    Call un.atomicRMDir
    Pop $R0

    ${if} $R0 != 0
      DetailPrint "Bailongma file is busy, aborting upgrade: $R0"
      Push ""
      Call un.restoreFiles
      Pop $R0
      Abort `Can't safely update Bailongma because "$INSTDIR" contains a busy file.`
    ${endif}

    Goto bailongmaRemoveFilesDone
  ${endif}

  Delete "$INSTDIR\Bailongma.exe"
  Delete "$INSTDIR\chrome_100_percent.pak"
  Delete "$INSTDIR\chrome_200_percent.pak"
  Delete "$INSTDIR\d3dcompiler_47.dll"
  Delete "$INSTDIR\ffmpeg.dll"
  Delete "$INSTDIR\icudtl.dat"
  Delete "$INSTDIR\libEGL.dll"
  Delete "$INSTDIR\libGLESv2.dll"
  Delete "$INSTDIR\LICENSE.electron.txt"
  Delete "$INSTDIR\LICENSES.chromium.html"
  Delete "$INSTDIR\resources.pak"
  Delete "$INSTDIR\snapshot_blob.bin"
  Delete "$INSTDIR\v8_context_snapshot.bin"
  Delete "$INSTDIR\vk_swiftshader.dll"
  Delete "$INSTDIR\vk_swiftshader_icd.json"
  Delete "$INSTDIR\vulkan-1.dll"
  Delete "$INSTDIR\Uninstall Bailongma.exe"
  Delete "$INSTDIR\uninstallerIcon.ico"

  ; Shortcuts are created by customInstall with plain NSIS CreateShortCut.
  ; Delete them directly so uninstall never needs WinShell.dll.
  Delete "$DESKTOP\Bailongma.lnk"
  Delete "$SMPROGRAMS\Bailongma.lnk"
  Delete "$SMPROGRAMS\Bailongma\Bailongma.lnk"
  RMDir "$SMPROGRAMS\Bailongma"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  Delete "$INSTDIR\resources\app.asar"
  Delete "$INSTDIR\resources\app-update.yml"
  Delete "$INSTDIR\resources\elevate.exe"
  RMDir /r "$INSTDIR\resources\app.asar.unpacked\node_modules\better-sqlite3"
  RMDir /r "$INSTDIR\resources\app.asar.unpacked\src\voice"
  RMDir "$INSTDIR\resources\app.asar.unpacked\node_modules"
  RMDir "$INSTDIR\resources\app.asar.unpacked\src"
  RMDir "$INSTDIR\resources\app.asar.unpacked"
  RMDir "$INSTDIR\resources"

  Delete "$INSTDIR\locales\am.pak"
  Delete "$INSTDIR\locales\af.pak"
  Delete "$INSTDIR\locales\ar.pak"
  Delete "$INSTDIR\locales\bg.pak"
  Delete "$INSTDIR\locales\bn.pak"
  Delete "$INSTDIR\locales\ca.pak"
  Delete "$INSTDIR\locales\cs.pak"
  Delete "$INSTDIR\locales\da.pak"
  Delete "$INSTDIR\locales\de.pak"
  Delete "$INSTDIR\locales\el.pak"
  Delete "$INSTDIR\locales\en-GB.pak"
  Delete "$INSTDIR\locales\en-US.pak"
  Delete "$INSTDIR\locales\es-419.pak"
  Delete "$INSTDIR\locales\es.pak"
  Delete "$INSTDIR\locales\et.pak"
  Delete "$INSTDIR\locales\fa.pak"
  Delete "$INSTDIR\locales\fi.pak"
  Delete "$INSTDIR\locales\fil.pak"
  Delete "$INSTDIR\locales\fr.pak"
  Delete "$INSTDIR\locales\gu.pak"
  Delete "$INSTDIR\locales\he.pak"
  Delete "$INSTDIR\locales\hi.pak"
  Delete "$INSTDIR\locales\hr.pak"
  Delete "$INSTDIR\locales\hu.pak"
  Delete "$INSTDIR\locales\id.pak"
  Delete "$INSTDIR\locales\it.pak"
  Delete "$INSTDIR\locales\ja.pak"
  Delete "$INSTDIR\locales\kn.pak"
  Delete "$INSTDIR\locales\ko.pak"
  Delete "$INSTDIR\locales\lt.pak"
  Delete "$INSTDIR\locales\lv.pak"
  Delete "$INSTDIR\locales\ml.pak"
  Delete "$INSTDIR\locales\mr.pak"
  Delete "$INSTDIR\locales\ms.pak"
  Delete "$INSTDIR\locales\nb.pak"
  Delete "$INSTDIR\locales\nl.pak"
  Delete "$INSTDIR\locales\pl.pak"
  Delete "$INSTDIR\locales\pt-BR.pak"
  Delete "$INSTDIR\locales\pt-PT.pak"
  Delete "$INSTDIR\locales\ro.pak"
  Delete "$INSTDIR\locales\ru.pak"
  Delete "$INSTDIR\locales\sk.pak"
  Delete "$INSTDIR\locales\sl.pak"
  Delete "$INSTDIR\locales\sr.pak"
  Delete "$INSTDIR\locales\sv.pak"
  Delete "$INSTDIR\locales\sw.pak"
  Delete "$INSTDIR\locales\ta.pak"
  Delete "$INSTDIR\locales\te.pak"
  Delete "$INSTDIR\locales\th.pak"
  Delete "$INSTDIR\locales\tr.pak"
  Delete "$INSTDIR\locales\uk.pak"
  Delete "$INSTDIR\locales\ur.pak"
  Delete "$INSTDIR\locales\vi.pak"
  Delete "$INSTDIR\locales\zh-CN.pak"
  Delete "$INSTDIR\locales\zh-TW.pak"
  RMDir "$INSTDIR\locales"

  ; Only succeeds when the install folder is empty. Never recurse here.
  RMDir "$INSTDIR"

  bailongmaRemoveFilesDone:
!macroend

!macro customUnInstall
  ; 卸载时询问是否同时清除用户数据。升级（${isUpdated}）走的也是卸载旧版流程，
  ; 那种情况绝不能删数据，否则更新一次记忆全没——所以只在“真卸载”时弹窗。
  ; /SD IDNO 让静默卸载默认走“保留”，不打扰、不误删。
  ${ifNot} ${isUpdated}
    ; The stable shell icon is installer-owned, not user data. Remove it on a
    ; real uninstall even when the user chooses to retain conversations and
    ; settings for a future reinstall.
    Delete "$APPDATA\Bailongma\shortcut-icon.ico"
    MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除白龙马的全部用户数据？$\r$\n$\r$\n包括：对话与记忆数据库、配置（含 API Key）、沙盒文件、下载的音乐等。$\r$\n$\r$\n选择「是」将彻底清除且无法恢复；选择「否」保留数据，方便以后重装时继续使用。" /SD IDNO IDNO keepUserData
      ; userData 目录 = %APPDATA%\<productName>，即 $APPDATA\Bailongma
      RMDir /r "$APPDATA\Bailongma"
    keepUserData:
  ${endIf}
!macroend
