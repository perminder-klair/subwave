// One Hotline Call from the browser (docs/plans/hotline.md, "Clients").
//
// The controller admits the Call and mints a short-lived provider secret with
// the DJ's prompt, voice and tools baked in. The browser then talks to the
// provider directly over WebRTC: the station's key never reaches it, and the
// audio never passes through the controller. Every tool call the model makes
// arrives here on the data channel and is relayed to
// `POST /hotline/calls/:id/tool`, which runs it under the normal request rules
// and answers with the output the model reads.
//
// The controller cuts the Call at its cap whatever the browser does; the
// timers here only make the goodbye graceful (the wrap-up cue) and hang up
// on time.
import { getStationAuthToken } from './stationAuth';

export type HotlineCallPhase = 'connecting' | 'live' | 'ended' | 'error';

export interface HotlineCallHandle {
  hangUp: () => void;
}

export interface HotlineCallOpts {
  apiBase: string;
  name: string;
  onPhase: (phase: HotlineCallPhase, detail?: string) => void;
  /** The DJ's name and the Call's cap, once the controller has admitted it. */
  onConnected?: (info: { dj: string | null; capSec: number }) => void;
}

interface StartReply {
  success: boolean;
  message?: string;
  reason?: string;
  callId: string;
  callToken: string;
  clientSecret: string;
  sdpUrl: string;
  model: string;
  capSec: number;
  wrapUpAtSec: number;
  wrapUpCue: string;
  dj: string | null;
}

const DEVICE_KEY = 'subwave:hotline-device';

/** This browser's own random id for the Hotline's per-device limits. It can be
 *  cleared, and the controller pairs it with the address, so it is a courtesy
 *  key, not an identity. */
export function hotlineDeviceId(): string {
  try {
    const kept = localStorage.getItem(DEVICE_KEY);
    if (kept && /^[A-Za-z0-9_-]{8,64}$/.test(kept)) return kept;
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const id = 'w' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    // No storage (private mode): a fresh id per Call, which only ever makes
    // the per-device limit stricter for nobody but this browser.
    return 'w' + Math.random().toString(36).slice(2, 18).padEnd(16, '0');
  }
}

function authHeaders(): Record<string, string> {
  const token = getStationAuthToken();
  return token ? { 'x-station-auth': token } : {};
}

/** The DJ's voice through a telephone band: a high-pass and a low-pass with a
 *  little presence, so a voice that is not the on-air one still reads as the DJ
 *  on the phone. Chromium plays nothing from a remote WebRTC stream routed only
 *  into Web Audio, so a muted element holds the stream alive alongside it. */
function playThroughPhoneLine(stream: MediaStream): () => void {
  const holder = new Audio();
  holder.muted = true;
  holder.srcObject = stream;
  void holder.play().catch(() => {});
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  const source = ctx.createMediaStreamSource(stream);
  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 280;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 3600;
  const presence = ctx.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = 1800;
  presence.gain.value = 4;
  source.connect(highpass).connect(lowpass).connect(presence).connect(ctx.destination);
  void ctx.resume().catch(() => {});
  return () => {
    try { source.disconnect(); } catch { /* already gone */ }
    void ctx.close().catch(() => {});
    holder.srcObject = null;
  };
}

