# St. George Church Dashboard — Google Sheets, Auth & Android APK Guide

## 1. Google Sheets & Google Drive Architecture (Zero Secrets in APK)
- **Authoritative Spreadsheet ID:** `15Nda4pGb3WdAfOuRTwRS9Fx822_EORgumOmhZcjTVt0`
- **Approved Tabs (Sheets):** `نشط`, `غير حاضر`, `فصل البابا شنودة`, `غير نشط`
- **Why Private Relay is Mandatory:**
  - Never embed Google Service Account private keys (`GOOGLE_PRIVATE_KEY`) or JWT secrets inside an Android `.apk` (anyone can unpack APK assets).
  - Never mark the church Google Sheet as "Anyone with the link can view/edit".

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
