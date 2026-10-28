"""Sidecar de voz em streaming: microfone -> Vosk (pt + en juntos) -> WebSocket local.

Eventos: {"type":"partial"|"final","lang":"pt","text":"...","t":s}, {"type":"level","v":0..1},
         {"type":"status","device":"...","langs":["pt","en"]}
Uso: python server.py [--langs pt,en] [--device N] [--port 8791] [--wav arquivo.wav] [--list-devices]
"""
import argparse, asyncio, json, os, queue, threading, time, wave
import numpy as np
import sounddevice as sd
import websockets
import vosk

vosk.SetLogLevel(-1)
SR = 16000
BLOCK = 800  # 50 ms: é o piso da latência de captura
HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = {"pt": "vosk-model-small-pt-0.3", "en": "vosk-model-small-en-us-0.15"}


def list_devices():
    api = sd.default.hostapi
    return [{"id": i, "name": d["name"]} for i, d in enumerate(sd.query_devices())
            if d["max_input_channels"] > 0 and d["hostapi"] == api]


def wav_blocks(path):
    w = wave.open(path)
    assert w.getframerate() == SR and w.getnchannels() == 1 and w.getsampwidth() == 2, "wav deve ser 16k mono 16-bit"
    while True:
        b = w.readframes(BLOCK)
        if not b:
            return
        yield b
        time.sleep(BLOCK / SR)  # simula tempo real


async def main(a):
    langs = [l for l in a.langs.split(",") if l in MODELS]
    recs = {l: vosk.KaldiRecognizer(vosk.Model(os.path.join(HERE, "models", MODELS[l])), SR) for l in langs}
    clients: set = set()
    q: queue.Queue = queue.Queue()
    loop = asyncio.get_running_loop()
    t0 = time.time()
    device = a.device if a.device is None else int(a.device)
    dev_name = "arquivo" if a.wav else sd.query_devices(device, "input")["name"]

    def send(obj):
        msg = json.dumps(obj, ensure_ascii=False)
        loop.call_soon_threadsafe(websockets.broadcast, clients, msg)
        if obj["type"] != "level":
            print(msg, flush=True)

    lq = {l: queue.Queue() for l in recs}
    MAX_LAG = 6  # blocos (300 ms): o idioma que não é o falado engasga; descarta áudio velho em vez de atrasar

    def dispatcher():
        last_level = 0.0
        while (b := q.get()) is not None:
            now = time.time() - t0
            if now - last_level > 0.1:
                s = np.frombuffer(b, dtype=np.int16).astype(np.float32) / 32768
                send({"type": "level", "v": round(min(1.0, float(np.sqrt(np.mean(s**2))) * 8), 3)})
                last_level = now
            for l in recs:
                lq[l].put(b)

    def decode(l):
        r, last = recs[l], ""
        while (b := lq[l].get()) is not None:
            if lq[l].qsize() > MAX_LAG:
                with lq[l].mutex:
                    lq[l].queue.clear()
                r.Reset()
                last = ""
                continue
            now = time.time() - t0
            if r.AcceptWaveform(b):
                txt = json.loads(r.Result()).get("text", "")
                if txt:
                    send({"type": "final", "lang": l, "text": txt, "t": round(now, 2)})
                last = ""
            else:
                txt = json.loads(r.PartialResult()).get("partial", "")
                if txt and txt != last:
                    last = txt
                    send({"type": "partial", "lang": l, "text": txt, "t": round(now, 2)})

    async def handler(ws):
        clients.add(ws)
        await ws.send(json.dumps({"type": "status", "device": dev_name, "langs": langs}))
        try:
            await ws.wait_closed()
        finally:
            clients.discard(ws)

    threading.Thread(target=dispatcher, daemon=True).start()
    for l in recs:
        threading.Thread(target=decode, args=(l,), daemon=True).start()
    async with websockets.serve(handler, "127.0.0.1", a.port):
        print(f"pronto ws://127.0.0.1:{a.port} mic={dev_name} langs={langs}", flush=True)
        if a.wav:
            await asyncio.sleep(2)  # dá tempo de um cliente conectar
            await loop.run_in_executor(None, lambda: [q.put(b) for b in wav_blocks(a.wav)])
            await asyncio.sleep(3)
            return
        with sd.RawInputStream(samplerate=SR, channels=1, dtype="int16", blocksize=BLOCK, device=device,
                               callback=lambda d, f, t, s: q.put(bytes(d))):
            await asyncio.Future()


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--langs", default="pt,en")
    p.add_argument("--device", default=None)
    p.add_argument("--port", type=int, default=8791)
    p.add_argument("--wav")
    p.add_argument("--list-devices", action="store_true")
    a = p.parse_args()
    if a.list_devices:
        print(json.dumps(list_devices(), ensure_ascii=False))
    else:
        asyncio.run(main(a))
