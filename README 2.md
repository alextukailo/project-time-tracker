# Time Tracker — stable Extension ID patch

This patch **does not overwrite your existing `public/manifest.json` or OAuth Client ID**.

## Install

Unzip into your existing `project-time-tracker` directory.

```bash
cd /Users/alex/dev/project-time-tracker
node scripts/setup-extension-id.mjs
```

The script:
- If the manifest already has a `key`, preserves it.
- Otherwise creates a new RSA private key at `.secrets/time-tracker-extension.pem` (local only, do not share) and adds its base64 public SPKI key as `"key"` to your `public/manifest.json`.
- Adds `.secrets/` to `.gitignore`.
- Prints the new 32-letter stable Chrome Extension ID.
- Is repeatable; it does not rotate an existing key.

## Set up Google Cloud OAuth

1. Go to Google Auth Platform -> Clients in the existing `Time Tracker` project.
2. Create OAuth client, **Chrome Extension**, and set **Item ID** to the stable ID printed by the script.
3. Copy the **new Client ID** to `public/manifest.json` -> `oauth2.client_id`.
4. Run:

```bash
npm run lint && npm run test:smoke && npm run build
node scripts/setup-extension-id.mjs --check
```

5. Open `chrome://extensions`, enable Developer mode, and load `dist` using **Load unpacked**. Verify that the ID matches the script output.
6. Distribute a ZIP of the `dist/` **contents**; recipients unpack and use `Load unpacked` on the folder containing `manifest.json`. Everyone gets the same ID.

## Important notes

- Before switching IDs, make a backup of the current Chrome installation and any local timer/session data. Chrome will treat the new ID as a new extension and will not automatically transfer `chrome.storage.local`. The existing Google Sheet's data is unaffected.
- Do not commit, share, upload, email, or include `.secrets/time-tracker-extension.pem` in ZIPs.
- `manifest.key` is public, not a password, not an OAuth Client Secret.
- If you later publish through Chrome Web Store, align the manifest public key and Google OAuth client with the published item ID. Chrome Web Store can assign a separate ID.
- `In production` status applies to the Google Cloud project's OAuth consent screen. Creating another OAuth client in the **same project** does not require setting up a new consent screen.

Official Chrome docs: https://developer.chrome.com/docs/extensions/reference/manifest/key
