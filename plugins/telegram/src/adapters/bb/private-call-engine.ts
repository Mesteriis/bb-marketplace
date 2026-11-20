import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { privateCallVideo } from "../../core/contract.ts";
import type { TdObject } from "./tdjson.ts";

const worker = String.raw`
import asyncio, base64, io, json, sys, threading, time
import ntgcalls as n

max_width, max_height, frame_rate = map(int, sys.argv[1:])

def emit(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)

async def main():
    engine = n.NTgCalls()
    loop = asyncio.get_running_loop()
    peer = None
    image = None
    frame_lock = threading.Lock()
    processing = set()
    next_frame = {}
    engine.on_signaling_data(lambda _, data: loop.call_soon_threadsafe(
        emit, {'event': 'signal', 'data': base64.b64encode(data).decode('ascii')}))
    engine.on_connection_change(lambda _, info: loop.call_soon_threadsafe(
        emit, {'event': 'connection', 'state': info.state.name.lower()}))

    async def publish_frame(source, pixels, width, height, rotation):
        try:
            jpeg = await asyncio.to_thread(make_jpeg, pixels, width, height, rotation)
            if jpeg:
                emit({'event': 'frame', 'source': source, 'jpeg': base64.b64encode(jpeg).decode('ascii')})
        except (OSError, ValueError):
            pass
        finally:
            with frame_lock:
                processing.discard(source)

    def make_jpeg(pixels, width, height, rotation):
        chroma = (width + 1) // 2, (height + 1) // 2
        y_size = width * height
        uv_size = chroma[0] * chroma[1]
        if len(pixels) != y_size + 2 * uv_size:
            return None
        size = width, height
        y = image.frombytes('L', size, pixels[:y_size])
        u = image.frombytes('L', chroma, pixels[y_size:y_size + uv_size]).resize(size)
        v = image.frombytes('L', chroma, pixels[y_size + uv_size:]).resize(size)
        frame = image.merge('YCbCr', (y, u, v))
        frame.thumbnail((max_width, max_width))
        if rotation in (90, 180, 270):
            frame = frame.rotate(-rotation, expand=True)
        output = io.BytesIO()
        frame.save(output, format='JPEG', quality=82)
        if output.tell() > 360 * 1024:
            output = io.BytesIO()
            frame.save(output, format='JPEG', quality=65)
        return output.getvalue()

    def frames(_, mode, device, batch):
        if image is None or mode != n.StreamMode.PLAYBACK or device != n.StreamDevice.CAMERA or not batch:
            return
        source = 'remote'
        frame = batch[-1]
        meta = frame.frame_data
        if not (0 < meta.width <= 3840 and 0 < meta.height <= 3840 and meta.width * meta.height <= 8_294_400):
            return
        now = time.monotonic()
        with frame_lock:
            if source in processing or now < next_frame.get(source, 0):
                return
            next_frame[source] = now + 1 / frame_rate
            processing.add(source)
        loop.call_soon_threadsafe(lambda: asyncio.create_task(
            publish_frame(source, frame.data, meta.width, meta.height, int(meta.rotation))))

    engine.on_frames(frames)

    def audio(is_microphone):
        # An empty UID leaves AudioQueue on the current macOS default device.
        metadata = json.dumps({'uid': '', 'is_microphone': is_microphone})
        return n.AudioDescription(n.MediaSource.DEVICE, 48000, 1, metadata, False)

    async def capture(camera_enabled):
        camera = None
        if camera_enabled:
            if image is None:
                raise RuntimeError('missing camera runtime')
            camera = n.VideoDescription(n.MediaSource.EXTERNAL, max_width, max_height, frame_rate, '', False)
        await engine.set_stream_sources(peer, n.StreamMode.CAPTURE, n.MediaDescription(audio(True), None, camera, None))

    def decode_camera(data):
        with image.open(io.BytesIO(base64.b64decode(data, validate=True)), formats=['JPEG']) as picture:
            width, height = picture.size
            if not (0 < width <= max_width and 0 < height <= max_height and width % 2 == 0 and height % 2 == 0):
                raise ValueError('unexpected camera dimensions')
            chroma = (width // 2, height // 2)
            y, u, v = picture.convert('YCbCr').split()
            return y.tobytes() + u.resize(chroma).tobytes() + v.resize(chroma).tobytes(), width, height

    async def handle(msg):
        nonlocal peer, image
        if msg['method'] == 'prepare':
            devices = n.NTgCalls.get_media_devices()
            if not devices.microphone or not devices.speaker:
                raise RuntimeError('missing audio devices')
            peer = msg['peer']
            await engine.create_p2p_call(peer)
            p = n.NTgCalls.get_protocol()
            return {'@type': 'callProtocol', 'min_layer': p.min_layer, 'max_layer': p.max_layer,
                'udp_p2p': p.udp_p2p, 'udp_reflector': p.udp_reflector, 'library_versions': p.library_versions}
        if msg['method'] == 'connect':
            ready = msg['ready']
            remote = None
            if msg['video']:
                try:
                    from PIL import Image
                    image = Image
                    remote = n.VideoDescription(n.MediaSource.EXTERNAL, 0, 0, 30, '', False)
                except ImportError:
                    pass
            await engine.skip_exchange(peer, base64.b64decode(ready['encryption_key'], validate=True), msg['outgoing'])
            try:
                await capture(msg['camera'])
            except Exception:
                if not msg['camera']:
                    raise
                await capture(False)
                emit({'event': 'camera-unavailable'})
            # NTgCalls enables the remote audio track through the microphone slot in playback mode.
            await engine.set_stream_sources(peer, n.StreamMode.PLAYBACK, n.MediaDescription(audio(False), None, remote, None))
            servers = []
            for server in ready['servers']:
                t = server['type']
                args = (int(server['id']), server['ip_address'], server['ipv6_address'], server['port'])
                if t['@type'] == 'callServerTypeWebrtc':
                    servers.append(n.RTCServer(*args, t['username'], t['password'], t['supports_turn'], t['supports_stun'], False, None))
                elif t['@type'] == 'callServerTypeTelegramReflector':
                    servers.append(n.RTCServer(*args, None, None, False, False, t['is_tcp'], base64.b64decode(t['peer_tag'], validate=True)))
            await engine.connect_p2p(peer, servers, ready['protocol']['library_versions'], ready['allow_p2p'], ready.get('custom_parameters') or None)
        elif msg['method'] == 'signal':
            await engine.send_signaling_data(peer, base64.b64decode(msg['data'], validate=True))
        elif msg['method'] == 'mute':
            return await (engine.mute(peer) if msg['muted'] else engine.unmute(peer))
        elif msg['method'] == 'camera':
            await capture(msg['enabled'])
        elif msg['method'] == 'camera-frame':
            data, width, height = await asyncio.to_thread(decode_camera, msg['jpeg'])
            await engine.send_external_frame(peer, n.StreamDevice.CAMERA, data,
                n.FrameData(0, n.VideoRotation.VIDEO_ROTATION_0, width, height))
        return None

    try:
        while line := await asyncio.to_thread(sys.stdin.buffer.readline):
            msg = json.loads(line)
            try:
                emit({'seq': msg['seq'], 'ok': True, 'value': await handle(msg)})
            except Exception:
                emit({'seq': msg['seq'], 'ok': False})
    finally:
        if peer is not None:
            await engine.stop(peer)

asyncio.run(main())
`;

