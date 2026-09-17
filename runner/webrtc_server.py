#!/usr/bin/env python3
import asyncio
import json
import logging
import os
import signal
from fractions import Fraction

from aiohttp import web
from aiortc import RTCPeerConnection, RTCConfiguration, RTCIceServer, RTCSessionDescription
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

pcs: set[RTCPeerConnection] = set()


def ice_servers():
    servers = [RTCIceServer(urls=[STUN_URL])]
    if TURN_URL and TURN_USERNAME and TURN_PASSWORD:
        servers.append(RTCIceServer(urls=[TURN_URL], username=TURN_USERNAME, credential=TURN_PASSWORD))
    return servers


def ice_complete(pc: RTCPeerConnection):
    async def wait():
        for _ in range(200):
            if pc.iceGatheringState == "complete":
                return
            await asyncio.sleep(0.025)
    return wait()


def make_video_player():
    options = {
        "video_size": f"{WIDTH}x{HEIGHT}",
        "framerate": str(FPS),
        "draw_mouse": "0",
        "fflags": "nobuffer",
        "flags": "low_delay",
        "probesize": "32",
        "analyzeduration": "0",
    }
    # X11 capture is provided by FFmpeg through PyAV/MediaPlayer.
    return MediaPlayer(DISPLAY, format="x11grab", options=options, decode=True)


def make_audio_player():
    pulse = os.getenv("PULSE_SERVER", "")
    options = {
        "sample_rate": "48000",
        "channels": "2",
        "fflags": "nobuffer",
        "probesize": "32",
        "analyzeduration": "0",
    }
    source = "default"
    if pulse:
        source = pulse
    return MediaPlayer(source, format="pulse", options=options, decode=True)


class InputBridge:
    """Low-latency XTest mouse/keyboard injection for the XFCE X server."""
    def __init__(self):
        self.display = None
        self.xtest = None
        self.root = None
        try:
            from Xlib import X, display as xdisplay
            from Xlib.ext import xtest
            self.X = X
            self.display = xdisplay.Display(os.getenv("DISPLAY", DISPLAY))
            self.xtest = xtest
            self.root = self.display.screen().root
            self.width = self.display.screen().width_in_pixels
            self.height = self.display.screen().height_in_pixels
            log.info("XTest input bridge ready on %s (%sx%s)", os.getenv("DISPLAY", DISPLAY), self.width, self.height)
        except Exception as exc:
            log.warning("XTest input bridge unavailable: %s", exc)

    def _keycode(self, code: str, key: str = ""):
        if not self.display:
            return 0
        from Xlib import XK
        names = {
            "Escape": "Escape", "Enter": "Return", "Tab": "Tab", "Backspace": "BackSpace",
            "Delete": "Delete", "Insert": "Insert", "Home": "Home", "End": "End",
            "PageUp": "Prior", "PageDown": "Next", "ArrowUp": "Up", "ArrowDown": "Down",
            "ArrowLeft": "Left", "ArrowRight": "Right", "Space": "space",
            "ShiftLeft": "Shift_L", "ShiftRight": "Shift_R", "ControlLeft": "Control_L",
            "ControlRight": "Control_R", "AltLeft": "Alt_L", "AltRight": "Alt_R",
            "MetaLeft": "Super_L", "MetaRight": "Super_R", "CapsLock": "Caps_Lock",
            "F1": "F1", "F2": "F2", "F3": "F3", "F4": "F4", "F5": "F5", "F6": "F6",
            "F7": "F7", "F8": "F8", "F9": "F9", "F10": "F10", "F11": "F11", "F12": "F12",
        }
        name = names.get(code)
        if not name and len(key) == 1:
            name = key
        if not name and code.startswith("Key") and len(code) == 4:
            name = code[-1].lower()
        if not name and code.startswith("Digit") and len(code) == 6:
            name = code[-1]
        if not name:
            return 0
        return self.display.keysym_to_keycode(XK.string_to_keysym(name))

    def key(self, code: str, key: str, down: bool):
        if not self.display:
            return
        kc = self._keycode(code, key)
        if not kc:
            return
        self.xtest.fake_input(self.display, self.X.KeyPress if down else self.X.KeyRelease, kc)
        self.display.sync()

    def mouse(self, x: float, y: float, buttons: int = 0, button: int = 0, down: bool = False):
        if not self.display:
            return
        px = max(0, min(self.width - 1, round(x * self.width)))
        py = max(0, min(self.height - 1, round(y * self.height)))
        self.xtest.fake_input(self.display, self.X.MotionNotify, x=px, y=py)
        if button:
            event = self.X.ButtonPress if down else self.X.ButtonRelease
            self.xtest.fake_input(self.display, event, button)
        self.display.sync()