export async function startHotlineCall(opts: HotlineCallOpts): Promise<HotlineCallHandle> {
  const { apiBase, onPhase } = opts;
  let ended = false;
  let call: StartReply | null = null;
  let pc: RTCPeerConnection | null = null;
  let mic: MediaStream | null = null;
  let stopAudio: (() => void) | null = null;
  const timers: ReturnType<typeof setTimeout>[] = [];

  const teardown = () => {
    for (const t of timers) clearTimeout(t);
    try { pc?.close(); } catch { /* closed */ }
    mic?.getTracks().forEach(t => t.stop());
    stopAudio?.();
  };

  const hangUp = (detail?: string) => {
    if (ended) return;
    ended = true;
    teardown();
    if (call) {
      void fetch(`${apiBase}/hotline/calls/${encodeURIComponent(call.callId)}/end`, {
        method: 'POST',
        headers: { 'x-hotline-token': call.callToken },
        keepalive: true,
      }).catch(() => {});
    }
    onPhase('ended', detail);
  };

  const fail = (message: string) => {
    if (ended) return;
    ended = true;
    teardown();
    if (call) {
      void fetch(`${apiBase}/hotline/calls/${encodeURIComponent(call.callId)}/end`, {
        method: 'POST', headers: { 'x-hotline-token': call.callToken }, keepalive: true,
      }).catch(() => {});
    }
    onPhase('error', message);
  };

  onPhase('connecting');

  // The microphone first: a refused permission should never spend the
  // listener's one Call for this show.
  try {
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    fail('The Hotline needs your microphone. Allow it and try again.');
    return { hangUp: () => hangUp() };
  }

  try {
    const res = await fetch(`${apiBase}/hotline/calls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ deviceId: hotlineDeviceId(), name: opts.name }),
    });
    const body = await res.json().catch(() => null) as StartReply | null;
    if (!res.ok || !body?.success) {
      fail(body?.message || "The DJ can't pick up right now — try again in a bit.");
      return { hangUp: () => hangUp() };
    }
    call = body;
  } catch {
    fail("Couldn't reach the station — check your connection.");
    return { hangUp: () => hangUp() };
  }
  if (ended) return { hangUp: () => hangUp() };
  opts.onConnected?.({ dj: call.dj, capSec: call.capSec });

  const active = call;
  pc = new RTCPeerConnection();
  for (const track of mic.getTracks()) pc.addTrack(track, mic);
  pc.ontrack = (e) => {
    if (!stopAudio && e.streams[0]) stopAudio = playThroughPhoneLine(e.streams[0]);
  };
  pc.onconnectionstatechange = () => {
    if (pc && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) {
      hangUp('The line dropped.');
    }
  };

  const dc = pc.createDataChannel('oai-events');
  const send = (event: Record<string, unknown>) => {
    if (dc.readyState === 'open') dc.send(JSON.stringify(event));
  };

  const relayTool = async (callId: string, name: string, args: string) => {
    let output: Record<string, unknown> = { error: 'the station did not answer' };
    try {
      const r = await fetch(`${apiBase}/hotline/calls/${encodeURIComponent(active.callId)}/tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-hotline-token': active.callToken },
        body: JSON.stringify({ name, arguments: args }),
      });
      const body = await r.json().catch(() => null) as { output?: Record<string, unknown>; ended?: boolean } | null;
      if (r.status === 410 || body?.ended) {
        // The controller has ended the Call (its cap, the operator): let any
        // goodbye in flight finish, then hang up.
        timers.push(setTimeout(() => hangUp(), 1500));
        return;
      }
      if (body?.output) output = body.output;
    } catch { /* answer with the error above so the DJ can carry on */ }
    if (ended) return;
    send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) } });
    if (output.ended === true) {
      // end_call: the DJ has said goodbye. Leave a beat for the last words.
      timers.push(setTimeout(() => hangUp(), 2500));
      return;
    }
    send({ type: 'response.create' });
  };

  dc.onopen = () => {
    onPhase('live');
    // The DJ picks up and speaks first, like answering a phone.
    send({ type: 'response.create' });
  };
  dc.onmessage = (e) => {
    let event: { type?: string; call_id?: string; name?: string; arguments?: string } | null = null;
    try { event = JSON.parse(String(e.data)); } catch { return; }
    if (event?.type === 'response.function_call_arguments.done' && event.call_id && event.name) {
      void relayTool(event.call_id, event.name, event.arguments || '{}');
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdpRes = await fetch(active.sdpUrl, {
      method: 'POST',
      body: offer.sdp,
      headers: { Authorization: `Bearer ${active.clientSecret}`, 'Content-Type': 'application/sdp' },
    });
    if (!sdpRes.ok) throw new Error(`provider answered ${sdpRes.status}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: await sdpRes.text() });
  } catch {
    fail("The DJ can't pick up right now — try again in a bit.");
    return { hangUp: () => hangUp() };
  }

  // The goodbye, then the cut. The controller's own cap stands behind these.
  timers.push(setTimeout(() => {
    send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: active.wrapUpCue }] },
    });
    send({ type: 'response.create' });
  }, active.wrapUpAtSec * 1000));
  timers.push(setTimeout(() => hangUp("Time's up — thanks for calling."), active.capSec * 1000));

  return { hangUp: () => hangUp() };
}
