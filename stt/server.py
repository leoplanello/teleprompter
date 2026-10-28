"""Sidecar de voz: microfone -> corte por pausa -> faster-whisper -> WebSocket local.

Evento enviado: {"text": str, "final": true, "t": segundos, "ms": tempo de transcrição}
Uso: python server.py [--model small] [--lang pt] [--port 8791]
"""
import argparse, asyncio, json, queue, time
import numpy as np
import sounddevice as sd
import websockets
from faster_whisper import WhisperModel

SR = 16000
BLOCK = 0.1  # s por bloco do microfone
# shortcut: corte por energia (RMS), não por silero; trocar se ruído de fundo atrapalhar.
RMS_VOICE = 0.012
PAUSE = 0.45  # s de silêncio que fecha um segmento
MAX_SEG = 6.0  # s, fecha mesmo sem pausa


async def main(a):
    model = WhisperModel(a.model, device="cpu", compute_type="int8")
    clients: set = set()
    audio: queue.Queue = queue.Queue()
    loop = asyncio.get_running_loop()
    t0 = time.time()

    def cb(indata, frames, ti, status):
        audio.put(indata[:, 0].copy())

    def transcribe(buf: np.ndarray) -> str:
        segs, _ = model.transcribe(
            buf, language=a.lang, beam_size=1, vad_filter=True,
            condition_on_previous_text=False,
        )
        return " ".join(s.text.strip() for s in segs).strip()

    async def handler(ws):
        clients.add(ws)
        try:
            await ws.wait_closed()
        finally:
            clients.discard(ws)

    async def pump():
        buf, quiet, voiced = [], 0.0, False
        while True:
            try:
                blk = audio.get_nowait()
            except queue.Empty:
                await asyncio.sleep(0.02)
                continue
            loud = float(np.sqrt(np.mean(blk**2))) > RMS_VOICE
            if loud:
                voiced, quiet = True, 0.0
            elif voiced:
                quiet += BLOCK
            if voiced:
                buf.append(blk)
            size = len(buf) * BLOCK
            if voiced and (quiet >= PAUSE or size >= MAX_SEG):
                chunk, buf, quiet, voiced = np.concatenate(buf), [], 0.0, False
                t = time.time()
                text = await loop.run_in_executor(None, transcribe, chunk)
                if text:
                    msg = json.dumps({"text": text, "final": True, "t": round(t - t0, 2),
                                      "ms": int((time.time() - t) * 1000)})
                    websockets.broadcast(clients, msg)
                    print(msg, flush=True)

    with sd.InputStream(samplerate=SR, channels=1, dtype="float32",
                        blocksize=int(SR * BLOCK), callback=cb):
        async with websockets.serve(handler, "127.0.0.1", a.port):
            print(f"pronto ws://127.0.0.1:{a.port}", flush=True)
            await pump()


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--model", default="small")
    p.add_argument("--lang", default="pt")
    p.add_argument("--port", type=int, default=8791)
    asyncio.run(main(p.parse_args()))
