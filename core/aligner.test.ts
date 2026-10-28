import test from "node:test";
import assert from "node:assert/strict";
import { Aligner, tokenize } from "./aligner.ts";

const script =
  "Olá pessoal, hoje eu vou falar sobre produtividade. Primeiro, organize o seu dia na véspera. " +
  "Segundo, escolha uma única tarefa importante. Terceiro, desligue as notificações do celular. " +
  "Por fim, revise o que você fez antes de dormir.";

test("tokenize tira acento e pontuação", () => {
  assert.deepEqual(tokenize("Olá, véspera!"), ["ola", "vespera"]);
});

test("avança lendo o roteiro", () => {
  const a = new Aligner(script);
  a.feed("olá pessoal hoje eu vou falar");
  assert.equal(a.pos, 6);
  a.feed("sobre produtividade primeiro organize");
  assert.equal(a.words[a.pos], "o");
  assert.equal(a.state, "following");
});

test("tolera erro de reconhecimento e palavra pequena engolida", () => {
  const a = new Aligner(script);
  a.feed("ola pessoal hoje vou falar sobre produtividade"); // sem "eu"
  assert.equal(a.words[a.pos], "primeiro");
  a.feed("primeiro organise seu dia na vespera"); // organize/o
  assert.equal(a.words[a.pos], "segundo");
});

test("improviso segura a posição e retoma de onde parou", () => {
  const a = new Aligner(script);
  a.feed("olá pessoal hoje eu vou falar sobre produtividade primeiro organize o seu dia");
  const parou = a.pos;
  a.feed("aliás deixa eu contar uma história rápida que aconteceu ontem comigo");
  assert.equal(a.pos, parou);
  assert.equal(a.state, "improvising");
  a.feed("na véspera segundo escolha uma única tarefa");
  assert.equal(a.words[a.pos], "importante");
  assert.equal(a.state, "following");
});

test("palavra solta do improviso não faz saltar", () => {
  const a = new Aligner(script);
  a.feed("olá pessoal hoje eu vou falar");
  a.feed("dia"); // existe lá na frente, mas é 1 palavra
  assert.equal(a.pos, 6);
});

test("streaming: parciais que crescem andam palavra a palavra sem repetir", () => {
  const a = new Aligner(script);
  const parciais = ["olá", "olá pessoal", "olá pessoal hoje", "olá pessoal hoje eu vou", "olá pessoal hoje eu vou falar sobre"];
  const vistos = parciais.map((p) => a.feedStream("pt", p));
  assert.deepEqual(vistos, [0, 2, 3, 5, 7]);
  a.feedStream("pt", "olá pessoal hoje eu vou falar sobre produtividade", true);
  assert.equal(a.words[a.pos], "primeiro");
  a.feedStream("pt", "primeiro", false); // nova fala começa do zero
  assert.equal(a.words[a.pos], "organize");
});

test("streaming: duas línguas ouvindo ao mesmo tempo, lixo da errada não atrapalha", () => {
  const a = new Aligner(script);
  a.feedStream("en", "hello pass well who may i go foul");
  a.feedStream("pt", "olá pessoal hoje eu vou");
  assert.equal(a.pos, 5);
});

test("segmento com roteiro, improviso e roteiro", () => {
  const a = new Aligner(script);
  a.feed("olá pessoal hoje eu vou falar sobre isso é engraçado mesmo produtividade primeiro organize");
  assert.equal(a.words[a.pos], "o");
});
