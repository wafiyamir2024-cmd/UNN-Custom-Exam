"""Dependency-free server for the employee applicant MCQ exam."""

import argparse
import copy
import getpass
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import secrets
import sys
import tempfile
import threading
import time
import traceback
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit


MAX_BODY_BYTES = 1024 * 1024
MAX_JSON_BYTES = 16 * 1024 * 1024
ADMIN_SESSION_SECONDS = 12 * 60 * 60
CANDIDATE_COOKIE_SECONDS = 30 * 24 * 60 * 60
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self'; "
        "img-src 'self' data:; connect-src 'self'; object-src 'none'; "
        "base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    ),
    "Cache-Control": "no-store",
}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def utc_now():
    return datetime.now(timezone.utc)


def iso_utc(value=None):
    return (value or utc_now()).isoformat().replace("+00:00", "Z")


def parse_utc(value):
    if not isinstance(value, str) or not value:
        raise ValueError("Missing UTC timestamp")
    # .NET stores seven fractional digits; Python datetime keeps six.
    normalized = re.sub(r"(\.\d{6})\d+(?=Z|[+-]\d\d:\d\d$)", r"\1", value)
    parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def token_hash(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_token():
    return secrets.token_urlsafe(32)


def required_string(body, key, max_length):
    value = body.get(key)
    if not isinstance(value, str):
        raise ApiError(400, key + " is required.")
    value = value.strip()
    if not value or len(value) > max_length or any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        raise ApiError(400, key + " has an invalid length or character.")
    return value


def required_int(body, key):
    value = body.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ApiError(400, key + " must be a whole number.")
    return value


def required_bool(body, key):
    value = body.get(key)
    if not isinstance(value, bool):
        raise ApiError(400, key + " must be true or false.")
    return value


def normalize_ic(value):
    return (value or "").replace(" ", "").replace("-", "").upper()


class ExamStore:
    """Holds exam state and serializes every mutation to one JSON file."""

    def __init__(self, root, admin_password):
        self.root = Path(root).resolve()
        self.public_root = (self.root / "public").resolve()
        self.data_file = self.root / "data" / "exam-data.json"
        self.seed_file = self.root / "data" / "seed-questions.json"
        self.lock = threading.RLock()
        self.admin_password_hash = token_hash(admin_password)
        self.admin_sessions = {}
        self.login_attempts = {}
        self.data = self._load_data()

    def _load_data(self):
        self.data_file.parent.mkdir(parents=True, exist_ok=True)
        if self.data_file.exists():
            with self.data_file.open("r", encoding="utf-8-sig") as stream:
                data = json.load(stream)
            if not isinstance(data, dict):
                raise ValueError("The exam data file is invalid.")
            data.setdefault("status", "waiting")
            data.setdefault("durationSeconds", 3600)
            data.setdefault("passPercent", 65)
            data.setdefault("pauseStartedAtUtc", None)
            data.setdefault("questions", [])
            data.setdefault("attempts", [])
            if not isinstance(data["questions"], list) or not isinstance(data["attempts"], list):
                raise ValueError("The exam data file has invalid question or attempt lists.")
            for attempt in data["attempts"]:
                attempt.setdefault("answers", {})
                attempt.setdefault("questions", [])
            return data
        if not self.seed_file.exists():
            raise FileNotFoundError("Missing data/seed-questions.json.")
        with self.seed_file.open("r", encoding="utf-8-sig") as stream:
            questions = json.load(stream)
        if not isinstance(questions, list) or not questions:
            raise ValueError("The question seed is empty or invalid.")
        seen = set()
        for question in questions:
            if not isinstance(question, dict):
                raise ValueError("A question seed entry is invalid.")
            question_id = question.get("id")
            if not isinstance(question_id, str) or not question_id or question_id in seen:
                question_id = secrets.token_hex(16)
                question["id"] = question_id
            seen.add(question_id)
            question.setdefault("section", "General")
            question.setdefault("options", [])
            key = question.get("correctIndex")
            question["enabled"] = (
                isinstance(key, int) and not isinstance(key, bool)
                and 0 <= key < len(question["options"])
            )
        data = {
            "status": "waiting",
            "durationSeconds": 3600,
            "passPercent": 65,
            "pauseStartedAtUtc": None,
            "questions": questions,
            "attempts": [],
        }
        self.data = data
        self.save()
        return data

    def save(self):
        """Replace the live file atomically; retry transient Windows file locks."""
        encoded = json.dumps(self.data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_JSON_BYTES:
            raise RuntimeError("The exam data file has grown beyond the supported size.")
        self.data_file.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="wb", prefix="exam-data-", suffix=".tmp",
            dir=str(self.data_file.parent), delete=False
        ) as stream:
            temporary = Path(stream.name)
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        last_error = None
        for attempt in range(10):
            try:
                os.replace(str(temporary), str(self.data_file))
                return
            except OSError as error:
                last_error = error
                time.sleep(0.05 * (attempt + 1))
        raise OSError("Could not save exam data after multiple attempts.") from last_error

    def question_count(self):
        return sum(1 for question in self.data["questions"] if question.get("enabled"))

    def exam_view(self):
        return {
            "status": self.data["status"],
            "durationSeconds": self.data["durationSeconds"],
            "questionCount": self.question_count(),
        }

    def seconds_remaining(self, attempt):
        status = attempt.get("status")
        if status == "registered":
            return self.data["durationSeconds"]
        if status != "active" or not attempt.get("deadlineAtUtc"):
            return 0
        clock = (
            parse_utc(self.data["pauseStartedAtUtc"])
            if self.data["status"] == "paused" and self.data.get("pauseStartedAtUtc")
            else utc_now()
        )
        return max(0, math.ceil((parse_utc(attempt["deadlineAtUtc"]) - clock).total_seconds()))

    def complete_attempt(self, attempt, status):
        correct = sum(
            1 for question in attempt["questions"]
            if attempt["answers"].get(question["id"]) == question.get("correctIndex")
            and question.get("correctIndex") is not None
        )
        count = len(attempt["questions"])
        percentage = math.floor((1000 * correct / count) + 0.5) / 10 if count else 0
        pass_percent = self.data["passPercent"]
        attempt.update({
            "score": correct,
            "percentage": percentage,
            "pass": count > 0 and correct * 100 >= pass_percent * count,
            "passPercentAtSubmission": pass_percent,
            "status": status,
            "submittedAtUtc": iso_utc(),
        })

    def expire_attempts(self):
        changed = False
        for attempt in self.data["attempts"]:
            if attempt.get("status") == "active" and self.seconds_remaining(attempt) <= 0:
                self.complete_attempt(attempt, "expired")
                changed = True
        if changed:
            self.save()

    def find_candidate(self, token):
        if not token:
            return None
        hashed = token_hash(token)
        for attempt in self.data["attempts"]:
            if hmac.compare_digest(attempt.get("tokenHash") or "", hashed):
                return attempt
        return None

    def require_candidate(self, token):
        attempt = self.find_candidate(token)
        if attempt is None:
            raise ApiError(401, "Please register before starting the exam.")
        return attempt

    def candidate_state(self, attempt):
        if attempt is None:
            return {"authenticated": False, "exam": self.exam_view()}
        ic = attempt.get("ic") or ""
        masked = ("\u2022" * max(0, len(ic) - 4)) + ic[-4:]
        questions = []
        if attempt.get("status") == "active":
            questions = [
                {
                    "id": question["id"],
                    "section": question.get("section"),
                    "text": question.get("text"),
                    "options": question.get("options", []),
                }
                for question in attempt["questions"]
            ]
        return {
            "authenticated": True,
            "exam": self.exam_view(),
            "attempt": {
                "id": attempt["id"],
                "name": attempt["name"],
                "icMasked": masked,
                "status": attempt["status"],
                "startedAtUtc": attempt.get("startedAtUtc"),
                "submittedAtUtc": attempt.get("submittedAtUtc"),
                "secondsRemaining": self.seconds_remaining(attempt),
                "answers": dict(attempt.get("answers", {})),
                "questions": questions,
            },
        }

    def register_candidate(self, body, session_token):
        existing = self.find_candidate(session_token)
        if existing is not None:
            return self.candidate_state(existing), None
        if self.data["status"] == "closed":
            raise ApiError(409, "Registration is closed. Please contact the administrator.")
        name = required_string(body, "name", 120)
        ic = required_string(body, "ic", 32)
        if len(name) < 2:
            raise ApiError(400, "Please enter your full name.")
        if not re.fullmatch(r"[A-Za-z0-9 -]{6,32}", ic):
            raise ApiError(400, "IC must contain 6 to 32 letters, digits, spaces, or hyphens.")
        normalized = normalize_ic(ic)
        if any(normalize_ic(attempt.get("ic")) == normalized for attempt in self.data["attempts"]):
            raise ApiError(409, "This IC is already registered. Ask the administrator for help if you changed browsers.")

        token = new_token()
        attempt = {
            "id": secrets.token_hex(16),
            "name": name,
            "ic": ic,
            "tokenHash": token_hash(token),
            "status": "registered",
            "registeredAtUtc": iso_utc(),
            "startedAtUtc": None,
            "deadlineAtUtc": None,
            "submittedAtUtc": None,
            "answers": {},
            "questions": [],
            "score": None,
            "percentage": None,
            "pass": None,
            "passPercentAtSubmission": None,
        }
        self.data["attempts"].append(attempt)
        self.save()
        return self.candidate_state(attempt), token

    def start_candidate(self, session_token):
        attempt = self.require_candidate(session_token)
        if attempt["status"] == "active":
            return self.candidate_state(attempt)
        if attempt["status"] != "registered":
            raise ApiError(409, "This attempt is already complete.")
        if self.data["status"] != "open":
            raise ApiError(409, "The administrator has not opened the exam.")
        selected = [
            copy.deepcopy(question)
            for question in self.data["questions"]
            if question.get("enabled")
            and isinstance(question.get("correctIndex"), int)
            and not isinstance(question.get("correctIndex"), bool)
            and 0 <= question["correctIndex"] < len(question.get("options", []))
        ]
        if not selected:
            raise ApiError(409, "No graded questions are available yet.")
        secrets.SystemRandom().shuffle(selected)
        now = utc_now()
        attempt.update({
            "questions": selected,
            "answers": {},
            "status": "active",
            "startedAtUtc": iso_utc(now),
            "deadlineAtUtc": iso_utc(now + timedelta(seconds=self.data["durationSeconds"])),
        })
        self.save()
        return self.candidate_state(attempt)

    def save_answer(self, session_token, body):
        attempt = self.require_candidate(session_token)
        if attempt["status"] != "active":
            raise ApiError(409, "This attempt is not active.")
        if self.data["status"] != "open":
            raise ApiError(409, "The exam is paused or closed.")
        question_id = required_string(body, "questionId", 100)
        option_index = required_int(body, "optionIndex")
        question = next((item for item in attempt["questions"] if item["id"] == question_id), None)
        if question is None or not 0 <= option_index < len(question.get("options", [])):
            raise ApiError(400, "Invalid question or answer.")
        attempt["answers"][question_id] = option_index
        self.save()
        return {
            "ok": True,
            "secondsRemaining": self.seconds_remaining(attempt),
            "answers": dict(attempt["answers"]),
        }

    def submit_candidate(self, session_token):
        attempt = self.require_candidate(session_token)
        if attempt["status"] == "registered":
            raise ApiError(409, "The exam has not started.")
        if attempt["status"] == "active":
            self.complete_attempt(attempt, "submitted")
            self.save()
        return self.candidate_state(attempt)

    def admin_login(self, password, address):
        if not isinstance(password, str) or not password or len(password) > 1024:
            raise ApiError(400, "password is required.")
        entry = self.login_attempts.get(address, {"failures": 0, "blocked_until": 0})
        now = time.time()
        if entry["blocked_until"] > now:
            raise ApiError(429, "Too many login attempts. Please try again in five minutes.")
        if not hmac.compare_digest(token_hash(password), self.admin_password_hash):
            entry["failures"] += 1
            if entry["failures"] >= 5:
                entry = {"failures": 0, "blocked_until": now + 300}
            self.login_attempts[address] = entry
            raise ApiError(401, "Incorrect admin password.")
        self.login_attempts.pop(address, None)
        token = new_token()
        self.admin_sessions[token_hash(token)] = now + ADMIN_SESSION_SECONDS
        return token

    def require_admin(self, token):
        if not token:
            raise ApiError(401, "Please sign in as administrator.")
        expires = self.admin_sessions.get(token_hash(token), 0)
        if expires <= time.time():
            raise ApiError(401, "Please sign in as administrator.")

    def admin_logout(self, token):
        if token:
            self.admin_sessions.pop(token_hash(token), None)

    def result_row(self, attempt):
        return {
            "id": attempt["id"],
            "name": attempt["name"],
            "ic": attempt["ic"],
            "status": attempt["status"],
            "score": attempt.get("score"),
            "questionCount": len(attempt.get("questions", [])),
            "percentage": attempt.get("percentage"),
            "pass": attempt.get("pass"),
            "startedAtUtc": attempt.get("startedAtUtc"),
            "submittedAtUtc": attempt.get("submittedAtUtc"),
            "secondsRemaining": self.seconds_remaining(attempt),
        }

    def admin_overview(self):
        attempts = self.data["attempts"]
        results = [
            self.result_row(attempt)
            for attempt in sorted(
                attempts, key=lambda item: item.get("registeredAtUtc") or "", reverse=True
            )
        ]
        return {
            "status": self.data["status"],
            "durationSeconds": self.data["durationSeconds"],
            "passPercent": self.data["passPercent"],
            "questionCount": self.question_count(),
            "waitingCount": sum(attempt["status"] == "registered" for attempt in attempts),
            "activeCount": sum(attempt["status"] == "active" for attempt in attempts),
            "submittedCount": sum(attempt["status"] not in ("registered", "active") for attempt in attempts),
            "results": results,
        }

    def _resume_exam(self):
        paused_at = parse_utc(self.data["pauseStartedAtUtc"])
        pause = utc_now() - paused_at
        for attempt in self.data["attempts"]:
            if attempt["status"] == "active":
                attempt["deadlineAtUtc"] = iso_utc(parse_utc(attempt["deadlineAtUtc"]) + pause)
        self.data["pauseStartedAtUtc"] = None
        self.data["status"] = "open"

    def admin_control(self, body):
        action = required_string(body, "action", 30).lower()
        if action == "open":
            if self.data["status"] == "paused":
                self._resume_exam()
            else:
                if self.question_count() == 0:
                    raise ApiError(409, "Set an answer key and enable at least one question first.")
                self.data["status"] = "open"
        elif action == "pause":
            if self.data["status"] != "open":
                raise ApiError(409, "The exam is not open.")
            self.data["status"] = "paused"
            self.data["pauseStartedAtUtc"] = iso_utc()
        elif action == "resume":
            if self.data["status"] != "paused":
                raise ApiError(409, "The exam is not paused.")
            self._resume_exam()
        elif action == "finish":
            if self.data["status"] != "closed":
                for attempt in self.data["attempts"]:
                    if attempt["status"] == "active":
                        self.complete_attempt(attempt, "finished_by_admin")
                self.data["status"] = "closed"
                self.data["pauseStartedAtUtc"] = None
        else:
            raise ApiError(400, "Unknown exam control action.")
        self.save()
        return self.admin_overview()

    def admin_settings(self, body):
        if "durationMinutes" not in body and "passPercent" not in body:
            raise ApiError(400, "No settings were supplied.")
        minutes = None
        percent = None
        if "durationMinutes" in body:
            minutes = required_int(body, "durationMinutes")
            if minutes < 1 or minutes > 180:
                raise ApiError(400, "Duration must be 1 to 180 minutes.")
        if "passPercent" in body:
            percent = required_int(body, "passPercent")
            if percent < 0 or percent > 100:
                raise ApiError(400, "Pass mark must be 0 to 100 percent.")
        if minutes is not None:
            next_seconds = minutes * 60
            difference = next_seconds - self.data["durationSeconds"]
            for attempt in self.data["attempts"]:
                if attempt["status"] == "active":
                    attempt["deadlineAtUtc"] = iso_utc(
                        parse_utc(attempt["deadlineAtUtc"]) + timedelta(seconds=difference)
                    )
            self.data["durationSeconds"] = next_seconds
        if percent is not None:
            self.data["passPercent"] = percent
        self.expire_attempts()
        self.save()
        return self.admin_overview()

    def admin_adjust_timer(self, body):
        minutes = required_int(body, "minutes")
        if minutes == 0 or not -180 <= minutes <= 180:
            raise ApiError(400, "Adjustment must be between -180 and 180 minutes, excluding zero.")
        candidate_id = body.get("candidateId")
        if candidate_id is not None and not isinstance(candidate_id, str):
            raise ApiError(400, "candidateId must be text.")
        changed = 0
        for attempt in self.data["attempts"]:
            if attempt["status"] != "active" or (candidate_id and attempt["id"] != candidate_id):
                continue
            attempt["deadlineAtUtc"] = iso_utc(
                parse_utc(attempt["deadlineAtUtc"]) + timedelta(minutes=minutes)
            )
            changed += 1
        if changed == 0:
            raise ApiError(409, "No active attempts match this adjustment.")
        self.expire_attempts()
        self.save()
        return self.admin_overview()

    def _parse_question(self, body, question_id, previous=None):
        question = dict(previous or {})
        question["id"] = question_id
        question["section"] = required_string(body, "section", 100)
        question["text"] = required_string(body, "text", 3000)
        if len(question["text"]) < 8:
            raise ApiError(400, "Question text is too short.")
        options = body.get("options")
        if not isinstance(options, list) or not 2 <= len(options) <= 6:
            raise ApiError(400, "A question needs 2 to 6 options.")
        clean_options = []
        for option in options:
            if not isinstance(option, str):
                raise ApiError(400, "Options must be text.")
            option = option.strip()
            if not option or len(option) > 1000:
                raise ApiError(400, "An answer option has an invalid length.")
            clean_options.append(option)
        question["options"] = clean_options
        key = body.get("correctIndex")
        if key is not None:
            if isinstance(key, bool) or not isinstance(key, int) or not 0 <= key < len(clean_options):
                raise ApiError(400, "Correct answer is outside the option list.")
        question["correctIndex"] = key
        question["enabled"] = required_bool(body, "enabled")
        if question["enabled"] and key is None:
            raise ApiError(400, "Choose a correct answer before enabling this question.")
        if isinstance(body.get("explanation"), str):
            question["explanation"] = body["explanation"].strip()
        return question

    def admin_create_question(self, body):
        question = self._parse_question(body, secrets.token_hex(16))
        self.data["questions"].append(question)
        self.save()
        return {"question": question}

    def admin_update_question(self, question_id, body):
        for index, previous in enumerate(self.data["questions"]):
            if previous.get("id") == question_id:
                question = self._parse_question(body, question_id, previous)
                self.data["questions"][index] = question
                self.save()
                return {"question": question}
        raise ApiError(404, "Question not found.")

    def admin_result_detail(self, candidate_id):
        attempt = next(
            (item for item in self.data["attempts"] if item.get("id") == candidate_id), None
        )
        if attempt is None:
            raise ApiError(404, "Applicant result not found.")
        answers = []
        for question in attempt.get("questions", []):
            selected = attempt.get("answers", {}).get(question["id"])
            key = question.get("correctIndex")
            answers.append({
                "id": question["id"],
                "section": question.get("section"),
                "text": question.get("text"),
                "options": question.get("options", []),
                "correctIndex": key,
                "selectedIndex": selected,
                "correct": selected is not None and key is not None and selected == key,
            })
        return {
            "attempt": {
                "id": attempt["id"],
                "name": attempt["name"],
                "ic": attempt["ic"],
                "status": attempt["status"],
                "score": attempt.get("score"),
                "questionCount": len(attempt.get("questions", [])),
                "percentage": attempt.get("percentage"),
                "pass": attempt.get("pass"),
                "startedAtUtc": attempt.get("startedAtUtc"),
                "submittedAtUtc": attempt.get("submittedAtUtc"),
                "passPercentAtSubmission": attempt.get("passPercentAtSubmission"),
            },
            "answers": answers,
        }


class ExamHandler(BaseHTTPRequestHandler):
    """HTTP adapter around ExamStore. Only public/ is exposed as static content."""

    server_version = "ApplicantExam/1.0"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    @property
    def store(self):
        return self.server.exam_store

    def log_message(self, format_string, *args):
        sys.stderr.write(
            "%s %s\n" % (self.log_date_time_string(), format_string % args)
        )

    def do_GET(self):
        self._handle()

    def do_HEAD(self):
        self._handle()

    def do_POST(self):
        self._handle()

    def do_PUT(self):
        self._handle()

    def _handle(self):
        try:
            parsed = urlsplit(self.path)
            if parsed.scheme or parsed.netloc or not parsed.path.startswith("/"):
                raise ApiError(400, "Invalid request path.")
            path = unquote(parsed.path).rstrip("/") or "/"
            if path.startswith("/api/"):
                self._handle_api(path)
            else:
                self._serve_static(path)
        except ApiError as error:
            self._send_json(error.status, {"error": str(error)})
        except (ConnectionError, BrokenPipeError, TimeoutError):
            self.close_connection = True
        except Exception:
            traceback.print_exc()
            self._send_json(500, {"error": "An unexpected server error occurred."})

    def _send_bytes(self, status, payload, content_type, cookie=None, head=False):
        self.send_response(status)
        self.send_header("Connection", "close")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Content-Type", content_type)
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        if cookie is not None:
            name, value, max_age = cookie
            header = (
                f"{name}={value}; Path=/; HttpOnly; SameSite=Strict; "
                f"Max-Age={max_age}"
            )
            if self.headers.get("X-Forwarded-Proto", "").lower() == "https":
                header += "; Secure"
            self.send_header("Set-Cookie", header)
        self.end_headers()
        if not head and payload:
            self.wfile.write(payload)
        self.close_connection = True

    def _send_json(self, status, value, cookie=None):
        payload = json.dumps(
            value, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        self._send_bytes(
            status, payload, "application/json; charset=utf-8",
            cookie=cookie, head=self.command == "HEAD"
        )

    def _redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Connection", "close")
        self.send_header("Content-Length", "0")
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        self.end_headers()
        self.close_connection = True

    def _serve_static(self, path):
        if self.command not in ("GET", "HEAD"):
            raise ApiError(405, "Method not allowed.")
        if path == "/":
            self._redirect("/exam")
            return
        if path == "/exam":
            path = "/exam.html"
        elif path == "/admin":
            path = "/admin.html"
        candidate = (self.store.public_root / path.lstrip("/")).resolve()
        if not candidate.is_relative_to(self.store.public_root):
            raise ApiError(404, "Page not found.")
        types = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".ico": "image/x-icon",
        }
        content_type = types.get(candidate.suffix.lower())
        if content_type is None or not candidate.is_file():
            raise ApiError(404, "Page not found.")
        try:
            payload = candidate.read_bytes()
        except FileNotFoundError:
            raise ApiError(404, "Page not found.")
        self._send_bytes(
            200, payload, content_type, head=self.command == "HEAD"
        )

    def _check_origin(self):
        hosts = self.headers.get_all("Host", [])
        origin = self.headers.get("Origin", "")
        parsed = urlsplit(origin)
        if (
            len(hosts) != 1
            or parsed.scheme not in ("http", "https")
            or not parsed.netloc
            or parsed.netloc.lower() != hosts[0].lower()
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
        ):
            raise ApiError(403, "Request origin is not allowed.")

    def _read_body(self):
        content_type = self.headers.get("Content-Type", "")
        if not content_type.lower().startswith("application/json"):
            raise ApiError(415, "Send a JSON request body.")
        if self.headers.get("Transfer-Encoding"):
            raise ApiError(501, "Transfer encoding is not supported.")
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1:
            raise ApiError(400, "Content-Length is required.")
        try:
            length = int(lengths[0])
        except ValueError:
            raise ApiError(400, "Invalid Content-Length.")
        if length < 0 or length > MAX_BODY_BYTES:
            raise ApiError(413, "Request body is too large.")
        encoded = self.rfile.read(length)
        if len(encoded) != length:
            raise ApiError(400, "Incomplete request body.")
        try:
            value = json.loads(encoded.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(400, "Invalid JSON body.")
        if not isinstance(value, dict):
            raise ApiError(400, "JSON body must be an object.")
        return value

    def _cookie(self, name):
        raw = self.headers.get("Cookie", "")
        if not raw:
            return None
        cookies = SimpleCookie()
        try:
            cookies.load(raw)
        except Exception:
            return None
        entry = cookies.get(name)
        return entry.value if entry is not None else None

    def _handle_api(self, path):
        method = self.command
        if method not in ("GET", "POST", "PUT"):
            raise ApiError(404, "Endpoint not found.")
        if method != "GET":
            self._check_origin()
            body = self._read_body()
        else:
            body = None
        with self.store.lock:
            self.store.expire_attempts()
            result, cookie = self._route_api(path, method, body)
            payload = json.dumps(
                result, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
        self._send_bytes(
            200, payload, "application/json; charset=utf-8",
            cookie=cookie, head=method == "HEAD"
        )

    def _route_api(self, path, method, body):
        candidate_token = self._cookie("applicant_session")
        admin_token = self._cookie("admin_session")

        if path == "/api/candidate/state" and method == "GET":
            return self.store.candidate_state(
                self.store.find_candidate(candidate_token)
            ), None
        if path == "/api/candidate/register" and method == "POST":
            state, token = self.store.register_candidate(body, candidate_token)
            cookie = (
                ("applicant_session", token, CANDIDATE_COOKIE_SECONDS)
                if token else None
            )
            return state, cookie
        if path == "/api/candidate/start" and method == "POST":
            return self.store.start_candidate(candidate_token), None
        if path == "/api/candidate/answer" and method == "PUT":
            return self.store.save_answer(candidate_token, body), None
        if path == "/api/candidate/submit" and method == "POST":
            return self.store.submit_candidate(candidate_token), None

        if path == "/api/admin/login" and method == "POST":
            token = self.store.admin_login(
                body.get("password"), self.client_address[0]
            )
            return {"ok": True}, ("admin_session", token, ADMIN_SESSION_SECONDS)
        if path == "/api/admin/logout" and method == "POST":
            self.store.admin_logout(admin_token)
            return {"ok": True}, ("admin_session", "", 0)

        if path.startswith("/api/admin/"):
            self.store.require_admin(admin_token)
        if path == "/api/admin/overview" and method == "GET":
            return self.store.admin_overview(), None
        if path == "/api/admin/control" and method == "POST":
            return self.store.admin_control(body), None
        if path == "/api/admin/settings" and method == "PUT":
            return self.store.admin_settings(body), None
        if path == "/api/admin/timer/adjust" and method == "POST":
            return self.store.admin_adjust_timer(body), None
        if path == "/api/admin/questions" and method == "GET":
            return {"questions": self.store.data["questions"]}, None
        if path == "/api/admin/questions" and method == "POST":
            return self.store.admin_create_question(body), None
        if path.startswith("/api/admin/questions/") and method == "PUT":
            question_id = path[len("/api/admin/questions/"):]
            return self.store.admin_update_question(question_id, body), None
        if path.startswith("/api/admin/results/") and method == "GET":
            candidate_id = path[len("/api/admin/results/"):]
            return self.store.admin_result_detail(candidate_id), None

        raise ApiError(404, "Endpoint not found.")


def main(argv=None):
    configured_url = os.environ.get("EXAM_URL", "http://0.0.0.0:8787/")
    parsed_url = urlsplit(configured_url)
    if parsed_url.scheme != "http" or not parsed_url.hostname:
        raise ValueError("EXAM_URL must be an HTTP URL such as http://0.0.0.0:8787/.")
    parser = argparse.ArgumentParser(description="Employee applicant MCQ exam server")
    parser.add_argument(
        "--host", default=parsed_url.hostname,
        help="Address to listen on (default from EXAM_URL)"
    )
    parser.add_argument(
        "--port", type=int, default=parsed_url.port or 8787,
        help="Port to listen on (default from EXAM_URL)"
    )
    parser.add_argument(
        "--root",
        default=os.environ.get("EXAM_APP_ROOT", str(Path(__file__).resolve().parent)),
        help="Project root containing public/ and data/"
    )
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("Port must be between 1 and 65535.")

    password = os.environ.get("EXAM_ADMIN_PASSWORD")
    if not password and sys.stdin.isatty():
        password = getpass.getpass("Create an admin password (at least 12 characters): ")
    if not password or len(password) < 12:
        raise ValueError("Set EXAM_ADMIN_PASSWORD to at least 12 characters.")

    store = ExamStore(args.root, password)
    if not store.public_root.is_dir():
        raise FileNotFoundError("Missing public/ directory.")
    server = ThreadingHTTPServer((args.host, args.port), ExamHandler)
    server.daemon_threads = True
    server.exam_store = store
    local_url = "http://127.0.0.1:%s/" % args.port
    print("Exam server listening on %s:%s" % (args.host, args.port), flush=True)
    print("Applicant link: " + local_url + "exam", flush=True)
    print("Admin link:     " + local_url + "admin", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print("Server could not start: " + str(error), file=sys.stderr)
        raise SystemExit(1)
