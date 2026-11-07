"""dsh-uitest sidecar —— 把 Windows UI Automation 包装成一个本地 HTTP 服务。

设计要点（都是实测踩出来的）：
  - UIA 跨进程访问**需要足够权限**：受限令牌下控件树会被截断成 2 个节点；
  - `powershell -File` 在 stdin 被重定向时不响应，所以每次请求起一个**一次性**
    PS 进程、请求走临时文件（~0.5~0.9s/次），而不是常驻 stdin worker；
  - 窗口枚举用 Win32 EnumWindows（毫秒级），不碰 UIA 根节点（那条路很慢）。

OCR 兜底（v0.3）：
  - 自绘/第三方控件没有 UIA 时，退回「截图 + WinRT OCR + 坐标点击」；
  - 截图用 GDI 屏幕抓取（PrintWindow 对 GPU 渲染的窗口会返回花屏）；
  - OCR 走一次性 PowerShell（本地、零视觉 token），语言优先 zh-Hans-CN。
"""

import ctypes
import ctypes.wintypes as wt
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ONCE = os.path.join(HERE, "uia_once.ps1")
OCR_PS = os.path.join(HERE, "ocr_once.ps1")
PS = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
TIMEOUT = float(os.environ.get("DSH_UITEST_TIMEOUT", "90"))

u32 = ctypes.windll.user32

# DPI 感知：坐标一律用物理像素，和 Win32 窗口矩形对齐
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:  # noqa: BLE001
    try:
        u32.SetProcessDPIAware()
    except Exception:  # noqa: BLE001
        pass

# ---------------------------------------------------------------- 窗口枚举（Win32，不碰 UIA）


def list_windows(visible_only=True, pid=None):
    rows = []
    Proc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

    def cb(hwnd, _):
        try:
            if visible_only and not u32.IsWindowVisible(hwnd):
                return True
            n = u32.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(n + 1)
            u32.GetWindowTextW(hwnd, buf, n + 1)
            cls = ctypes.create_unicode_buffer(256)
            u32.GetClassNameW(hwnd, cls, 256)
            r = wt.RECT()
            u32.GetWindowRect(hwnd, ctypes.byref(r))
            pid = wt.DWORD()
            u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            cur_pid = int(pid.value)
            if pid_filter is not None and cur_pid != pid_filter:
                return True
            rows.append({
                "hwnd": int(hwnd),
                "title": buf.value,
                "cls": cls.value,
                "pid": cur_pid,
                "rect": [r.left, r.top, r.right - r.left, r.bottom - r.top],
                "foreground": int(hwnd) == int(u32.GetForegroundWindow()),
            })
        except Exception:
            pass
        return True

    pid_filter = int(pid) if pid else None
    u32.EnumWindows(Proc(cb), 0)
    return rows


def resolve_hwnd(req):
    if req.get("hwnd"):
        return int(req["hwnd"])
    title = req.get("title")
    pid = req.get("pid")
    if not title and not pid:
        raise RuntimeError("需要 hwnd / title / pid 之一")
    wins = list_windows(visible_only=False, pid=pid)
    if title:
        exact = [w for w in wins if w["title"] == title]
        if exact:
            return exact[0]["hwnd"]
        part = [w for w in wins if title in w["title"]]
        if part:
            return part[0]["hwnd"]
        raise RuntimeError("找不到标题包含「%s」的窗口%s" % (title, "（pid=%s）" % pid if pid else ""))
    # 只给了 pid：取第一个有标题的可见窗口
    named = [w for w in wins if w["title"]]
    if named:
        return named[0]["hwnd"]
    if wins:
        return wins[0]["hwnd"]
    raise RuntimeError("pid=%s 下没有窗口" % pid)


def window_rect(hwnd):
    r = wt.RECT()
    u32.GetWindowRect(hwnd, ctypes.byref(r))
    return [r.left, r.top, r.right - r.left, r.bottom - r.top]


def focus_window(hwnd):
    try:
        u32.ShowWindow(hwnd, 9)  # SW_RESTORE
        u32.SetForegroundWindow(hwnd)
    except Exception:  # noqa: BLE001
        pass
    time.sleep(0.15)


# ---------------------------------------------------------------- 调 PS


