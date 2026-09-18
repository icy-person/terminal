#!/usr/bin/env python3
import asyncio
import json
import logging
import os
import subprocess

from aiohttp import web
from aiortc import RTCPeerConnection, RTCConfiguration, RTCIceServer, RTCSessionDescription, RTCRtpSender
from aiortc.contrib.media import MediaPlayer
from aiortc.mediastreams import MediaStreamError, MediaStreamTrack
import aiortc.codecs.vpx as vpx
import aiortc.codecs.h264 as h264

logging.basicConfig(level=os.getenv("WEBRTC_LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("terminal-webrtc")

HOST = os.getenv("WEBRTC_HOST", "127.0.0.1")
PORT = int(os.getenv("WEBRTC_PORT", "8092"))
PASSWORD = os.environ.get("WEBRTC_PASSWORD", "")
DISPLAY = os.getenv("DISPLAY", ":99")
WIDTH = int(os.getenv("WEBRTC_WIDTH", "1920"))
HEIGHT = int(os.getenv("WEBRTC_HEIGHT", "1080"))
FPS = 30
VIDEO_BITRATE = 6_000_000
STUN_URL = os.getenv("WEBRTC_STUN_URL", "stun:stun.l.google.com:19302")
TURN_URL = os.getenv("WEBRTC_TURN_URL", "")
TURN_USERNAME = os.getenv("WEBRTC_TURN_USERNAME", "")
TURN_PASSWORD = os.getenv("WEBRTC_TURN_PASSWORD", "")

if not PASSWORD:
    raise SystemExit("WEBRTC_PASSWORD is required")

vpx.DEFAULT_BITRATE = VIDEO_BITRATE
vpx.MIN_BITRATE = VIDEO_BITRATE
vpx.MAX_BITRATE = VIDEO_BITRATE
h264.DEFAULT_BITRATE = VIDEO_BITRATE
h264.MIN_BITRATE = VIDEO_BITRATE
h264.MAX_BITRATE = VIDEO_BITRATE

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
    """
    Capture + H.264 encode in a dedicated FFmpeg process.

    The old path decoded X11 frames into Python/PyAV and then asked aiortc
    to encode every frame again. That adds a full frame-copy/encode boundary
    and, on a CPU-only runner, makes 1080p30 prone to stalls.

    FFmpeg now produces timestamped H.264 directly. aiortc receives encoded
    packets and only packetizes them into RTP; it does not re-encode them.
    """
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "warning",
        "-f", "x11grab",
        "-video_size", f"{WIDTH}x{HEIGHT}",
        "-framerate", str(FPS),
        "-draw_mouse", "0",
        "-i", DISPLAY,
        "-an",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-profile:v", "baseline",
        "-level:v", "4.0",
        "-pix_fmt", "yuv420p",
        "-r", str(FPS),
        "-fps_mode", "cfr",
        "-g", str(FPS),
        "-keyint_min", str(FPS),
        "-sc_threshold", "0",
        "-bf", "0",
        "-refs", "1",
        "-threads", "4",
        "-b:v", str(VIDEO_BITRATE),
        "-minrate", str(VIDEO_BITRATE),
        "-maxrate", str(VIDEO_BITRATE),
        "-bufsize", str(VIDEO_BITRATE),
        "-x264-params",
        "repeat-headers=1:scenecut=0:force-cfr=1:rc-lookahead=0:sync-lookahead=0",
        "-fflags", "+nobuffer",
        "-muxdelay", "0",
        "-muxpreload", "0",
        "-flush_packets", "1",
        "-f", "mpegts",
        "pipe:1",
    ]

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        bufsize=0,
        env={**os.environ, "DISPLAY": DISPLAY},
    )
    if proc.stdout is None:
        proc.kill()
        raise RuntimeError("failed to open FFmpeg video pipe")

    player = MediaPlayer(proc.stdout, format="mpegts", decode=False)
    # MPEG-TS is normally treated as a file by MediaPlayer, which would make
    # it pace packets according to timestamps and add latency. This is a live
    # pipe, so FFmpeg is the clock and we must not re-throttle it.
    player._throttle_playback = False
    player._webrtc_ffmpeg = proc
    log.info(
        "FFmpeg H264 capture started: %sx%s @ %sfps, CBR=%s, preset=ultrafast",
        WIDTH, HEIGHT, FPS, VIDEO_BITRATE,
    )
    return player


