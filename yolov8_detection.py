import os
import cv2
import time
import threading
import numpy as np
from typing import Dict, Any, Tuple, List
from dotenv import load_dotenv
from ultralytics import YOLO

import firebase_manager as fm

load_dotenv()
MODEL_PATH = os.getenv("YOLO_MODEL_PATH", "best.pt")

# Threat mapping based on class names
LOW_CLASSES = {"noMask", "medicalMask"}
HIGH_CLASSES = {"other_coverings", "otherCoverings", "other_Coverings", "weapons", "weapon"}

class Detector:
    def __init__(self):
        if not os.path.exists(MODEL_PATH):
            raise FileNotFoundError(
                f"YOLO model not found at {MODEL_PATH}. Place your best.pt and set YOLO_MODEL_PATH."
            )
        self.model = YOLO(MODEL_PATH)
        self.lock = threading.Lock()

    def detect_frame(self, frame: np.ndarray) -> Tuple[np.ndarray, List[Dict[str, Any]], str]:
        """Run detection on a frame. Returns annotated frame, detections list, and threat level."""
        with self.lock:
            results = self.model.predict(source=frame, verbose=False)[0]

        dets: List[Dict[str, Any]] = []
        threat_level = "low"
        for box in results.boxes:
            cls_id = int(box.cls[0])
            conf = float(box.conf[0])
            xyxy = box.xyxy[0].cpu().numpy().astype(int).tolist()
            name = results.names.get(cls_id, str(cls_id))
            # Normalize variants
            name_norm = name.replace(" ", "").replace("-", "").replace("_", "").lower()
            if name_norm in {"nomask"}:
                label = "noMask"
            elif name_norm in {"medicalmask"}:
                label = "medicalMask"
            elif name_norm in {"othercoverings", "othercovering"}:
                label = "other_coverings"
            elif name_norm in {"weapon", "weapons"}:
                label = "weapons"
            else:
                label = name

            # threat level
            if label in HIGH_CLASSES:
                threat_level = "high"

            dets.append({
                "label": label,
                "conf": round(conf, 3),
                "bbox": xyxy
            })

        # Annotate frame
        annotated = frame.copy()
        for d in dets:
            x1, y1, x2, y2 = d["bbox"]
            color = (0, 255, 0) if d["label"] in LOW_CLASSES else (0, 0, 255)
            cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2)
            cv2.putText(
                annotated,
                f"{d['label']} {d['conf']}",
                (x1, max(20, y1 - 10)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                color,
                2,
                cv2.LINE_AA,
            )
        return annotated, dets, threat_level

detector = None
def get_detector():
    global detector
    if detector is None:
        detector = Detector()
    return detector

class CameraWorker(threading.Thread):
    def __init__(self, camera_id: str, source, socketio=None):
        super().__init__(daemon=True)
        self.camera_id = camera_id
        self.source = source
        self.socketio = socketio
        self.capture = None
        self.running = False

    def run(self):
        self.capture = cv2.VideoCapture(self.source)
        self.running = True
        fm.set_system_status(True)

        while self.running:
            ok, frame = self.capture.read()
            if not ok:
                time.sleep(0.2)
                continue

            annotated, dets, threat = get_detector().detect_frame(frame)
            fm.set_threat_level(threat)

            # Push rolling alerts
            if dets:
                first = dets[0]
                fm.push_alert_today({
                    "label": first["label"],
                    "camera": self.camera_id,
                    "conf": first["conf"],
                    "createdAt": time.time()
                })

                payload = {
                    "camera": self.camera_id,
                    "time": time.time(),
                    "detections": dets,
                    "threatLevel": threat
                }

                if self.socketio:
                    # Send detections to frontend
                    self.socketio.emit("pending_detection", payload, namespace="/stream")

                    # 🚨 Siren only for high-threat *specific* labels
                    for d in dets:
                        if d["label"] in HIGH_CLASSES:
                            self.socketio.emit("high_threat", {"label": d["label"], **payload}, namespace="/stream")
                            break

            # tiny sleep to avoid pegging CPU
            time.sleep(0.02)

        if self.capture:
            self.capture.release()
        fm.set_system_status(False)

    def stop(self):
        self.running = False

# MJPEG generator for a given source
def mjpeg_generator(source):
    cap = cv2.VideoCapture(source)
    while True:
        ok, frame = cap.read()
        if not ok:
            time.sleep(0.2)
            continue
        annotated, dets, threat = get_detector().detect_frame(frame)
        fm.set_threat_level(threat)
        ret, jpeg = cv2.imencode('.jpg', annotated)
        if not ret:
            continue
        frame_bytes = jpeg.tobytes()
        yield (
            b'--frame\r\n'
            b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n'
        )
    cap.release()