def run_ps(req):
    fd, path = tempfile.mkstemp(suffix=".json", prefix="uitest-")
    os.close(fd)
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(req, f, ensure_ascii=False)
        t0 = time.time()
        p = subprocess.run(
            [PS, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ONCE, "-ReqFile", path],
            capture_output=True, timeout=TIMEOUT,
        )
        ms = int((time.time() - t0) * 1000)
        out = p.stdout.decode("utf-8", "replace").strip()
        if not out:
            raise RuntimeError("UIA 脚本没有输出：%s" % p.stderr.decode("utf-8", "replace")[:600])
        data = json.loads(out)
        data["ms"] = ms
        return data
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def run_ocr(image_path, lang=None):
    cmd = [PS, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", OCR_PS, "-Image", image_path]
    if lang:
        cmd += ["-Lang", lang]
    t0 = time.time()
    p = subprocess.run(cmd, capture_output=True, timeout=TIMEOUT)
    wall = int((time.time() - t0) * 1000)
    out = p.stdout.decode("utf-8", "replace").strip()
    if not out:
        raise RuntimeError("OCR 脚本没有输出：%s" % p.stderr.decode("utf-8", "replace")[:400])
    data = json.loads(out)
    data["wallMs"] = wall
    return data


# ---------------------------------------------------------------- 截图 / 点击


def capture(hwnd, region=None, scale=1.0, path=None):
    from PIL import ImageGrab

    x, y, w, h = window_rect(hwnd)
    if region:
        rx, ry, rw, rh = [int(v) for v in region]
        # region 用窗口相对坐标
        x, y, w, h = x + rx, y + ry, rw, rh
    if w <= 0 or h <= 0:
        raise RuntimeError("窗口矩形无效：%s" % ([x, y, w, h],))
    im = ImageGrab.grab(bbox=(x, y, x + w, y + h), all_screens=True)
    if scale and float(scale) != 1.0:
        s = float(scale)
        im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))))
    out = path
    if not out:
        fd, out = tempfile.mkstemp(suffix=".png", prefix="uitest-shot-")
        os.close(fd)
    im.save(out)
    return {"path": out, "origin": [x, y], "size": [im.width, im.height], "scale": float(scale or 1.0)}


def click_abs(x, y, button="left", double=False):
    flags = {"left": (0x0002, 0x0004), "right": (0x0008, 0x0010), "middle": (0x0020, 0x0040)}
    down, up = flags.get(button, flags["left"])
    u32.SetCursorPos(int(x), int(y))
    time.sleep(0.03)
    for _ in range(2 if double else 1):
        u32.mouse_event(down, 0, 0, 0, 0)
        time.sleep(0.03)
        u32.mouse_event(up, 0, 0, 0, 0)
        time.sleep(0.06)


def auto_scale(w, h):
    """小窗口字太小 OCR 会读错，放大约 2200px 长边最稳；大窗口略缩以免超 WinRT 尺寸上限。"""
    m = max(int(w), int(h), 1)
    return max(0.6, min(3.0, 2200.0 / m))


def lev(a, b):
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def fuzzy_match(needle, lines, tol_ratio=0.34):
    """OCR 常把「刷新」读成「0新」。先精确子串，再按编辑距离兜底。"""
    norm = lambda s: "".join(str(s).split())
    want = norm(needle)
    if not want:
        return []
    exact = [ln for ln in lines if want in norm(ln["compact"])]
    if exact:
        return [(ln, "exact", 0) for ln in exact]
    out = []
    for ln in lines:
        cand = norm(ln["compact"])
        if not cand:
            continue
        d = lev(want, cand)
        tol = max(1, int(len(want) * tol_ratio))
        if d <= tol:
            out.append((ln, "fuzzy", d))
    out.sort(key=lambda x: x[2])
    return out


