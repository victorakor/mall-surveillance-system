import os
from functools import wraps
from dotenv import load_dotenv
from flask import Flask, render_template, request, Response, jsonify
from flask_cors import CORS
from flask_socketio import SocketIO
from firebase_admin import auth as fbauth, db

# --- Fix OpenCV backend for Windows webcams ---
os.environ["OPENCV_VIDEOIO_PRIORITY_MSMF"] = "0"   # disable MSMF
os.environ["OPENCV_VIDEOIO_PRIORITY_DSHOW"] = "1"  # force DSHOW

import cv2
import firebase_manager as fm
from yolov8_detection import mjpeg_generator, CameraWorker

# --------------------------------------------------------------------------------------
# App setup
# --------------------------------------------------------------------------------------
load_dotenv()
SECRET = os.getenv("FLASK_SECRET", "change-this-secret")
ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",")]

app = Flask(__name__, template_folder="templates", static_folder="static")
app.secret_key = SECRET
CORS(app, supports_credentials=True,
     origins="*" if "*" in ALLOWED_ORIGINS else ALLOWED_ORIGINS)

# Use threading to avoid eventlet/gevent issues on Windows
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# Ensure default admin exists at startup
fm.ensure_default_admin()

# Camera workers map
camera_workers = {}

# --------------------------------------------------------------------------------------
# Auth helpers
# --------------------------------------------------------------------------------------
def verify_firebase_token(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        id_token = request.headers.get("Authorization")
        if id_token and id_token.startswith("Bearer "):
            id_token = id_token.split(" ", 1)[1]
        else:
            return jsonify({"error": "Missing Authorization Bearer token"}), 401
        try:
            decoded = fbauth.verify_id_token(id_token)
        except Exception as e:
            return jsonify({"error": "Invalid token", "detail": str(e)}), 401
        request.user = decoded
        return fn(*args, **kwargs)
    return wrapper

def require_admin(fn):
    """Decorator: only allow if user has role=admin in Firebase DB"""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        uid = request.user.get("uid")
        u = fm.get_user(uid) or {}
        if u.get("role") != "admin":
            return jsonify({"error": "forbidden"}), 403
        return fn(*args, **kwargs)
    return wrapper

# --------------------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")

# --------- Video stream route (public; UI restricts visibility) ---------
def _find_working_source(source_hint=0):
    """Try given source, then fallback to 0,1,2 until one opens."""
    sources_to_try = [source_hint] + [i for i in range(3) if i != source_hint]
    for src in sources_to_try:
        try:
            if isinstance(src, str) and src.isdigit():
                src = int(src)
            cap = cv2.VideoCapture(src, cv2.CAP_DSHOW)
            if cap.isOpened():
                ok, _ = cap.read()
                cap.release()
                if ok:
                    print(f"✅ Camera source found: {src}")
                    return src
            cap.release()
        except Exception:
            continue
    return None

@app.route("/api/video_feed")
def video_feed():
    """Return MJPEG stream if available, else placeholder image."""
    camera = request.args.get("camera", "default")
    cams = fm.list_cameras()
    source = 0
    if camera != "default" and cams:
        for cid, c in cams.items():
            if cid == camera or c.get("name") == camera:
                source = c.get("source", 0)
                break

    working_src = _find_working_source(source)
    if working_src is None:
        placeholder = os.path.join(app.static_folder, "placeholder.jpg")
        if os.path.exists(placeholder):
            with open(placeholder, "rb") as f:
                return Response(f.read(), mimetype="image/jpeg")
        return Response("Camera source unavailable", status=503)

    return Response(
        mjpeg_generator(working_src),
        mimetype="multipart/x-mixed-replace; boundary=frame"
    )

# --------- Dashboard snapshot ---------
@app.route("/api/status")
@verify_firebase_token
def status():
    try:
        return jsonify(fm.get_dashboard_snapshot())
    except Exception as e:
        app.logger.exception("Dashboard snapshot failed")
        return jsonify({
            "status": False,
            "threatLevel": "low",
            "camerasActive": len(camera_workers),
            "alertsToday": [],
            "error": str(e),
            "hint": "Add .indexOn: ['createdAt'] to RTDB rules for /dashboard/alertsToday"
        }), 200

# --------- Alerts verify/dismiss ---------
@app.post("/api/alerts/resolve")
@verify_firebase_token
@require_admin
def resolve_alert():
    data = request.json or {}
    action = data.get("action")
    det = data.get("detection")
    if action not in {"verify", "dismiss"} or not det:
        return jsonify({"error": "Invalid payload"}), 400
    if action == "verify":
        payload = {
            "name": det.get("label"),
            "time": det.get("time"),
            "camera": det.get("camera"),
            "threatLevel": det.get("threatLevel"),
            "status": "verified"
        }
        fm.save_detection_verified(payload)
    return jsonify({"ok": True})

# --------- Cameras management ---------
@app.get("/api/cameras")
@verify_firebase_token
def cameras_list():
    return jsonify(fm.list_cameras())

@app.post("/api/cameras")
@verify_firebase_token
@require_admin
def camera_add():
    data = request.json or {}
    name = data.get("name")
    source = data.get("source")
    if not name or source is None:
        return jsonify({"error": "name and source required"}), 400
    if isinstance(source, str) and source.isdigit():
        source = int(source)
    cam_id = fm.add_camera(name, source)
    return jsonify({"id": cam_id})

# --------- Users & settings ---------
@app.post("/api/add_user")
@verify_firebase_token
@require_admin
def add_user():
    data = request.json or {}
    name = data.get("name")
    email = data.get("email")
    password = data.get("password")
    role = data.get("role", "personnel")
    if not all([name, email, password]):
        return jsonify({"error": "name, email, password required"}), 400
    created_uid = fm.create_user(name, email, password, role)
    return jsonify({"uid": created_uid})

@app.post("/api/user_language")
@verify_firebase_token
def set_language():
    uid = request.user.get("uid")
    lang = (request.json or {}).get("language", "english")
    fm.set_user_language(uid, lang)
    return jsonify({"ok": True})

# --------- SocketIO namespace ---------
@socketio.on("connect", namespace="/stream")
def on_connect():
    pass

# --------------------------------------------------------------------------------------
# Camera control (on-demand start/stop by admin)
# --------------------------------------------------------------------------------------
def start_all_cameras():
    cams = fm.list_cameras()
    if not cams:
        sources = os.getenv("CAMERA_SOURCES", "0").split(",")
        for idx, s in enumerate(sources):
            s_val = int(s) if s.isdigit() else s
            cam_id = fm.add_camera(name=f"Camera {idx}", source=s_val)
            worker = CameraWorker(camera_id=cam_id, source=s_val, socketio=socketio)
            worker.start()
            camera_workers[cam_id] = worker
    else:
        for cam_id, c in cams.items():
            source = c.get("source", 0)
            if cam_id not in camera_workers:
                worker = CameraWorker(camera_id=cam_id, source=source, socketio=socketio)
                worker.start()
                camera_workers[cam_id] = worker

def stop_all_cameras():
    for worker in camera_workers.values():
        worker.stop()
    camera_workers.clear()

@app.post("/api/start_cameras")
@verify_firebase_token
@require_admin
def api_start_cameras():
    start_all_cameras()
    return jsonify({"ok": True, "message": "Cameras started"})

@app.post("/api/stop_cameras")
@verify_firebase_token
@require_admin
def api_stop_cameras():
    stop_all_cameras()
    return jsonify({"ok": True, "message": "Cameras stopped"})

# --------- Auto-stop cameras only when no admins remain ---------
@app.post("/api/check_stop_cameras")
def api_check_stop_cameras():
    """
    Called from navigator.sendBeacon on tab close.
    If /activeAdmins in Firebase is empty, stop all cameras.
    """
    try:
        active_admins = db.reference("/activeAdmins").get() or {}
        if not active_admins:
            stop_all_cameras()
            return jsonify({"ok": True, "message": "Cameras stopped (no admins left)"})
        return jsonify({"ok": True, "message": "Admins still connected, cameras running"})
    except Exception as e:
        app.logger.exception("check_stop_cameras failed")
        return jsonify({"error": str(e)}), 500

# --------------------------------------------------------------------------------------
# Main entry
# --------------------------------------------------------------------------------------
if __name__ == "__main__":
    # ✅ Cameras do NOT auto-start here
    socketio.run(app,
                 host="0.0.0.0",
                 port=8000,
                 debug=False,
                 allow_unsafe_werkzeug=True)
