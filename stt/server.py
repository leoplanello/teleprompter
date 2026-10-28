"""Sidecar de voz em streaming: microfone -> Vosk (pt + en juntos) -> WebSocket local.

Eventos: {"type":"partial"|"final","lang":"pt","text":"...","t":s}, {"type":"level","v":0..1},
         {"type":"status","device":"...","langs":["pt","en"]}
Comando do cliente: {"cmd":"grammar","words":[...]}  -> reconhece só essas palavras (+ [unk]); lista vazia = livre
Uso: python server.py [--langs pt,en] [--device N] [--port 8791] [--wav arquivo.wav] [--list-devices]
"""
import argparse, asyncio, ctypes, json, os, queue, threading, time, wave
import numpy as np
import sounddevice as sd
import websockets
import vosk

vosk.SetLogLevel(-1)
SR = 16000
BLOCK = 480  # 30 ms = um quadro do Vosk: menor que isso não ganha nada
HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = {"pt": "vosk-model-small-pt-0.3", "en": "vosk-model-small-en-us-0.15"}
# palavras faladas que o roteiro escreve em dígitos
NUMS = {
    "pt": "zero um uma dois duas três quatro cinco seis sete oito nove dez onze doze treze quatorze quinze dezesseis dezessete dezoito dezenove vinte trinta quarenta cinquenta sessenta setenta oitenta noventa cem cento duzentos trezentos quinhentos mil milhão milhões por cento".split(),
    "en": "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million percent".split(),
}


def boost(thread_only=False):
    # com a CPU cheia, o motor de voz precisa passar na frente de navegador e afins
    k = ctypes.windll.kernel32
    if thread_only:
        k.SetThreadPriority(k.GetCurrentThread(), 2)  # HIGHEST
    else:
        k.SetPriorityClass(k.GetCurrentProcess(), 0x80)  # HIGH_PRIORITY_CLASS


def list_devices():
    api = sd.default.hostapi
    return [{"id": i, "name": d["name"]} for i, d in enumerate(sd.query_devices())
            if d["max_input_channels"] > 0 and d["hostapi"] == api]


def wav_blocks(path):
    w = wave.open(path)
    assert w.getframerate() == SR and w.getnchannels() == 1 and w.getsampwidth() == 2, "wav deve ser 16k mono 16-bit"
    while b := w.readframes(BLOCK):
        yield b
        time.sleep(BLOCK / SR)  # simula tempo real


def make_rec(model, lang, words):
    if not words:
        return vosk.KaldiRecognizer(model, SR)
    vocab = sorted(set(words) | set(NUMS[lang]))
    return vosk.KaldiRecognizer(model, SR, json.dumps(vocab + ["[unk]"], ensure_ascii=False))


async def main(a):
    boost()
    langs = [l for l in a.langs.split(",") if l in MODELS]
    loop = asyncio.get_running_loop()
    # carrega os modelos em paralelo: o Kaldi solta o GIL
    models = dict(zip(langs, await asyncio.gather(*[
        loop.run_in_executor(None, vosk.Model, os.path.join(HERE, "models", MODELS[l])) for l in langs])))
    clients: set = set()
    q: queue.Queue = queue.Queue()
    t0 = time.time()
    device = a.device if a.device is None else int(a.device)
    dev_name = "arquivo" if a.wav else sd.query_devices(device, "input")["name"]

    def send(obj):
        msg = json.dumps(obj, ensure_ascii=False)
        loop.call_soon_threadsafe(websockets.broadcast, clients, msg)
        if obj["type"] != "level":
            print(msg, flush=True)

    lq = {l: queue.Queue() for l in langs}
    MAX_LAG = 8  # blocos (240 ms): se atrasar, descarta áudio velho em vez de acumular fila

    def dispatcher():
        boost(True)
        last_level = 0.0
        while (b := q.get()) is not None:
            now = time.time() - t0
            if now - last_level > 0.1:
                s = np.frombuffer(b, dtype=np.int16).astype(np.float32) / 32768
                send({"type": "level", "v": round(min(1.0, float(np.sqrt(np.mean(s**2))) * 8), 3)})
                last_level = now
            for l in langs:
                lq[l].put(b)

    def decode(l):
        boost(True)
        r, last = make_rec(models[l], l, []), ""
        while True:
            b = lq[l].get()
            if lq[l].qsize() > MAX_LAG:
                cmd = b if isinstance(b, tuple) else None
                with lq[l].mutex:
                    for item in lq[l].queue:
                        if isinstance(item, tuple):
                            cmd = item
                    lq[l].queue.clear()
                if cmd is None:
                    r.Reset()
                    last = ""
                    continue
                b = cmd
            if isinstance(b, tuple):  # ("grammar", palavras)
                r, last = make_rec(models[l], l, b[1]), ""
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
            async for raw in ws:
                m = json.loads(raw)
                if m.get("cmd") == "grammar":
                    for l in langs:
                        lq[l].put(("grammar", [w for w in m.get("words", []) if isinstance(w, str)]))
        finally:
            clients.discard(ws)

    threading.Thread(target=dispatcher, daemon=True).start()
    for l in langs:
        threading.Thread(target=decode, args=(l,), daemon=True).start()
    async with websockets.serve(handler, "127.0.0.1", a.port):
        print(f"pronto ws://127.0.0.1:{a.port} mic={dev_name} langs={langs}", flush=True)
        if a.wav:
            await asyncio.sleep(2)  # dá tempo de um cliente conectar
            print(f"feed_start {time.time() - t0:.2f}", flush=True)
            await loop.run_in_executor(None, lambda: [q.put(b) for b in wav_blocks(a.wav)])
            print(f"feed_end {time.time() - t0:.2f}", flush=True)
            await asyncio.sleep(3)
            return
        with sd.RawInputStream(samplerate=SR, channels=1, dtype="int16", blocksize=BLOCK, device=device,
                               latency="low", callback=lambda d, f, t, s: q.put(bytes(d))):
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