def ocr_window(hwnd, region=None, scale=None, lang=None, do_focus=True):
    if do_focus:
        focus_window(hwnd)
    if scale is None:
        x, y, w, h = window_rect(hwnd)
        if region:
            w, h = int(region[2]), int(region[3])
        scale = auto_scale(w, h)
    cap = capture(hwnd, region=region, scale=scale)
    try:
        res = run_ocr(cap["path"], lang=lang)
    finally:
        try:
            os.unlink(cap["path"])
        except OSError:
            pass
    if not res.get("ok"):
        raise RuntimeError(res.get("error") or "OCR 失败")
    ox, oy = cap["origin"]
    s = cap["scale"] or 1.0
    lines = []
    for ln in res.get("lines") or []:
        lx, ly = int(ln["x"] / s), int(ln["y"] / s)
        lw, lh = int(ln["w"] / s), int(ln["h"] / s)
        lines.append({
            "text": ln["text"],
            "compact": ln.get("compact") or ln["text"].replace(" ", ""),
            "x": lx, "y": ly, "w": lw, "h": lh,
            "absX": ox + lx, "absY": oy + ly,
        })
    return {
        "ok": True,
        "lang": res.get("lang"),
        "count": len(lines),
        "ocrMs": res.get("ms"),
        "wallMs": res.get("wallMs"),
        "rect": window_rect(hwnd),
        "origin": [ox, oy],
        "lines": lines,
    }


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("content-length") or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8"))

    def do_GET(self):
        if self.path.split("?")[0] in ("/health", "/"):
            self._send(200, {"ok": True, "ps": PS, "once": ONCE, "ocr": OCR_PS, "version": "0.3.0"})
        else:
            self._send(404, {"ok": False, "error": "未知路径"})

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            body = self._body()
            if path == "/windows":
                wins = list_windows(visible_only=bool(body.get("visibleOnly", True)), pid=body.get("pid"))
                title = body.get("title")
                if title:
                    wins = [w for w in wins if title in w["title"]]
                self._send(200, {"ok": True, "count": len(wins), "windows": wins})
                return
            if path == "/call":
                req = dict(body)
                req["hwnd"] = resolve_hwnd(req)
                req.pop("title", None)
                self._send(200, run_ps(req))
                return
            if path == "/ocr":
                hwnd = resolve_hwnd(body)
                data = ocr_window(hwnd, region=body.get("region"), scale=body.get("scale"),
                                  lang=body.get("lang"), do_focus=body.get("focus", True))
                self._send(200, data)
                return
            if path == "/click":
                click_abs(body.get("x"), body.get("y"), button=body.get("button", "left"),
                          double=bool(body.get("double")))
                self._send(200, {"ok": True, "clicked": [int(body.get("x")), int(body.get("y"))],
                                 "button": body.get("button", "left")})
                return
            if path == "/click_text":
                hwnd = resolve_hwnd(body)
                needle = str(body.get("text") or "")
                if not needle:
                    raise RuntimeError("需要 text")
                data = ocr_window(hwnd, region=body.get("region"), scale=body.get("scale"),
                                  lang=body.get("lang"), do_focus=body.get("focus", True))
                hits = fuzzy_match(needle, data["lines"])
                data["matches"] = len(hits)
                if not hits:
                    data["ok"] = False
                    data["error"] = "OCR 里没有包含「%s」的文字" % needle
                    data["seen"] = [ln["text"] for ln in data["lines"]]
                    self._send(200, data)
                    return
                idx = int(body.get("index") or 0)
                if idx >= len(hits):
                    data["ok"] = False
                    data["error"] = "index %d 超出匹配数 %d" % (idx, len(hits))
                    self._send(200, data)
                    return
                hit, how, dist = hits[idx]
                cx = hit["absX"] + hit["w"] // 2
                cy = hit["absY"] + hit["h"] // 2
                click_abs(cx, cy, button=body.get("button", "left"), double=bool(body.get("double")))
                data["matched"] = hit
                data["matchType"] = how
                data["distance"] = dist
                data["clicked"] = [cx, cy]
                self._send(200, data)
                return
            if path == "/capture":
                hwnd = resolve_hwnd(body)
                info = capture(hwnd, region=body.get("region"), scale=body.get("scale", 1.0),
                               path=body.get("out"))
                self._send(200, {"ok": True, **info})
                return
            self._send(404, {"ok": False, "error": "未知路径 %s" % path})
        except subprocess.TimeoutExpired:
            self._send(500, {"ok": False, "error": "调用超时（%.0fs）" % TIMEOUT})
        except Exception as e:  # noqa: BLE001
            self._send(500, {"ok": False, "error": "%s: %s" % (type(e).__name__, e)})


def main():
    port = 0
    for i, a in enumerate(sys.argv):
        if a == "--port" and i + 1 < len(sys.argv):
            port = int(sys.argv[i + 1])
    for f in (ONCE, OCR_PS):
        if not os.path.isfile(f):
            print(json.dumps({"ok": False, "error": "缺少 %s" % os.path.basename(f)}))
            raise SystemExit(1)
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(json.dumps({"ok": True, "port": srv.server_address[1], "pid": os.getpid()}), flush=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
