import os
from datetime import datetime, timezone
from typing import Dict, Any, List

import firebase_admin
from firebase_admin import credentials, db, auth

from dotenv import load_dotenv
load_dotenv()

SERVICE_ACCOUNT_PATH = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH", "serviceAccountKey.json")
DB_URL = os.getenv("FIREBASE_DB_URL")

if not firebase_admin._apps:
    if not os.path.exists(SERVICE_ACCOUNT_PATH):
        raise FileNotFoundError(f"Missing service account file at {SERVICE_ACCOUNT_PATH}. Place it and update .env")
    cred = credentials.Certificate(SERVICE_ACCOUNT_PATH)
    firebase_admin.initialize_app(cred, {"databaseURL": DB_URL} if DB_URL else None)

def _now_iso():
    return datetime.now(timezone.utc).isoformat()

# ----- Users & roles -----
def ensure_default_admin():
    """Create default admin user if not present (admin@example.com / admin123)."""
    email = "admin@example.com"
    password = "admin123"
    display_name = "admin"
    try:
        user = auth.get_user_by_email(email)
        uid = user.uid
    except auth.UserNotFoundError:
        user = auth.create_user(email=email, password=password, display_name=display_name, disabled=False)
        uid = user.uid

    # Always enforce admin role via custom claims + DB
    auth.set_custom_user_claims(uid, {"role": "admin"})
    db.reference(f"/users/{uid}").update({
        "name": display_name,
        "email": email,
        "role": "admin",
        "prefs": {"language": "english"},
        "createdAt": _now_iso()
    })
    return uid

def create_user(name: str, email: str, password: str, role: str):
    user = auth.create_user(email=email, password=password, display_name=name, disabled=False)
    uid = user.uid
    # Attach custom claims for role
    auth.set_custom_user_claims(uid, {"role": role})
    db.reference(f"/users/{uid}").set({
        "name": name,
        "email": email,
        "role": role,
        "prefs": {"language": "english"},
        "createdAt": _now_iso()
    })
    return uid

def update_user_password(uid: str, new_password: str):
    auth.update_user(uid, password=new_password)
    return True

def set_user_language(uid: str, language: str):
    db.reference(f"/users/{uid}/prefs").update({"language": language.lower()})
    return True

def get_user(uid: str) -> Dict[str, Any]:
    return db.reference(f"/users/{uid}").get() or {}

# ----- Cameras -----
def list_cameras() -> Dict[str, Any]:
    return db.reference("/cameras").get() or {}

def add_camera(name: str, source: str) -> str:
    ref = db.reference("/cameras").push({
        "name": name,
        "source": source,
        "active": True,
        "createdAt": _now_iso()
    })
    return ref.key

def update_camera(camera_id: str, data: Dict[str, Any]):
    db.reference(f"/cameras/{camera_id}").update(data)

def cameras_active_count() -> int:
    cams = list_cameras()
    return sum(1 for c in (cams or {}).values() if c.get("active"))

# ----- System status & dashboard data -----
def set_system_status(running: bool):
    db.reference("/system/status").set({"running": running, "updatedAt": _now_iso()})

def set_threat_level(level: str):
    db.reference("/system/threatLevel").set({"level": level, "updatedAt": _now_iso()})

def get_dashboard_snapshot():
    status = db.reference("/system/status").get() or {"running": False}
    threat = db.reference("/system/threatLevel").get() or {"level": "low"}
    alerts_today = db.reference("/dashboard/alertsToday").order_by_child("createdAt").limit_to_last(3).get() or {}
    alerts_list = sorted(list(alerts_today.values()), key=lambda x: x.get("createdAt", ""), reverse=True)[:3]
    return {
        "status": status.get("running", False),
        "threatLevel": threat.get("level", "low"),
        "camerasActive": cameras_active_count(),
        "alertsToday": alerts_list
    }

def push_alert_today(item: Dict[str, Any]):
    db.reference("/dashboard/alertsToday").push(item)

# ----- Detections & activity log -----
def save_detection_verified(d: Dict[str, Any]):
    d = {**d, "savedAt": _now_iso(), "status": d.get("status", "verified")}
    db.reference("/detections").push(d)

def get_verified_today() -> List[Dict[str, Any]]:
    items = db.reference("/detections").order_by_child("status").equal_to("verified").get() or {}
    return list(items.values())
