export type State = "following" | "improvising";

export function tokenize(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function lev(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Reconhecimento erra letras soltas; palavras curtas exigem igualdade exata.
export function same(a: string, b: string): boolean {
  if (a === b) return true;
  const n = Math.max(a.length, b.length);
  return a.length >= 4 && b.length >= 4 && lev(a, b) / n <= 0.25;
}

export interface AlignerOptions {
  lookahead?: number; // quantas palavras à frente procurar
  nearDistance?: number; // até aqui, 2 palavras casando bastam
}

export class Aligner {
  readonly words: string[];
  pos = 0; // índice da próxima palavra esperada do roteiro
  state: State = "following";
  private lookahead: number;
  private near: number;

  constructor(script: string, opts: AlignerOptions = {}) {
    this.words = tokenize(script);
    this.lookahead = opts.lookahead ?? 60;
    this.near = opts.nearDistance ?? 4;
  }

  jumpTo(i: number) {
    this.pos = Math.max(0, Math.min(i, this.words.length));
    this.state = "following";
  }

  // Passa um trecho já reconhecido; devolve a posição atual.
  feed(transcript: string): number {
    const h = tokenize(transcript);
    let idx = 0;
    let matched = false;
    while (idx < h.length) {
      const best = this.bestRun(h, idx);
      if (!best) break;
      this.pos = best.end;
      idx = best.i + best.len;
      matched = true;
    }
    this.state = matched ? "following" : "improvising";
    return this.pos;
  }

  // Maior sequência de palavras ouvidas (a partir de `from`) que casa com o roteiro à frente de pos.
  private bestRun(h: string[], from: number) {
    const sc = this.words;
    const stop = Math.min(sc.length, this.pos + this.lookahead);
    let best: { i: number; len: number; end: number; dist: number } | null = null;
    for (let i = from; i < h.length; i++) {
      for (let s = this.pos; s < stop; s++) {
        if (!same(h[i], sc[s])) continue;
        let j = s + 1;
        let k = 1;
        while (i + k < h.length) {
          if (j < sc.length && same(h[i + k], sc[j])) j += 1;
          else if (j + 1 < sc.length && same(h[i + k], sc[j + 1])) j += 2; // palavra pequena engolida
          else break;
          k++;
        }
        const dist = s - this.pos;
        if (k < (dist <= this.near ? 2 : 3)) continue;
        if (!best || k > best.len || (k === best.len && dist < best.dist)) best = { i, len: k, end: j, dist };
      }
    }
    return best;
  }
}