async def wait_connection_state(pc):
    for _ in range(600):
        if pc.connectionState in ("connected", "failed", "closed"):
            return pc.connectionState
        await asyncio.sleep(0.05)
    return pc.connectionState


async def handle_offer(request: web.Request):
    if TOKEN and request.query.get("token", "") != TOKEN:
        return web.json_response({"error": "unauthorized"}, status=401)
    if request.headers.get("upgrade", "").lower() != "websocket":
        return web.json_response({"error": "websocket required"}, status=400)

    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=4 * 1024 * 1024)
    await ws.prepare(request)
    pc = RTCPeerConnection(RTCConfiguration(iceServers=ice_servers()))
    pcs.add(pc)
    input_bridge = InputBridge()
    video = audio = None

    try:
        video = make_video_player()
        if video.video:
            pc.addTrack(video.video)
            log.info("video source %sx%s@%s", WIDTH, HEIGHT, FPS)
        try:
            audio = make_audio_player()
            if audio.audio:
                pc.addTrack(audio.audio)
                log.info("audio source enabled")
        except Exception as exc:
            log.warning("audio capture unavailable: %s", exc)

        @pc.on("datachannel")
        def on_datachannel(channel):
            log.info("input datachannel: %s", channel.label)

            @channel.on("message")
            def on_message(message):
                if not isinstance(message, str):
                    return
                try:
                    event = json.loads(message)
                    kind = event.get("type")
                    if kind == "key":
                        input_bridge.key(str(event.get("code", "")), str(event.get("key", "")), bool(event.get("down")))
                    elif kind == "mouse":
                        input_bridge.mouse(float(event.get("x", 0)), float(event.get("y", 0)), int(event.get("buttons", 0)), int(event.get("button", 0)), bool(event.get("down")))
                except Exception as exc:
                    log.debug("input event failed: %s", exc)

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            log.info("WebRTC connection state=%s", pc.connectionState)
            if pc.connectionState in ("failed", "closed"):
                await pc.close()

        async for message in ws:
            if message.type != web.WSMsgType.TEXT:
                continue
            try:
                data = json.loads(message.data)
            except json.JSONDecodeError:
                await ws.send_json({"error": "invalid json"})
                continue

            if data.get("type") == "offer":
                await pc.setRemoteDescription(RTCSessionDescription(sdp=data["sdp"], type="offer"))
                answer = await pc.createAnswer()
                await pc.setLocalDescription(answer)
                await ice_complete(pc)
                await ws.send_json({"type": "answer", "sdp": pc.localDescription.sdp})
                await ws.send_json({
                    "type": "ready",
                    "width": WIDTH,
                    "height": HEIGHT,
                    "fps": FPS,
                    "bitrate": VIDEO_BITRATE,
                    "transport": "webrtc",
                })
            elif data.get("type") == "ping":
                await ws.send_json({"type": "pong"})

    except Exception as exc:
        log.exception("WebRTC session failed: %s", exc)
    finally:
        pcs.discard(pc)
        if video:
            video.stop()
        if audio:
            audio.stop()
        await pc.close()
        await ws.close()
    return ws


async def health(_request):
    return web.json_response({
        "ok": True,
        "service": "terminal-webrtc",
        "display": DISPLAY,
        "width": WIDTH,
        "height": HEIGHT,
        "fps": FPS,
        "bitrate": VIDEO_BITRATE,
        "peers": len(pcs),
        "turn": bool(TURN_URL),
    })


async def on_shutdown(app):
    await asyncio.gather(*(pc.close() for pc in list(pcs)), return_exceptions=True)
    pcs.clear()


app = web.Application()
app.router.add_get("/healthz", health)
app.router.add_get("/webrtc", handle_offer)
app.on_shutdown.append(on_shutdown)

if __name__ == "__main__":
    log.info("WebRTC server listening on %s:%s display=%s %sx%s@%s", HOST, PORT, DISPLAY, WIDTH, HEIGHT, FPS)
    web.run_app(app, host=HOST, port=PORT)
