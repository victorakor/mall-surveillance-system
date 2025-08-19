# Mall Surveillance System (Flask + YOLOv8 + Firebase)

Production-ready baseline that meets the requested system requirements.

## Quick start

1. **Python env**
   ```bash
   python -m venv .venv
   source .venv/bin/activate  # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   ```

2. **Configure environment**
   - Put your Firebase service account JSON at the project root as `serviceAccountKey.json` (or set `FIREBASE_SERVICE_ACCOUNT_PATH` in `.env`).
   - Set `FIREBASE_DB_URL` to your Realtime Database URL (e.g. `https://mall-surveillance-system-default-rtdb.firebaseio.com`).
   - Place your YOLOv8 model file `best.pt` at the project root (or set `YOLO_MODEL_PATH`).
   - Replace `static/assets/police-siren-sound-effect-317645.mp3` with your real siren file.
   - Copy `.env.example` to `.env` and fill values.

3. **Run**
   ```bash
   python app.py
   ```
   Open http://localhost:8000

On first boot, the app ensures the default admin user exists:
- Email: `admin@example.com`
- Password: `admin123`
- Role: `admin`

## Notes
- The admin dashboard shows a **live MJPEG stream** from the default camera (index 0) with on-frame detections.
- Detection threads keep running even when you navigate away (server-side).
- **Pending detections** are broadcast in realtime via Socket.IO to the Admin Alert page where you can **Verify** or **Dismiss**.
  - Only **verified** detections are saved to Firebase and appear in Activity Log.
- **Personnel dashboard** mirrors the admin dashboard stats but **does not show video**.
- **Camera management** lets you add sources (index or RTSP URL). New workers start immediately and the dashboard updates.
- **Settings**: Admin can set language, and create new users with roles; personnel can set language. Password changes should be done by admin via new user creation or via Firebase console (extend as needed).
- When `threatLevel` is `high`, clients play the siren audio.

## Mobile admin camera (optional enhancement)
This baseline processes cameras server-side. If you want to feed the **phone camera** into the system, extend the Admin Alerts page to capture frames with `getUserMedia` and POST them to a new `/api/ingest_frame` endpoint that runs YOLO on uploaded frames and emits Socket events; save recent frames to Storage if needed.

## Security
- Backend verifies Firebase ID tokens on API calls.
- Use HTTPS and secure cookies in production. Lock down CORS/ALLOWED_ORIGINS.
