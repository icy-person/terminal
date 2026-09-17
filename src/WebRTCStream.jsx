import React, { useEffect, useRef, useState } from "react";
import { Box, Button, Chip, Stack, Typography } from "@mui/material";

function wsUrl(value, token) {
  const u = new URL(value, window.location.href);
  u.protocol = u.protocol === "https:" ? "wss:" : u.protocol === "http:" ? "ws:" : u.protocol;
  if (token) u.searchParams.set("token", token);
  return u.toString();
}

function waitIceGathering(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", done);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", done);
  });
}

export default function WebRTCStream({ endpoint, token }) {
  const videoRef = useRef(null);
  const pcRef = useRef(null);
  const wsRef = useRef(null);
  const inputRef = useRef(null);
  const [state, setState] = useState("idle");
  const [stats, setStats] = useState(null);

  const send = message => {
    const channel = inputRef.current;
    if (channel?.readyState === "open") channel.send(JSON.stringify(message));
  };

  useEffect(() => () => {
    try { wsRef.current?.close(); } catch {}
    try { pcRef.current?.close(); } catch {}
  }, []);

  async function start() {
    if (!endpoint) { setState("missing endpoint"); return; }
    setState("connecting");
    try {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        bundlePolicy: "max-bundle",
      });
      pcRef.current = pc;
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
      const input = pc.createDataChannel("input", { ordered: false, maxRetransmits: 0 });
      inputRef.current = input;
      pc.ontrack = event => {
        const stream = event.streams[0];
        if (videoRef.current && stream) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      };
      pc.onconnectionstatechange = () => setState(pc.connectionState);

      const ws = new WebSocket(wsUrl(endpoint, token));
      wsRef.current = ws;
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error("signaling connection failed"));
      });

      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      await waitIceGathering(pc);
      ws.send(JSON.stringify({ type: "offer", sdp: pc.localDescription.sdp }));

      await new Promise((resolve, reject) => {
        ws.onmessage = async event => {
          const message = JSON.parse(event.data);
          if (message.type === "answer") {
            await pc.setRemoteDescription({ type: "answer", sdp: message.sdp });
            resolve();
          } else if (message.type === "ready") {
            setStats(message);
          } else if (message.type === "error") {
            reject(new Error(message.error || "WebRTC server error"));
          }
        };
        ws.onerror = () => reject(new Error("signaling error"));
      });

      if (videoRef.current) await videoRef.current.play().catch(() => {});
      const timer = window.setInterval(async () => {
        if (!pcRef.current) return;
        const reports = await pcRef.current.getStats();
        reports.forEach(report => {
          if (report.type === "inbound-rtp" && report.kind === "video") {
            setStats(prev => ({ ...prev, fps: report.framesPerSecond ?? prev?.fps, bytes: report.bytesReceived }));
          }
        });
      }, 1000);
      pcRef.current._streamStatsTimer = timer;
      setState("connected");
    } catch (error) {
      setState(`error: ${error.message}`);
      try { wsRef.current?.close(); } catch {}
      try { pcRef.current?.close(); } catch {}
    }
  }

  function stop() {
    if (pcRef.current?._streamStatsTimer) window.clearInterval(pcRef.current._streamStatsTimer);
    try { wsRef.current?.close(); } catch {}
    try { pcRef.current?.close(); } catch {}
    wsRef.current = null;
    pcRef.current = null;
    inputRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setState("idle");
  }

  function pointer(event, down = false, button = 0) {
    const rect = event.currentTarget.getBoundingClientRect();
    send({ type: "mouse", x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height, buttons: event.buttons || 0, button, down });
  }

  return <Box sx={{ position: "relative", width: "100%", height: "100%", bgcolor: "#000", overflow: "hidden" }}>
    <video ref={videoRef} controls={false} playsInline style={{ width: "100%", height: "100%", objectFit: "contain", display: "block", background: "#000" }}
      onMouseMove={e => pointer(e)}
      onMouseDown={e => { e.preventDefault(); pointer(e, true, e.button + 1); }}
      onMouseUp={e => { e.preventDefault(); pointer(e, false, e.button + 1); }}
      onContextMenu={e => e.preventDefault()}
      onKeyDown={e => { e.preventDefault(); send({ type: "key", code: e.code, key: e.key, down: true }); }}
      onKeyUp={e => { e.preventDefault(); send({ type: "key", code: e.code, key: e.key, down: false }); }}
      tabIndex={0}
    />
    <Stack direction="row" spacing={1} alignItems="center" sx={{ position: "absolute", left: 12, top: 12, p: 1, borderRadius: 2, bgcolor: "rgba(0,0,0,.65)", backdropFilter: "blur(10px)" }}>
      <Chip size="small" label={state} color={state === "connected" ? "success" : "default"} />
      {stats?.fps != null && <Chip size="small" label={`${Math.round(stats.fps)} FPS`} />}
      {stats?.width && <Chip size="small" label={`${stats.width}×${stats.height}`} />}
      {state === "idle" && <Button size="small" variant="contained" onClick={start}>Start stream</Button>}
      {state === "connected" && <Button size="small" variant="outlined" onClick={stop}>Stop</Button>}
    </Stack>
    <Typography sx={{ position: "absolute", right: 12, bottom: 12, px: 1, py: .5, borderRadius: 1, bgcolor: "rgba(0,0,0,.55)", color: "rgba(255,255,255,.7)", fontSize: 11 }}>
      WebRTC low-latency stream
    </Typography>
  </Box>;
}
