import test from "node:test";
import assert from "node:assert/strict";
import { Aligner, tokenize } from "./aligner.ts";
import { phonSim } from "./phonetic.ts";
import { cleanScript } from "./text.ts";

const script =
  "Olá pessoal, hoje eu vou falar sobre produtividade. Primeiro, organize o seu dia na véspera. " +
  "Segundo, escolha uma única tarefa importante e foque nela até terminar. Terceiro, desligue as notificações do celular. " +
  "Quarto, faça pausas curtas para descansar a mente. Quinto, revise o que você conseguiu fazer antes de dormir. " +
  "Por fim, lembre que constância vale mais do que intensidade, e que um dia ruim não apaga uma semana boa.";

// "fala" um trecho palavra por palavra como o reconhecedor faria: parciais crescendo e depois o final
function say(a: Aligner, text: string, lang = "pt") {
  const w = text.split(" ");
  for (let i = 1; i <= w.length; i++) a.feedStream(lang, w.slice(0, i).join(" "), false);
  a.feedStream(lang, text, true);
}
const next = (a: Aligner) => a.words[a.pos];
const idx = (w: string) => tokenize(script).indexOf(w);

test("tokenize tira acento e pontuação", () => {
  assert.deepEqual(tokenize("Olá, véspera!"), ["ola", "vespera"]);
});

test("fonética: sons parecidos casam, palavras diferentes não", () => {
  assert.ok(phonSim("casa", "caça") > 0.9);
  assert.ok(phonSim("fazer", "fazê") > 0.9);
  assert.ok(phonSim("organize", "organise") > 0.9);
  assert.ok(phonSim("para", "pra") > 0.75);
  assert.ok(phonSim("casa", "mesa") < 0.55);
  assert.ok(phonSim("de", "da") === 0);
});

test("limpeza do texto: markdown, links, emojis e símbolos saem", () => {
  const sujo = "# Título\n- item **forte** e _leve_ 🚀 veja [o site](https://x.com/a) agora — 100% & mais @fulano #tag";
  assert.equal(cleanScript(sujo), "Título\nitem forte e leve veja o site agora 100 mais fulano tag");
});

test("avança lendo o roteiro, palavra por palavra", () => {
  const a = new Aligner(script);
  a.feedStream("pt", "olá", false);
  say(a, "olá pessoal hoje eu vou falar sobre produtividade");
  assert.equal(next(a), "primeiro");
  say(a, "primeiro organize o seu dia");
  assert.equal(next(a), "na");
  assert.equal(a.state, "following");
});

test("palavras entendidas com som parecido continuam valendo", () => {
  const a = new Aligner(script);
  say(a, "ola pessoal oje eu vou falá sobre produtividadi");
  assert.equal(next(a), "primeiro");
  say(a, "primeiro organise o seu dia na vespera");
  assert.equal(next(a), "segundo");
});

test("palavra totalmente errada no meio não trava", () => {
  const a = new Aligner(script);
  say(a, "olá pessoal hoje eu vou falar sobre produtividade primeiro");
  say(a, "bloco o seu dia na véspera"); // "organize" virou lixo
  assert.equal(next(a), "segundo");
  say(a, "segundo escolha uma única tarefa importante e foque");
  assert.equal(next(a), "nela");
});

test("palavra que o reconhecedor não pegou é pulada sem travar", () => {
  const a = new Aligner(script);
  say(a, "olá pessoal hoje vou falar sobre produtividade"); // faltou "eu"
  assert.equal(next(a), "primeiro");
});

test("improviso longo não faz a posição andar e a leitura retoma no ponto certo", () => {
  const a = new Aligner(script);
  say(a, "olá pessoal hoje eu vou falar sobre produtividade primeiro organize o seu dia");
  const parou = a.pos;
  say(a, "aliás deixa eu contar uma história rápida que aconteceu ontem comigo quando eu estava no trabalho e esqueci tudo no carro que loucura foi aquilo e depois ainda choveu bastante na volta pra casa");
  assert.ok(a.pos - parou <= 1, `andou ${a.pos - parou} palavras no improviso`);
  assert.equal(a.state, "improvising");
  say(a, "na véspera segundo escolha uma única tarefa");
  assert.equal(next(a), "importante");
  assert.equal(a.state, "following");
});

test("pulo de verdade: pula quando a pessoa fala outra parte", () => {
  const a = new Aligner(script);
  say(a, "olá pessoal hoje eu vou falar sobre produtividade");
  say(a, "quarto faça pausas curtas para descansar");
  assert.equal(next(a), "a"); // "a mente": próxima depois de "descansar"
  assert.ok(a.pos > idx("quarto"));
});

test("pulo falso: duas palavras soltas parecidas com outra parte não pulam", () => {
  const a = new Aligner(script);
  say(a, "olá pessoal hoje eu vou falar sobre produtividade primeiro organize");
  const antes = a.pos;
  say(a, "eu preciso de uma pausa e de constância pra isso"); // improviso com palavras que existem lá na frente
  assert.equal(a.pos, antes);
});

test("pulo falso: uma palavra rara repetida não basta", () => {
  const a = new Aligner(script);
  say(a, "olá pessoal hoje eu vou falar sobre produtividade");
  const antes = a.pos;
  say(a, "notificações");
  assert.equal(a.pos, antes);
});

test("voltar atrás: reler uma parte anterior volta a posição", () => {
  const a = new Aligner(script);
  say(a, "olá pessoal hoje eu vou falar sobre produtividade primeiro organize o seu dia na véspera segundo escolha uma única tarefa importante e foque nela até terminar");
  const longe = a.pos;
  say(a, "primeiro organize o seu dia na véspera");
  assert.ok(a.pos < longe - 5);
  assert.equal(next(a), "segundo");
});

test("números escritos em dígitos não travam", () => {
  const a = new Aligner("Hoje são 3 passos simples para melhorar. Primeiro, comece cedo.");
  say(a, "hoje são três passos simples para melhorar");
  assert.equal(next(a), "primeiro");
  const b = new Aligner("Hoje são 3 passos simples para melhorar. Primeiro, comece cedo.");
  say(b, "hoje são passos simples para melhorar"); // número não falado
  assert.equal(next(b), "primeiro");
});

test("símbolos no roteiro não entram na contagem", () => {
  const a = new Aligner(cleanScript("## Abertura\n- Olá 🚀 pessoal — bem-vindo ao canal! #video"));
  assert.deepEqual(a.words, ["abertura", "ola", "pessoal", "bem", "vindo", "ao", "canal", "video"]);
});

test("dois idiomas ouvindo: o lixo do idioma errado não atrapalha", () => {
  const a = new Aligner(script);
  for (let i = 1; i <= 8; i++) {
    a.feedStream("en", "hello pass well who may i go foul".split(" ").slice(0, i).join(" "), false);
    a.feedStream("pt", "olá pessoal hoje eu vou falar sobre produtividade".split(" ").slice(0, i).join(" "), false);
  }
  a.feedStream("en", "hello pass well who may i go foul", true);
  a.feedStream("pt", "olá pessoal hoje eu vou falar sobre produtividade", true);
  assert.equal(next(a), "primeiro");
  say(a, "primeiro organize o seu dia");
  assert.equal(next(a), "na");
});

test("unk do modo guiado é ignorado", () => {
  const a = new Aligner(script);
  say(a, "olá pessoal [unk] eu vou falar sobre produtividade");
  assert.equal(next(a), "primeiro");
});
