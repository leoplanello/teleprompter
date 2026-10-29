import { phonSim } from "./phonetic.ts";

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

const NUM_WORDS = new Set(
  ("zero um uma dois duas tres quatro cinco seis sete oito nove dez onze doze treze quatorze quinze dezesseis dezessete dezoito dezenove vinte trinta quarenta cinquenta sessenta setenta oitenta noventa cem cento duzentos trezentos quinhentos mil milhao milhoes " +
    "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million").split(" "),
);

// ---- modelo ----
// Estado j = "j palavras do roteiro já foram lidas" (a próxima esperada é words[j]).
// A cada palavra ouvida a crença sobre j é atualizada: ler a próxima, pular poucas, ouvir algo fora do
// roteiro (improviso ou erro) ou, com probabilidade bem pequena, saltar para qualquer ponto do texto.
const P_STAY = 0.2; // palavra ouvida que não faz parte do roteiro
const P_ADV = 0.62; // lê a próxima palavra
const SKIP = 0.3; // custo de cada palavra do roteiro pulada (reconhecedor perdeu ou a pessoa cortou)
const MAX_SKIP = 4;
const EPS_JUMP = 0.001; // chance de pulo para longe; só vence com várias palavras seguidas confirmando
const P_MATCH = 0.75; // chance de a palavra falada ser reconhecida como algo que soa igual

export interface AlignerOptions {
  jump?: number;
}

type Em = { e: Float32Array; bg: number; cnt: number };

export class Aligner {
  readonly words: string[];
  pos = 0; // índice da próxima palavra esperada do roteiro
  state: State = "following";
  private n: number;
  private isNum: boolean[];
  private rows = new Map<string, Em>();
  private jump: number;
  private g: Float64Array; // crença confirmada (até o último trecho final)
  private toks: Record<string, string[]> = {};
  private committed: Record<string, string[]> = {};
  private suppressed: Record<string, number> = {}; // idioma -> quando foi calado (o outro venceu aquele trecho)

  constructor(script: string, opts: AlignerOptions = {}) {
    this.words = tokenize(script);
    this.n = this.words.length;
    this.isNum = this.words.map((w) => /^\d+$/.test(w));
    this.jump = opts.jump ?? EPS_JUMP;
    this.g = new Float64Array(this.n + 1);
    this.g[0] = 1;
  }

  jumpTo(i: number) {
    this.pos = Math.max(0, Math.min(i, this.n));
    this.g.fill(0);
    this.g[this.pos] = 1;
    this.toks = {};
    this.state = "following";
  }

  // Um trecho já reconhecido por inteiro.
  feed(transcript: string): number {
    return this.feedStream("_", transcript, true);
  }

  // Hipótese de um idioma; `final` fecha o trecho. Parciais são reavaliadas a partir da crença confirmada,
  // então palavra revisada pelo reconhecedor não deixa rastro.
  feedStream(lang: string, transcript: string, final = false): number {
    const now = Date.now();
    if (this.suppressed[lang] !== undefined) {
      if (now - this.suppressed[lang] > 2500) delete this.suppressed[lang];
      else {
        if (final) {
          // sobra no fim do trecho que o outro idioma não chegou a ouvir
          const t = this.tokens(transcript), c = this.committed[lang] ?? [];
          if (t.length > c.length && c.every((w, i) => w === t[i])) this.g = this.apply(this.g, t.slice(c.length)).b;
          delete this.suppressed[lang];
          this.pos = this.pick(this.g, t, false);
        }
        return this.pos;
      }
    }
    this.toks[lang] = this.tokens(transcript);

    let best: { lang: string; b: Float64Array; z: number; t: string[] } | null = null;
    for (const [l, t] of Object.entries(this.toks)) {
      if (!t.length || this.suppressed[l] !== undefined) continue;
      const r = this.apply(this.g, t);
      if (!best || r.z > best.z) best = { lang: l, b: r.b, z: r.z, t };
    }
    if (!best) {
      if (final) delete this.toks[lang];
      return this.pos;
    }
    const expl = this.explainedWeight(best.t, this.argmax(best.b));
    const improv = best.t.length < 4 ? this.state === "improvising" && expl < 1.2 : expl < 1.2;
    this.pos = this.pick(best.b, best.t, improv);
    this.state = improv ? "improvising" : "following";

    if (final) {
      if (best.lang === lang) {
        // este idioma venceu: confirma, e o outro, se estiver no meio do mesmo trecho, não conta de novo
        this.g = best.b;
        for (const l of Object.keys(this.toks)) {
          if (l !== lang && this.toks[l].length) {
            this.suppressed[l] = now;
            this.committed[l] = this.toks[l];
          }
        }
        this.toks = {};
      } else {
        // o idioma errado terminou primeiro: descarta o dele e deixa o vencedor continuar ao vivo
        delete this.toks[lang];
      }
    }
    return this.pos;
  }

  private tokens(text: string): string[] {
    return tokenize(text.replaceAll("[unk]", " "));
  }

  private argmax(b: Float64Array): number {
    let j = 0;
    for (let i = 1; i <= this.n; i++) if (b[i] > b[j]) j = i;
    return j;
  }

