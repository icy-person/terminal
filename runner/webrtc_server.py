#!/usr/bin/env python3
import asyncio
import json
import logging
import os

from aiohttp import web
from aiortc import RTCPeerConnection, RTCConfiguration, RTCIceServer, RTCSessionDescription, RTCRtpSender
from aiortc.contrib.media import MediaPlayer

logging.basicConfig(level=os.getenv("WEBRTC_LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("terminal-webrtc")

HOST = os.getenv("WEBRTC_HOST", "127.0.0.1")
PORT = int(os.getenv("WEBRTC_PORT", "8092"))
TOKEN = os.environ.get("TERMINAL_TOKEN", "")
DISPLAY = os.getenv("DISPLAY", ":99")
WIDTH = int(os.getenv("WEBRTC_WIDTH", "1920"))
HEIGHT = int(os.getenv("WEBRTC_HEIGHT", "1080"))
FPS = max(30, min(45, int(os.getenv("WEBRTC_FPS", "45"))))
VIDEO_BITRATE = max(1_000_000, min(12_000_000, int(os.getenv("WEBRTC_VIDEO_BITRATE", "10000000"))))
STUN_URL = os.getenv("WEBRTC_STUN_URL", "stun:stun.l.google.com:19302")
TURN_URL = os.getenv("WEBRTC_TURN_URL", "")
TURN_USERNAME = os.getenv("WEBRTC_TURN_USERNAME", "")
TURN_PASSWORD = os.getenv("WEBRTC_TURN_PASSWORD", "")

if not TOKEN:
    raise SystemExit("TERMINAL_TOKEN is required")

pcs = set()


def turn_configured():
    return bool(TURN_URL and TURN_USERNAME and TURN_PASSWORD)


def ice_servers():
    servers = [RTCIceServer(urls=[STUN_URL])]
    if turn_configured():
        servers.append(RTCIceServer(urls=[TURN_URL], username=TURN_USERNAME, credential=TURN_PASSWORD))
    return servers


async def wait_ice_complete(pc):
    for _ in range(240):
        if pc.iceGatheringState == "complete":
            return
        await asyncio.sleep(0.025)


def make_video_player():
    return MediaPlayer(DISPLAY, format="x11grab", options={
        "video_size": f"{WIDTH}x{HEIGHT}",
        "framerate": str(FPS),
        "draw_mouse": "0",
        "fflags": "nobuffer",
        "flags": "low_delay",
        "probesize": "32",
        "analyzeduration": "0",
    }, decode=True)


def make_audio_player():
    pulse = os.getenv("PULSE_SERVER", "")
    return MediaPlayer(pulse or "default", format="pulse", options={
        "sample_rate": "48000",
        "channels": "2",
        "fflags": "nobuffer",
        "probesize": "32",
        "analyzeduration": "0",
    }, decode=True)


class InputBridge:
    """Inject browser keyboard/mouse events into the X11 desktop with XTest."""
    def __init__(self):
        self.display = None
        self.xtest = None
        self.X = None
        try:
            from Xlib import X, XK, display as xdisplay
            from Xlib.ext import xtest
            self.X = X
            self.XK = XK
            self.display = xdisplay.Display(DISPLAY)
            self.xtest = xtest
            screen = self.display.screen()
            self.width = screen.width_in_pixels
            self.height = screen.height_in_pixels
            log.info("XTest input bridge ready: %s %sx%s", DISPLAY, self.width, self.height)
        except Exception as exc:
            log.warning("XTest input bridge unavailable: %s", exc)

    def _keycode(self, code, key):
        if not self.display:
            return 0
        names = {
            "Escape":"Escape", "Enter":"Return", "Tab":"Tab", "Backspace":"BackSpace",
            "Delete":"Delete", "Insert":"Insert", "Home":"Home", "End":"End",
            "PageUp":"Prior", "PageDown":"Next", "ArrowUp":"Up", "ArrowDown":"Down",
            "ArrowLeft":"Left", "ArrowRight":"Right", "Space":"space",
            "ShiftLeft":"Shift_L", "ShiftRight":"Shift_R", "ControlLeft":"Control_L",
            "ControlRight":"Control_R", "AltLeft":"Alt_L", "AltRight":"Alt_R",
            "MetaLeft":"Super_L", "MetaRight":"Super_R", "CapsLock":"Caps_Lock",
            "NumLock":"Num_Lock",
        }
        name = names.get(code)
        if not name and code.startswith("Key") and len(code) == 4:
            name = code[-1].lower()
        if not name and code.startswith("Digit") and len(code) == 6:
            name = code[-1]
        if not name and code.startswith("F") and code[1:].isdigit():
            name = code
        if not name and len(key) == 1:
            name = key
        if not name:
            return 0
        return self.display.keysym_to_keycode(self.XK.string_to_keysym(name))

    def key(self, code, key, down):
        if not self.display:
            return
        kc = self._keycode(code, key)
        if kc:
            self.xtest.fake_input(self.display, self.X.KeyPress if down else self.X.KeyRelease, kc)
            self.display.sync()

    def mouse(self, x, y, button=0, down=False):
        if not self.display:
            return
        px = max(0, min(self.width - 1, round(float(x) * self.width)))
        py = max(0, min(self.height - 1, round(float(y) * self.height)))
        self.xtest.fake_input(self.display, self.X.MotionNotify, x=px, y=py)
        if button:
            self.xtest.fake_input(self.display, self.X.ButtonPress if down else self.X.ButtonRelease, int(button))
        self.display.sync()

    def mouse_relative(self, dx, dy):
        if not self.display:
            return
        q = self.display.screen().root.query_pointer()
        px = max(0, min(self.width - 1, int(q.root_x + float(dx))))
        py = max(0, min(self.height - 1, int(q.root_y + float(dy))))
        self.xtest.fake_input(self.display, self.X.MotionNotify, x=px, y=py)
        self.display.sync()

    def wheel(self, delta):
        if not self.display:
            return
        button = 4 if float(delta) < 0 else 5
        count = min(8, max(1, round(abs(float(delta)) / 40)))
        for _ in range(count):
            self.xtest.fake_input(self.display, self.X.ButtonPress, button)
            self.xtest.fake_input(self.display, self.X.ButtonRelease, button)
        self.display.sync()


async def health(_request):
    return web.json_response({
        "ok": True, "service": "terminal-webrtc", "display": DISPLAY,
        "width": WIDTH, "height": HEIGHT, "fps": FPS,
        "bitrate": VIDEO_BITRATE, "peers": len(pcs),
        "video_codec": "H264", "turn_configured": turn_configured(),
    })


async def config(request):
    if request.query.get("token", "") != TOKEN:
        return web.json_response({"error": "unauthorized"}, status=401, headers={"Access-Control-Allow-Origin": "*"})
    servers = [{"urls": STUN_URL}]
    if turn_configured():
        servers.append({"urls": TURN_URL, "username": TURN_USERNAME, "credential": TURN_PASSWORD})
    return web.json_response({
        "iceServers": servers,
        "fps": FPS, "width": WIDTH, "height": HEIGHT,
        "bitrate": VIDEO_BITRATE, "videoCodec": "H264",
    }, headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"})


def cors_headers():
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Cache-Control": "no-store",
    }


async def handle_offer_post(request):
    """HTTP signaling: POST a fully ICE-gathered SDP offer and return the answer."""
    if request.query.get("token", "") != TOKEN:
        return web.json_response({"error": "unauthorized"}, status=401, headers=cors_headers())

    pc = RTCPeerConnection(RTCConfiguration(iceServers=ice_servers()))
    pcs.add(pc)
    input_bridge = InputBridge()
    video = audio = None

    try:
        data = await request.json()
        sdp = data.get("sdp", "")
        if not sdp:
            return web.json_response({"error": "missing sdp"}, status=400, headers=cors_headers())

        video = make_video_player()
        if video.video:
            transceiver = pc.addTransceiver(video.video, direction="sendonly")
            codecs = RTCRtpSender.getCapabilities("video").codecs
            h264 = [c for c in codecs if c.mimeType.lower() == "video/h264"]
            if h264:
                transceiver.setCodecPreferences(h264)
            log.info("video capture started: %sx%s @ %s fps; H264 preference=%s", WIDTH, HEIGHT, FPS, bool(h264))

        try:
            audio = make_audio_player()
            if audio.audio:
                pc.addTrack(audio.audio)
                log.info("audio capture started from %s", os.getenv("PULSE_SERVER", "default"))
        except Exception as exc:
            log.warning("audio capture unavailable: %s", exc)

        @pc.on("datachannel")
        def on_datachannel(channel):
            log.info("input channel opened: %s", channel.label)
            @channel.on("message")
            def on_message(message):
                if not isinstance(message, str):
                    return
                try:
                    event = json.loads(message)
                    kind = event.get("type")
                    if kind == "key":
                        input_bridge.key(str(event.get("code", "")), str(event.get("key", "")), bool(event.get("down")))
                    elif kind in ("mouse", "button"):
                        input_bridge.mouse(float(event.get("x", 0)), float(event.get("y", 0)), int(event.get("button", 0 if kind == "mouse" else 1)), bool(event.get("down")))
                    elif kind == "mouse_rel":
                        input_bridge.mouse_relative(float(event.get("dx", 0)), float(event.get("dy", 0)))
                    elif kind == "wheel":
                        input_bridge.wheel(float(event.get("delta", 0)))
                except Exception as exc:
                    log.debug("input event failed: %s", exc)

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            log.info("connection state=%s", pc.connectionState)
            if pc.connectionState in ("failed", "closed"):
                await pc.close()

        await pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type="offer"))
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        await wait_ice_complete(pc)

        return web.json_response({
            "type": "answer", "sdp": pc.localDescription.sdp,
            "ready": {
                "width": WIDTH, "height": HEIGHT, "fps": FPS,
                "bitrate": VIDEO_BITRATE, "transport": "webrtc",
                "videoCodec": "H264", "turn": turn_configured(),
            },
        }, headers=cors_headers())
    except Exception as exc:
        log.exception("WebRTC HTTP signaling failed: %s", exc)
        pcs.discard(pc)
        if video:
            video.stop()
        if audio:
            audio.stop()
        await pc.close()
        return web.json_response({"error": "WebRTC signaling failed", "detail": str(exc)}, status=500, headers=cors_headers())


async def handle_offer_options(_request):
    return web.Response(status=204, headers=cors_headers())


async def on_shutdown(_app):
    await asyncio.gather(*(pc.close() for pc in list(pcs)), return_exceptions=True)
    pcs.clear()


app = web.Application()
app.router.add_get("/healthz", health)
app.router.add_get("/config", config)
app.router.add_post("/webrtc", handle_offer_post)
app.router.add_options("/webrtc", handle_offer_options)
app.on_shutdown.append(on_shutdown)

if __name__ == "__main__":
    log.info("WebRTC server listening on %s:%s display=%s %sx%s@%s", HOST, PORT, DISPLAY, WIDTH, HEIGHT, FPS)
    web.run_app(app, host=HOST, port=PORT)
