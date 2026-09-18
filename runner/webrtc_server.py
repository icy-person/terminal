#!/usr/bin/env python3
import asyncio
import fractions
import json
import logging
import os
import subprocess
import threading
import time

from aiohttp import web
from aiortc import RTCPeerConnection, RTCConfiguration, RTCIceServer, RTCSessionDescription, RTCRtpSender
from aiortc.mediastreams import MediaStreamError, MediaStreamTrack
from av import AudioFrame
from aiortc.contrib.media import MediaPlayer
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
FPS = max(15, min(60, int(os.getenv("WEBRTC_FPS", "30"))))
VIDEO_BITRATE = max(1_000_000, min(12_000_000, int(os.getenv("WEBRTC_VIDEO_BITRATE", "6000000"))))
STUN_URL = os.getenv("WEBRTC_STUN_URL", "stun:stun.l.google.com:19302")
TURN_URL = os.getenv("WEBRTC_TURN_URL", "")
TURN_USERNAME = os.getenv("WEBRTC_TURN_USERNAME", "")
TURN_PASSWORD = os.getenv("WEBRTC_TURN_PASSWORD", "")

if not PASSWORD:
    raise SystemExit("WEBRTC_PASSWORD is required")

# Keep the encoder VBV buffer at ~25% of the bitrate (~250 ms): a large
# buffer lets keyframes burst far above the average bitrate, which shows up
# as periodic packet-loss spikes on constrained paths, and it adds latency.
VBV_BUFFER = int(os.getenv("WEBRTC_VBV_BUFFER", str(max(100_000, VIDEO_BITRATE // 4))))
VIDEO_THREADS = max(2, min(4, int(os.getenv("WEBRTC_X264_THREADS", str(os.cpu_count() or 2)))))
vpx.DEFAULT_BITRATE = VIDEO_BITRATE
vpx.MIN_BITRATE = VIDEO_BITRATE
vpx.MAX_BITRATE = VIDEO_BITRATE
h264.DEFAULT_BITRATE = VIDEO_BITRATE
h264.MIN_BITRATE = VIDEO_BITRATE
h264.MAX_BITRATE = VIDEO_BITRATE


pcs = set()

class DropOldestQueue(asyncio.Queue):
    async def put(self, item):
        if self.full():
            try: self.get_nowait()
            except asyncio.QueueEmpty: pass
        self.put_nowait(item)


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
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "warning",
        "-f", "x11grab", "-video_size", f"{WIDTH}x{HEIGHT}",
        "-framerate", str(FPS), "-draw_mouse", "0", "-i", DISPLAY,
        "-an", "-c:v", "libx264", "-preset", "ultrafast",
        "-tune", "zerolatency", "-profile:v", "baseline", "-level:v", "4.0",
        "-pix_fmt", "yuv420p", "-r", str(FPS), "-fps_mode", "cfr",
        "-g", str(FPS), "-keyint_min", str(FPS), "-sc_threshold", "0",
        "-bf", "0", "-refs", "1", "-threads", str(VIDEO_THREADS),
        "-b:v", str(VIDEO_BITRATE), "-minrate", str(VIDEO_BITRATE),
        "-maxrate", str(VIDEO_BITRATE), "-bufsize", str(VBV_BUFFER),
        "-x264-params", "repeat-headers=1:scenecut=0:force-cfr=1:rc-lookahead=0:sync-lookahead=0:sliced-threads=1:slices=4",
        "-fflags", "+nobuffer", "-muxdelay", "0", "-muxpreload", "0",
        "-flush_packets", "1", "-stats_period", "2", "-progress", os.getenv("WEBRTC_VIDEO_PROGRESS", "/tmp/webrtc-video-progress.log"), "-f", "mpegts", "pipe:1",
    ]
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE,
        stderr=open(os.getenv("WEBRTC_VIDEO_LOG", "/tmp/webrtc-video-ffmpeg.log"), "ab", buffering=0),
        bufsize=0, env={**os.environ, "DISPLAY": DISPLAY},
    )
    player = MediaPlayer(proc.stdout, format="mpegts", decode=False)
    player._throttle_playback = False
    player._webrtc_ffmpeg = proc
    if getattr(player, 'video', None) is not None:
        player.video._queue = DropOldestQueue(maxsize=4)
    return player

class PulseAudioTrack(MediaStreamTrack):
    kind = "audio"
    RATE = 48000
    CHANNELS = 2
    SAMPLES = 960
    BYTES_PER_FRAME = SAMPLES * CHANNELS * 2

    def __init__(self, source, loop):
        super().__init__()
        self.source = source
        self._loop = loop
        self.queue = DropOldestQueue(maxsize=4)
        self.proc = subprocess.Popen([
            "ffmpeg", "-hide_banner", "-loglevel", "warning",
            "-f", "pulse", "-i", source,
            "-ac", "2", "-ar", "48000", "-f", "s16le", "pipe:1",
        ], stdout=subprocess.PIPE, stderr=open(os.getenv("WEBRTC_AUDIO_LOG", "/tmp/webrtc-audio-ffmpeg.log"), "ab", buffering=0), bufsize=0,
        env={**os.environ, "PULSE_SERVER": os.getenv("PULSE_SERVER", "")})
        self.running = True
        self.pts = 0
        self.thread = threading.Thread(target=self._reader, name="pulse-audio", daemon=True)
        self.thread.start()

    def _reader(self):
        while self.running and self.proc.stdout:
            data = self.proc.stdout.read(self.BYTES_PER_FRAME)
            if not data or len(data) < self.BYTES_PER_FRAME:
                break
            asyncio.run_coroutine_threadsafe(self.queue.put(data), self._loop)

    async def recv(self):
        if self.readyState != "live":
            raise MediaStreamError
        if not hasattr(self, "_loop"):
            self._loop = asyncio.get_running_loop()
        data = await self.queue.get()
        frame = AudioFrame(format="s16", layout="stereo", samples=self.SAMPLES)
        frame.planes[0].update(data)
        frame.sample_rate = self.RATE
        frame.pts = self.pts
        frame.time_base = fractions.Fraction(1, self.RATE)
        self.pts += self.SAMPLES
        return frame

    def stop(self):
        if self.running:
            self.running = False
            try: self.proc.terminate()
            except Exception: pass
            if self.thread.is_alive(): self.thread.join(timeout=1)
        super().stop()


def make_audio_player():
    source = os.getenv("PULSE_SOURCE", "webrtc_sink.monitor")
    return PulseAudioTrack(source, asyncio.get_running_loop())


class InputBridge:
    """Inject browser keyboard/mouse events into the X11 desktop with XTest."""
    def __init__(self):
        self.display = self.xtest = self.X = None
        # python-xlib is not thread-safe: input events run on the asyncio
        # event loop thread while clipboard helpers run in worker threads,
        # so every X access is serialized through this re-entrant lock.
        self.lock = threading.RLock()
        try:
            from Xlib import X, XK, display as xdisplay
            from Xlib.ext import xtest
            self.X, self.XK = X, XK
            self.display, self.xtest = xdisplay.Display(DISPLAY), xtest
            screen = self.display.screen()
            self.width, self.height = screen.width_in_pixels, screen.height_in_pixels
            self.mouse_x, self.mouse_y = self.width // 2, self.height // 2
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
        with self.lock:
            kc = self._keycode(code, key)
            if kc:
                self.xtest.fake_input(self.display, self.X.KeyPress if down else self.X.KeyRelease, kc)
                self.display.flush()

    def text(self, text):
        if not self.display or not text:
            return
        try:
            # xclip runs outside the X lock so a slow clipboard write never
            # blocks live mouse/keyboard events.
            subprocess.run(
                ["xclip", "-selection", "clipboard", "-in"],
                input=str(text), text=True, check=True, timeout=3,
                env={**os.environ, "DISPLAY": DISPLAY},
            )
            with self.lock:
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
                input=str(text),
                text=True,
                check=True,
                timeout=3,
                env={**os.environ, "DISPLAY": DISPLAY},
            )
            with self.lock:
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
        with self.lock:
            self.mouse_x = max(0, min(self.width - 1, round(float(x) * (self.width - 1))))
            self.mouse_y = max(0, min(self.height - 1, round(float(y) * (self.height - 1))))
            self.xtest.fake_input(self.display, self.X.MotionNotify, x=self.mouse_x, y=self.mouse_y)
            self.display.flush()

    def button(self, button, down):
        if not self.display:
            return
        with self.lock:
            if button:
                self.xtest.fake_input(self.display, self.X.ButtonPress if down else self.X.ButtonRelease, int(button))
                self.display.flush()

    def mouse_relative(self, dx, dy):
        if not self.display:
            return
        with self.lock:
            self.mouse_x = max(0, min(self.width - 1, int(self.mouse_x + float(dx))))
            self.mouse_y = max(0, min(self.height - 1, int(self.mouse_y + float(dy))))
            self.xtest.fake_input(self.display, self.X.MotionNotify, x=self.mouse_x, y=self.mouse_y)
            self.display.flush()

    def wheel(self, delta):
        if not self.display:
            return
        with self.lock:
            button = 4 if float(delta) < 0 else 5
            count = min(8, max(1, round(abs(float(delta)) / 40)))
            for _ in range(count):
                self.xtest.fake_input(self.display, self.X.ButtonPress, button)
                self.xtest.fake_input(self.display, self.X.ButtonRelease, button)
            self.display.flush()


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
    # FFmpeg emits constrained-baseline H.264. Put the matching 42e01f
    # packetization profile first so aiortc does not negotiate a profile which
    # the pre-encoded stream cannot satisfy.
    h264 = [
        c for c in codecs
        if c.mimeType.lower() == "video/h264"
        and c.parameters.get("packetization-mode") == "1"
    ]
    h264.sort(key=lambda c: 0 if c.parameters.get("profile-level-id", "").lower() == "42e01f" else 1)
    vp8 = [c for c in codecs if c.mimeType.lower() == "video/vp8"]
    rtx = [c for c in codecs if c.mimeType.lower() == "video/rtx"]
    return h264 + vp8 + rtx


async def handle_offer_post(request):
    pc = None
    input_bridge = None
    video = audio = None
    try:
        data = json.loads(await request.text())
        if data.get("password", "") != PASSWORD:
            return web.json_response({"error": "unauthorized"}, status=401, headers=cors_headers())
        sdp = data.get("sdp", "")
        if not sdp:
            return web.json_response({"error": "missing sdp"}, status=400, headers=cors_headers())

        pc = RTCPeerConnection(RTCConfiguration(iceServers=ice_servers()))
        pcs.add(pc)
        loop = asyncio.get_running_loop()
        input_bridge = InputBridge()
        video = make_video_player()
        selected_codecs = preferred_video_codecs()
        if video.video:
            transceiver = pc.addTransceiver(video.video, direction="sendonly")
            if selected_codecs:
                transceiver.setCodecPreferences(selected_codecs)
            log.info("video capture started: %sx%s @ %s fps; bitrate=%s; x264 threads=%s; codec preference=%s", WIDTH, HEIGHT, FPS, VIDEO_BITRATE, VIDEO_THREADS, [(c.mimeType, c.parameters) for c in selected_codecs])
        else:
            log.error("x11grab opened but did not expose a video track")
            return web.json_response({"error": "X11 video capture produced no video track"}, status=500, headers=cors_headers())

        try:
            audio = make_audio_player()
            if audio.audio:
                pc.addTrack(audio.audio)
                log.info("audio capture started from %s", os.getenv("PULSE_SERVER", "default"))
        except Exception as exc:
            log.warning("audio capture unavailable: %s", exc)

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            log.info("peer connection state=%s", pc.connectionState)
            if pc.connectionState in {"failed", "closed"}:
                pcs.discard(pc)
                if video:
                    video.stop()
                if audio:
                    audio.stop()
                if input_bridge is not None and input_bridge.display is not None:
                    with input_bridge.lock:
                        try:
                            input_bridge.display.close()
                        except Exception:
                            pass
                        input_bridge.display = None
                if pc.connectionState != "closed":
                    await pc.close()
            elif pc.connectionState == "disconnected":
                log.warning("peer temporarily disconnected; waiting for ICE recovery")

        @pc.on("iceconnectionstatechange")
        async def on_iceconnectionstatechange():
            log.info("ICE state=%s connection=%s", pc.iceConnectionState, pc.connectionState)

        async def telemetry():
            while pc.connectionState not in {"closed", "failed"}:
                await asyncio.sleep(5)
                try:
                    q = getattr(getattr(video, 'video', None), '_queue', None)
                    if q is not None:
                        log.info("video queue=%s/%s", q.qsize(), q.maxsize)
                    proc = getattr(video, '_webrtc_ffmpeg', None)
                    if proc is not None and proc.poll() is not None:
                        log.error("FFmpeg exited rc=%s", proc.returncode)
                except Exception:
                    pass
        asyncio.create_task(telemetry())

        @pc.on("datachannel")
        def on_datachannel(channel):
            log.info("input channel opened: %s", channel.label)

            # xclip-backed helpers spawn subprocesses that can block for
            # seconds. Running them inline would freeze RTP video, RTCP and
            # all input processing, so they are offloaded to worker threads.
            def offload(coro):
                asyncio.run_coroutine_threadsafe(coro, loop)

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
                        offload(asyncio.to_thread(input_bridge.text, str(event.get("text", ""))))
                    elif kind == "paste":
                        offload(asyncio.to_thread(input_bridge.paste, str(event.get("text", ""))))
                    elif kind == "clipboard-copy":
                        async def return_clipboard():
                            text = await asyncio.to_thread(input_bridge.clipboard)
                            if text and channel.readyState == "open":
                                channel.send(json.dumps({"type": "clipboard", "text": text}))
                        offload(return_clipboard())
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
            if video:
                video.stop()
            if audio:
                audio.stop()
            if input_bridge is not None and input_bridge.display is not None:
                with input_bridge.lock:
                    try:
                        input_bridge.display.close()
                    except Exception:
                        pass
                    input_bridge.display = None
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
app.on_shutdown.append(on_shutdown)

if __name__ == "__main__":
    log.info("WebRTC server listening on %s:%s display=%s %sx%s@%s", HOST, PORT, DISPLAY, WIDTH, HEIGHT, FPS)
    web.run_app(app, host=HOST, port=PORT)