  // Quanto vale uma palavra como prova de posição: palavra curta e comum aparece por acaso o tempo todo.
  private weight(h: string, cnt: number): number {
    const w = h.length >= 7 ? 2 : h.length >= 5 ? 1.5 : h.length === 4 ? 1 : 0.4;
    return cnt >= 2 ? w * 0.6 : w;
  }

  // Prova de que a pessoa está em `j`: as últimas palavras ouvidas casam, em sequência, com as que
  // vêm logo antes de j (tolera uma palavra pulada no roteiro e até duas ouvidas fora do roteiro).
  private support(t: string[], j: number): number {
    let s = 0, jj = j - 1, junk = 0, skips = 1, used = 0;
    for (let i = t.length - 1; i >= 0 && jj >= 0 && used < 5; i--, used++) {
      const h = t[i], { cnt } = this.em(h);
      if (!this.isNum[jj] && phonSim(h, this.words[jj]) >= 0.8) { s += this.weight(h, cnt); jj--; }
      else if (skips && jj > 0 && !this.isNum[jj - 1] && phonSim(h, this.words[jj - 1]) >= 0.8) { s += this.weight(h, cnt); jj -= 2; skips--; }
      else if (++junk > 2) break;
    }
    return s;
  }

  // Decide se a posição mostrada muda. Ficar perto pede pouca prova; pular longe (para frente ou para
  // trás) pede várias palavras seguidas, e durante o improviso a régua sobe. Voltar uma ou duas
  // palavras é só o reconhecedor revisando e é ignorado.
  private pick(b: Float64Array, t: string[], improv: boolean): number {
    const j = this.argmax(b);
    const conf = b[j], d = j - this.pos;
    if (d === 0) return this.pos;
    const sup = this.support(t, j);
    if (d > 0) {
      if (d <= 2) return sup >= (improv ? 1.5 : 0.4) ? j : this.pos;
      if (d <= 8) return conf >= 0.3 && sup >= 1.5 ? j : this.pos;
      return conf >= 0.6 && sup >= 3 ? j : this.pos;
    }
    return -d > 3 && conf >= 0.65 && sup >= 3 ? j : this.pos;
  }

  // Soma do valor das últimas palavras que casam com o roteiro perto da posição; pouco => improvisando.
  private explainedWeight(t: string[], at: number): number {
    const lo = Math.max(0, at - 10), hi = Math.min(this.n, at + 3);
    let s = 0;
    for (const h of t.slice(-6)) {
      const { e, bg, cnt } = this.em(h);
      for (let j = lo; j < hi; j++) if (e[j] > bg * 8) { s += this.weight(h, cnt); break; }
    }
    return s;
  }

  private apply(b0: Float64Array, toks: string[]) {
    // z = quanto essas palavras são melhor explicadas pelo roteiro do que por "improviso" (ganho sobre ficar parado)
    let b = b0, z = 0;
    for (const h of toks) {
      const r = this.step(b, h);
      b = r.b; z += r.logZ - Math.log(P_STAY * this.em(h).bg);
    }
    return { b, z };
  }

  // Probabilidade de ouvir `h` quando a palavra j é falada, e de ouvi-la por acaso (bg).
  private em(h: string): Em {
    let r = this.rows.get(h);
    if (r) return r;
    const base = h.length <= 2 ? 0.06 : h.length === 3 ? 0.03 : h.length === 4 ? 0.015 : h.length <= 6 ? 0.008 : 0.004;
    const sims = new Float32Array(this.n);
    let cnt = 0;
    const hnum = NUM_WORDS.has(h);
    for (let j = 0; j < this.n; j++) {
      const s = this.isNum[j] ? (hnum ? 1 : 0) : phonSim(h, this.words[j]);
      sims[j] = s;
      if (s >= 0.8) cnt++;
    }
    const bg = base * Math.sqrt(Math.max(1, cnt));
    const floor = 0.01 * bg;
    const e = new Float32Array(this.n);
    for (let j = 0; j < this.n; j++) {
      const g = Math.min(1, Math.max(0, (sims[j] - 0.55) / 0.35));
      e[j] = floor + (this.isNum[j] ? 0.4 * g : (P_MATCH - floor) * Math.pow(g, 1.5));
    }
    if (this.rows.size > 3000) this.rows.clear();
    this.rows.set(h, (r = { e, bg, cnt }));
    return r;
  }

  private step(b: Float64Array, h: string) {
    const { e, bg } = this.em(h);
    const n = this.n, out = new Float64Array(n + 1);
    for (let j = 0; j <= n; j++) {
      const bj = b[j];
      if (bj < 1e-300) continue;
      out[j] += bj * P_STAY * bg;
      let f = P_ADV;
      for (let k = 0; k <= MAX_SKIP && j + 1 + k <= n; k++) {
        out[j + 1 + k] += bj * f * e[j + k];
        f *= this.isNum[j + k] ? 0.9 : SKIP;
      }
    }
    const jm = this.jump / Math.max(1, n); // soma de b = 1
    for (let j = 1; j <= n; j++) out[j] += jm * e[j - 1];
    let tot = 0;
    for (let j = 0; j <= n; j++) tot += out[j];
    if (tot <= 0) return { b, logZ: -50 };
    for (let j = 0; j <= n; j++) out[j] /= tot;
    return { b: out, logZ: Math.log(tot) };
  }
}
