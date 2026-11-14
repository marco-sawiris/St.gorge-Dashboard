# St. George Church Dashboard — Google Sheets, Auth & Android APK Guide

## 1. Google Sheets & Google Drive Architecture (No Google service-account private key in APK)
- **Authoritative Spreadsheet ID:** `15Nda4pGb3WdAfOuRTwRS9Fx822_EORgumOmhZcjTVt0`
- **Approved Tabs (Sheets):** `نشط`, `غير حاضر`, `فصل البابا شنودة`, `غير نشط`
- **Why Private Relay is Mandatory:**
  - Never embed Google Service Account private keys (`GOOGLE_PRIVATE_KEY`) or JWT secrets inside an Android `.apk` (anyone can unpack APK assets).
  - Never mark the church Google Sheet as "Anyone with the link can view/edit".
- `RELAY_KEY` is still sent by the client app and can be extracted by a determined user; it is a shared access gate, not a secret that can be guaranteed safe inside an APK. Rotate it if exposed, and use a server-side authenticated backend for stronger security.

### Recommended Zero-Cost Option ($0/month): Google Apps Script Web App (`docs/google-apps-script/Code.gs`)
1. Open the Google Sheet on your Google Drive (`mmalgy@gmail.com`).
2. Go to **Extensions -> Apps Script** and paste the contents of `docs/google-apps-script/Code.gs`.
3. In **Project Settings -> Script Properties**, add:
   - `SPREADSHEET_ID`: `15Nda4pGb3WdAfOuRTwRS9Fx822_EORgumOmhZcjTVt0`
   - `RELAY_KEY`: Strong random secret of at least 32 characters (stored strictly on Google's servers).
4. Click **Deploy -> New deployment -> Web app**:
   - **Execute as:** `Me (Owner)`
   - **Who has access:** `Anyone` (the script checks `RELAY_KEY`; note that a key embedded in a client app can be extracted).
5. Grant Google Drive / Google Sheets OAuth scope (`https://www.googleapis.com/auth/spreadsheets`) once under your owner account.
6. After deploying, configure the Android app without exposing technical fields in the normal Sync Details screen. In a locally inspected/debug WebView console, run the following after replacing the two values locally (never paste the key into GitHub or a chat):
   ```js
   localStorage.setItem('stgorge_apps_script_url', 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec');
   localStorage.setItem('stgorge_relay_key', 'YOUR_RELAY_KEY');
   location.reload();
   ```
   The endpoint and key are stored in this app's local WebView storage. This avoids adding secret-entry controls to the public sync status UI, but does not make the shared key extraction-proof.

### Alternative Option: Hosted Express Backend (`server.ts`)
- Host `server.ts` on Render / Cloud Run / Fly.io with PostgreSQL + `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY`.
- Build the APK with `VITE_API_BASE_URL="https://your-hosted-backend.example.com"`.

---

## 2. Building & Signing Android APK
- **Application ID:** `org.stgeorge.zaitoun.dashboard`
- **App Name:** `St. George Dashboard`
- **Debug APK Output:** `android/app/build/outputs/apk/debug/app-debug.apk`

### Release APK Signing (User-Owned Keystore Required)
No keystore is pre-generated or committed. To produce a signed Release APK (`./gradlew assembleRelease`):
1. Generate your personal release keystore locally:
   ```bash
   keytool -genkey -v -keystore stgeorge-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias stgeorge
   ```
2. Create `android/keystore.properties` (never commit this file to Git):
   ```properties
   storeFile=../stgeorge-release.jks
   storePassword=YOUR_KEYSTORE_PASSWORD
   keyAlias=stgeorge
   keyPassword=YOUR_KEY_PASSWORD
   ```
3. Run:
   ```bash
   npm run android:sync
   cd android && ./gradlew assembleRelease
   ```

### Important: Verify browser/WebView CORS before enabling live sync
- Apps Script `ContentService` responses are delivered through a different `script.googleusercontent.com` URL for security reasons. A successful direct browser visit does **not** prove that the app's cross-origin `fetch()` calls can read the JSON response.
- Before relying on this relay, test both authenticated `GET action=getStudents` and a harmless, explicitly approved `POST` from the actual Android WebView. Confirm that JavaScript can read and parse the response, not merely that the Apps Script execution appears in its logs.
- If WebView CORS blocks the response, this direct client-to-Apps-Script design is not ready for production. Use a CORS-capable server-side proxy or redesign the transport. Do **not** switch writes to `mode: 'no-cors'`: an opaque response cannot provide the acknowledgement required before removing an operation from IndexedDB.
- Until this test passes, treat Apps Script push/pull as **unverified** and keep all pending IndexedDB operations intact.
- Reference: [Google Apps Script Content Service](https://developers.google.com/apps-script/reference/content/content-service).