def stop_video_player(player):
    if player is None:
        return
    try:
        track = player.video
        if track:
            track.stop()
    except Exception:
        pass

    proc = getattr(player, "_webrtc_ffmpeg", None)
    if proc is not None:
        try:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=1.0)
        except Exception:
            pass


def make_audio_player():
    """
    Capture the desktop monitor as raw PCM.

    Do not use the aggressive video-style nobuffer/probe settings here:
    Pulse audio is a continuous live stream and starving its demuxer can
    make the shared FFmpeg/PyAV worker stall, which in turn can make the
    video appear frozen. Let FFmpeg/PyAV keep normal audio timing.
    """
    source = os.getenv("PULSE_SOURCE", "webrtc_sink.monitor")
    return MediaPlayer(source, format="pulse", options={
        "sample_rate": "48000",
        "channels": "2",
        "thread_queue_size": "64",
    }, decode=True)


class LatestVideoTrack(MediaStreamTrack):
    """Keep exactly one newest encoded/decoded video unit and drop stale ones."""

    kind = "video"

    def __init__(self, source):
        super().__init__()
        self._source = source
        self._latest = None
        self._event = asyncio.Event()
        self._task = asyncio.create_task(self._drain())

    async def _drain(self):
        try:
            while True:
                frame = await self._source.recv()
                self._latest = frame
                self._event.set()
        except (MediaStreamError, asyncio.CancelledError):
            pass
        except Exception:
            log.exception("video capture drain failed")
        finally:
            self._event.set()

    async def recv(self):
        if self.readyState != "live":
            raise MediaStreamError

        while self._latest is None:
            await self._event.wait()
            self._event.clear()
            if self.readyState != "live" and self._latest is None:
                raise MediaStreamError

        frame = self._latest
        self._latest = None
        return frame

    def stop(self):
        if self.readyState == "ended":
            return
        super().stop()
        if self._task is not None:
            self._task.cancel()
            self._task = None
        if self._source is not None:
            self._source.stop()
            self._source = None
        self._latest = None
        self._event.set()


