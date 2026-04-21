# Bailongma Windows Release Flow

## Current Version

- `0.1.1`

## What This Release Includes

- Windows NSIS installer
- GitHub Releases auto-update metadata
- First-run activation flow
- Uninstall clears `%APPDATA%\Bailongma`
- Branded installer assets:
  - `build/icon.ico`
  - `build/installerHeaderIcon.ico`
  - `build/installerSidebar.bmp`
  - `build/uninstallerSidebar.bmp`

## Local Build

```powershell
cd D:\claude\BaiLongma
npm install
npm run build
```

Installer output:

- `D:\claude\BaiLongma\dist\Bailongma Setup 0.1.1.exe`
- `D:\claude\BaiLongma\dist\latest.yml`

## Local Verification Checklist

1. Install `Bailongma Setup 0.1.1.exe`.
2. Launch the app and confirm the activation page appears on first run.
3. Enter a valid API key and verify the app enters `brain-ui`.
4. Uninstall the app.
5. Reinstall and confirm activation is required again.
6. After activation, confirm the composer is briefly disabled while the model warms up.

## Publish To GitHub Releases

1. Commit and push the release commit.
2. Ensure `package.json` version matches the release version.
3. Create a GitHub personal access token with `repo` permission.
4. Set the token in the current shell.

```powershell
cd D:\claude\BaiLongma
$env:GH_TOKEN = "ghp_your_token"
npm run publish
```

Published artifacts:

- GitHub Release asset: `Bailongma Setup 0.1.1.exe`
- GitHub Release asset: `latest.yml`
- GitHub Release asset: `Bailongma Setup 0.1.1.exe.blockmap`

## Notes On First Launch Of The Installer

Unsigned Windows installers can feel inconsistent on first open because Windows Defender or SmartScreen may scan them before showing UI.

To reduce that friction:

- Prefer testing the installer copied out of the build folder, not while another tool is still touching it.
- Wait a moment after the build finishes before double-clicking.
- For public releases, code-signing is the real long-term fix.

## Version Bump Checklist

1. Update `package.json`.
2. Update `package-lock.json`.
3. Build to `dist`.
4. Verify install, activation, uninstall, and reinstall.
5. Publish to GitHub Releases.
