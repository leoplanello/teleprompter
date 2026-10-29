// Semelhança de som entre duas palavras (português do Brasil, com folga para inglês).
// Serve para casar o que o reconhecedor entendeu com o que está no roteiro mesmo quando a letra muda.

const strip = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

// Chave fonética aproximada: letras diferentes que soam igual viram o mesmo símbolo.
export function phon(word: string): string {
  let w = word
    .toLowerCase()
    .replace(/ão/g, "aum").replace(/õe/g, "oin").replace(/ãe/g, "ain")
    .replace(/ã/g, "an").replace(/õ/g, "on").replace(/ç/g, "s");
  w = strip(w);
  if (w.length >= 4) w = w.replace(/([aeiou])r$/, "$1"); // infinitivo: "fazer" soa "fazê"
  w = w
    .replace(/sch|ch|sh/g, "x").replace(/lh/g, "L").replace(/nh/g, "N")
    .replace(/ph/g, "f").replace(/th/g, "t").replace(/ck/g, "k")
    .replace(/^r|rr/g, "R").replace(/ss/g, "s")
    .replace(/s[cç](?=[ei])|xc(?=[ei])/g, "s")
    .replace(/qu(?=[ei])/g, "k").replace(/qu/g, "kw").replace(/gu(?=[ei])/g, "g")
    .replace(/c(?=[ei])/g, "s").replace(/c/g, "k").replace(/q/g, "k")
    .replace(/g(?=[ei])/g, "j")
    .replace(/h/g, "").replace(/z/g, "s").replace(/y/g, "i").replace(/w/g, "u")
    .replace(/[mn](?![aeiou])/g, "~")     // nasalização: "bem", "bom", "tampa"
    .replace(/l(?![aeiou])/g, "u")        // l vocalizado: "Brasil" ~ "Brasiu"
    .replace(/e(s?)$/g, "i$1").replace(/o(s?)$/g, "u$1") // pronúncia final do pt-BR
    .replace(/(.)\1+/g, "$1");
  return w;
}

const VOWELS = "aeiou";
const isV = (c: string) => VOWELS.includes(c);
const NEAR_VOWEL: Record<string, number> = { ei: 0.3, ou: 0.3, ae: 0.6, ao: 0.6 };
// pares de consoantes que o reconhecedor costuma trocar (surda/sonora, nasais)
const CLOSE_CONS = new Set(["bp", "dt", "gk", "fv", "jx", "mn", "n~", "m~", "Rr", "sx", "lu"]);

function sub(a: string, b: string): number {
  if (a === b) return 0;
  const k = [a, b].sort().join("");
  if (k in NEAR_VOWEL) return NEAR_VOWEL[k];
  if (CLOSE_CONS.has(k)) return 0.4;
  if (isV(a) && isV(b)) return 0.7;
  return 1;
}
const indel = (c: string) => (isV(c) ? 0.6 : c === "~" ? 0.5 : 1);
const weight = (s: string) => [...s].reduce((t, c) => t + indel(c), 0);

function wdist(a: string, b: string): number {
  let prev = [0];
  for (let j = 0; j < b.length; j++) prev.push(prev[j] + indel(b[j]));
  for (let i = 0; i < a.length; i++) {
    const cur = [prev[0] + indel(a[i])];
    for (let j = 0; j < b.length; j++) {
      cur.push(Math.min(prev[j + 1] + indel(a[i]), cur[j] + indel(b[j]), prev[j] + sub(a[i], b[j])));
    }
    prev = cur;
  }
  return prev[b.length];
}

const cache = new Map<string, number>();

// 0 a 1. Palavras curtas só valem se soarem exatamente iguais.
export function phonSim(a: string, b: string): number {
  if (a === b) return 1;
  const ck = a < b ? a + "|" + b : b + "|" + a;
  const hit = cache.get(ck);
  if (hit !== undefined) return hit;
  const pa = phon(a), pb = phon(b);
  let s: number;
  if (pa === pb) s = 0.97;
  else if (Math.max(pa.length, pb.length) <= 2) s = 0;
  else {
    const sp = 1 - wdist(pa, pb) / Math.max(weight(pa), weight(pb));
    const sa = strip(a), sb = strip(b);
    const so = Math.max(sa.length, sb.length) <= 2 ? 0 : 1 - wdist(sa, sb) / Math.max(weight(sa), weight(sb));
    s = Math.max(sp, so * 0.95);
  }
  if (cache.size > 200_000) cache.clear();
  cache.set(ck, s);
  return s;
}