class InputBridge:
    """Inject browser keyboard/mouse events into the X11 desktop with XTest."""
    def __init__(self):
        self.display = self.xtest = self.X = None
        try:
            from Xlib import X, XK, display as xdisplay
            from Xlib.ext import xtest
            self.X, self.XK = X, XK
            self.display, self.xtest = xdisplay.Display(DISPLAY), xtest
            screen = self.display.screen()
            self.width, self.height = screen.width_in_pixels, screen.height_in_pixels
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
            "NumLock":"Num_Lock", "Minus":"minus", "Equal":"equal",
            "BracketLeft":"bracketleft", "BracketRight":"bracketright",
            "Backslash":"backslash", "Semicolon":"semicolon", "Quote":"apostrophe",
            "Comma":"comma", "Period":"period", "Slash":"slash", "Backquote":"grave",
        }
        name = names.get(code)
        if not name and code.startswith("Key") and len(code) == 4:
            name = code[-1].lower()
        if not name and code.startswith("Digit") and len(code) == 6:
            name = code[-1]
        if not name and code.startswith("Numpad"):
            name = {"NumpadAdd":"KP_Add", "NumpadSubtract":"KP_Subtract",
                    "NumpadMultiply":"KP_Multiply", "NumpadDivide":"KP_Divide",
                    "NumpadDecimal":"KP_Decimal", "NumpadEnter":"KP_Enter"}.get(code)
        if not name and code.startswith("F") and code[1:].isdigit():
            name = code
        if not name and len(key) == 1:
            name = key
        if not name:
            return 0
        keysym = self.XK.string_to_keysym(name)
        if keysym == 0 and len(key) == 1:
            keysym = self.XK.string_to_keysym(key)
        return self.display.keysym_to_keycode(keysym) if keysym else 0

    def key(self, code, key, down):
        if not self.display:
            return
        kc = self._keycode(code, key)
        if kc:
            self.xtest.fake_input(self.display, self.X.KeyPress if down else self.X.KeyRelease, kc)
            self.display.sync()

    def text(self, text):
        if not self.display or not text:
            return
        try:
            subprocess.run(
                ["xclip", "-selection", "clipboard", "-in"],
                input=str(text), text=True, check=True, timeout=3,
                env={**os.environ, "DISPLAY": DISPLAY},
            )
            self.key("ControlLeft", "Control", True)
            self.key("KeyV", "v", True)
            self.key("KeyV", "v", False)
            self.key("ControlLeft", "Control", False)
        except Exception as exc:
            log.warning("unicode text injection failed: %s", exc)

    def paste(self, text):
        if not self.display or text is None:
            return
        try:
            subprocess.run(
                ["xclip", "-selection", "clipboard", "-in"],
                input=str(text), text=True, check=True, timeout=3,
                env={**os.environ, "DISPLAY": DISPLAY},
            )
            self.key("ControlLeft", "Control", True)
            self.key("KeyV", "v", True)
            self.key("KeyV", "v", False)
            self.key("ControlLeft", "Control", False)
        except Exception as exc:
            log.warning("clipboard paste failed: %s", exc)

    def clipboard(self):
        if not self.display:
            return ""
        try:
            return subprocess.run(
                ["xclip", "-selection", "clipboard", "-out"],
                capture_output=True, text=True, check=True, timeout=2,
                env={**os.environ, "DISPLAY": DISPLAY},
            ).stdout
        except Exception:
            return ""

    def mouse(self, x, y):
        if not self.display:
            return
        px = max(0, min(self.width - 1, round(float(x) * (self.width - 1))))
        py = max(0, min(self.height - 1, round(float(y) * (self.height - 1))))
        self.xtest.fake_input(self.display, self.X.MotionNotify, x=px, y=py)
        self.display.sync()

    def button(self, button, down):
        if not self.display:
            return
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
        "ok": True,
        "service": "terminal-webrtc",
        "display": DISPLAY,
        "width": WIDTH,
        "height": HEIGHT,
        "fps": FPS,
        "bitrate": VIDEO_BITRATE,
        "peers": len(pcs),
        "video_codecs": ["VP8", "H264"],
        "turn_configured": turn_configured(),
        "auth": "fixed-password",
    })


