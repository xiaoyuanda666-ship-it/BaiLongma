!macro customInit
  ; Native Node addons are ABI-bound to Electron. Clean old unpacked copies
  ; before installing so upgrades cannot keep a stale better_sqlite3.node.
  RMDir /r "$INSTDIR\resources\app.asar.unpacked\node_modules\better-sqlite3"
!macroend