const protocol = z.object({
  "@type": z.literal("callProtocol"), min_layer: z.number().int().positive(), max_layer: z.number().int().positive(),
  udp_p2p: z.boolean(), udp_reflector: z.boolean(), library_versions: z.array(z.string().min(1).max(24)).min(1).max(32),
});

export function privateCallPython() {
  const python = process.env.MAKOSH_TELEGRAM_CALLS_PYTHON
    ?? join(homedir(), "Library", "Application Support", "Makosh", "telegram-calls", "bin", "python");
  return process.platform === "darwin" && isAbsolute(python) && existsSync(python) ? python : undefined;
}

export type PrivateCallEngine = ReturnType<typeof openPrivateCallEngine>;
export type PrivateCallEngineEvent = { data: string } | { state: string }
  | { jpeg: Buffer<ArrayBuffer> } | { cameraUnavailable: true };

export function openPrivateCallEngine(python: string, notify: (signal: PrivateCallEngineEvent) => void) {
  const { width, height, frameRate } = privateCallVideo;
  const child = spawn(python, ["-I", "-u", "-c", worker, String(width), String(height), String(frameRate)],
    { stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: child.stdout });
  let closed = false;
  let next = 0;
  const pending = new Map<number, (ok: boolean, value?: unknown) => void>();

  function stopped() {
    if (closed) return;
    closed = true;
    lines.close();
    for (const finish of pending.values()) finish(false);
    notify({ state: "failed" });
  }

  child.once("error", stopped);
  child.once("close", stopped);
  child.stdin.on("error", () => child.kill());
  lines.on("line", (line) => {
    try {
      const event = JSON.parse(line);
      if (event.event === "signal" && typeof event.data === "string" && event.data.length <= 64 * 1024) notify({ data: event.data });
      else if (event.event === "connection" && typeof event.state === "string") notify({ state: event.state });
      else if (event.event === "camera-unavailable") notify({ cameraUnavailable: true });
      else if (event.event === "frame" && event.source === "remote"
        && typeof event.jpeg === "string" && event.jpeg.length <= 512 * 1024) {
        const jpeg = Buffer.from(event.jpeg, "base64");
        if (jpeg[0] === 0xff && jpeg[1] === 0xd8) notify({ jpeg });
      }
      else pending.get(event.seq)?.(event.ok === true, event.value);
    } catch { child.kill(); }
  });

  function command(method: string, input: object = {}) {
    return new Promise<unknown>((resolve, reject) => {
      const seq = ++next;
      const timeout = setTimeout(() => {
        finish(false);
        child.kill();
      }, 15_000);
      function finish(ok: boolean, value?: unknown) {
        clearTimeout(timeout);
        pending.delete(seq);
        if (ok) resolve(value);
        else reject(new Error("Telegram call audio is unavailable."));
      }
      pending.set(seq, finish);
      if (closed) finish(false);
      else child.stdin.write(JSON.stringify({ seq, method, ...input }) + "\n");
    });
  }

  return {
    async prepare(peer: number) { return protocol.parse(await command("prepare", { peer })); },
    connect: (ready: TdObject, outgoing: boolean, video: boolean, camera: boolean) => command("connect", { ready, outgoing, video, camera }),
    signal: (data: string) => command("signal", { data }),
    mute: (muted: boolean) => command("mute", { muted }),
    camera: (enabled: boolean) => command("camera", { enabled }),
    cameraFrame: (jpeg: Buffer) => command("camera-frame", { jpeg: jpeg.toString("base64") }),
    close() {
      if (closed) return;
      closed = true;
      lines.close();
      for (const finish of pending.values()) finish(false);
      child.stdin.end();
      const force = setTimeout(() => child.kill(), 2000);
      force.unref();
      child.once("exit", () => clearTimeout(force));
    },
  };
}