def cors_headers():
    return {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Cache-Control": "no-store"}


def preferred_video_codecs():
    codecs = RTCRtpSender.getCapabilities("video").codecs
    h264_codecs = [c for c in codecs if c.mimeType.lower() == "video/h264"]
    vp8 = [c for c in codecs if c.mimeType.lower() == "video/vp8"]
    rtx = [c for c in codecs if c.mimeType.lower() == "video/rtx"]
    return h264_codecs + vp8 + rtx


async def handle_offer_post(request):
    pc = None
    input_bridge = None
    video = audio = latest_video = None
    try:
        data = json.loads(await request.text())
        if data.get("password", "") != PASSWORD:
            return web.json_response({"error": "unauthorized"}, status=401, headers=cors_headers())
        sdp = data.get("sdp", "")
        if not sdp:
            return web.json_response({"error": "missing sdp"}, status=400, headers=cors_headers())

        pc = RTCPeerConnection(RTCConfiguration(iceServers=ice_servers()))
        pcs.add(pc)
        input_bridge = InputBridge()
        video = make_video_player()
        if not video.video:
            log.error("x11grab opened but did not expose a video track")
            return web.json_response({"error": "X11 video capture produced no video track"}, status=500, headers=cors_headers())

        latest_video = LatestVideoTrack(video.video)
        selected_codecs = preferred_video_codecs()
        transceiver = pc.addTransceiver(latest_video, direction="sendonly")
        if selected_codecs:
            transceiver.setCodecPreferences(selected_codecs)
        log.info(
            "video pipeline ready: FFmpeg H264 packets -> latest-packet mode -> aiortc RTP; "
            "%sx%s @ %s fps; codec preference=%s",
            WIDTH, HEIGHT, FPS, [c.mimeType for c in selected_codecs],
        )

        try:
            audio = make_audio_player()
            if audio.audio:
                pc.addTrack(audio.audio)
                log.info("audio capture started from %s source=%s",
                         os.getenv("PULSE_SERVER", "default"),
                         os.getenv("PULSE_SOURCE", "@DEFAULT_MONITOR@"))
        except Exception as exc:
            log.warning("audio capture unavailable: %s", exc)

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            log.info("peer connection state=%s", pc.connectionState)
            if pc.connectionState in {"failed", "closed"}:
                pcs.discard(pc)
                if latest_video:
                    latest_video.stop()
                if video:
                    stop_video_player(video)
                if audio:
                    audio.stop()
                if pc.connectionState != "closed":
                    await pc.close()
            elif pc.connectionState == "disconnected":
                log.warning("peer temporarily disconnected; waiting for ICE recovery")

        @pc.on("iceconnectionstatechange")
        async def on_iceconnectionstatechange():
            log.info("ICE state=%s connection=%s", pc.iceConnectionState, pc.connectionState)

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
                    elif kind == "text":
                        input_bridge.text(str(event.get("text", "")))
                    elif kind == "paste":
                        input_bridge.paste(str(event.get("text", "")))
                    elif kind == "clipboard-copy":
                        text = input_bridge.clipboard()
                        if text and channel.readyState == "open":
                            channel.send(json.dumps({"type": "clipboard", "text": text}))
                    elif kind == "mouse":
                        input_bridge.mouse(float(event.get("x", 0.5)), float(event.get("y", 0.5)))
                    elif kind == "button":
                        input_bridge.button(int(event.get("button", 1)), bool(event.get("down")))
                    elif kind == "mouse_rel":
                        input_bridge.mouse_relative(float(event.get("dx", 0)), float(event.get("dy", 0)))
                    elif kind == "wheel":
                        input_bridge.wheel(float(event.get("delta", 0)))
                except Exception as exc:
                    log.debug("input event failed: %s", exc)

        await pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type="offer"))
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        await wait_ice_complete(pc)

        negotiated = []
        for section in pc.localDescription.sdp.split("m="):
            if section.startswith("video "):
                negotiated.append(section.split("\n", 1)[0])

        return web.json_response({
            "type": "answer",
            "sdp": pc.localDescription.sdp,
            "ready": {
                "width": WIDTH,
                "height": HEIGHT,
                "fps": FPS,
                "bitrate": VIDEO_BITRATE,
                "transport": "webrtc",
                "videoCodecs": [c.mimeType for c in selected_codecs],
                "videoMLine": negotiated[0] if negotiated else "",
                "turn": turn_configured(),
            },
        }, headers=cors_headers())
    except Exception as exc:
        log.exception("WebRTC HTTP signaling failed: %s", exc)
        if pc is not None:
            pcs.discard(pc)
            if latest_video:
                latest_video.stop()
            if video:
                stop_video_player(video)
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
app.router.add_post("/webrtc", handle_offer_post)
app.router.add_options("/webrtc", handle_offer_options)

if __name__ == "__main__":
    log.info("WebRTC server listening on %s:%s display=%s %sx%s@%s", HOST, PORT, DISPLAY, WIDTH, HEIGHT, FPS)
    web.run_app(app, host=HOST, port=PORT)
