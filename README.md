# Overlap — real-time group availability planner

Static site (HTML/CSS/vanilla JS) + Firebase Realtime Database + Anonymous Auth. No build step.

## Files
`index.html`, `style.css`, `script.js` (UI + Firebase), `engine.js` (pure calculation engine), `engine.test.js`, `firebase-config.js`, `firebase-rules.json`.

## Setup
1. **Create project** at https://console.firebase.google.com/ → Add project → name it `Overlap` (Analytics not needed).
2. **Register web app**: Project overview → `</>` Web → register → copy the `firebaseConfig` values.
3. **Anonymous auth**: Build → Authentication → Get started → Sign-in method → Anonymous → Enable.
4. **Realtime Database**: Build → Realtime Database → Create database → pick a region → start in **locked mode**.
5. **Rules**: Realtime Database → Rules → replace everything with the contents of `firebase-rules.json` → **Publish**.
6. **Config**: paste your values into `firebase-config.js` (`apiKey`, `authDomain`, `databaseURL` — shown on the Realtime Database page —, `projectId`, `storageBucket`, `messagingSenderId`, `appId`). These web values are public by design; the rules protect the data.
7. **Authorized domains**: Authentication → Settings → Authorized domains → add `YOUR_USERNAME.github.io`.
8. **GitHub Pages**: create a repo → upload all files to the root → Settings → Pages → Deploy from a branch → `main` / `/ (root)` → Save → open the URL shown.

## Using it
Create a session → copy the link (`.../?session=ID`) → friends open it, enter a name, and fill in availability. Results update live under **Best Times**.

## Tests
`node engine.test.js` (Node 18+). Covers the calculation engine only.

## Security model
- Session ID = 128-bit random hex (`crypto.getRandomValues`), acting as an invitation token. **Anyone with the link can join while the session is open and read all participants' names and availability.** Sessions cannot be listed.
- Rules: auth required; only the owner can create/change `info` (owner UID immutable); participants write only their own record; the owner may only *delete* other participants; closed sessions accept no new participants; data types and ranges are validated.

## Known limitations
- Planning dates/hours cannot be edited after creation (create a new session instead).
- Offline: Firebase queues writes and the app shows "Offline — will sync"; unsaved drafts are kept in localStorage and re-sent on next load. Each person only writes their own record, so conflicts can only occur between two devices using the same anonymous account (last write wins).
- Clearing browser data creates a new anonymous identity (you would rejoin as a new participant; the owner loses owner access).
- Session/participant ownership rules and live sync are not unit-testable without Firebase; test them with 2 browsers (one private window) after deployment.
- Not browser-tested here; only syntax and engine tests were run.
