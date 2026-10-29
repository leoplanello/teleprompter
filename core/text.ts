// Deixa no roteiro só o que se lê em voz alta: tira marcação de markdown, links, emojis e símbolos.
export function cleanScript(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1") // [[nota]] e [[nota|texto]] do Obsidian
    // marcadores de citação que ninguém lê: [1], [12-14], [web:6], [fonte 3], [citation needed]
    .replace(/\[(?:\s*(?:web|cite|ref|fonte|source|nota|note|fig)[^\]]{0,30}|[\d\s,;:–-]{1,20}|citation needed|carece de fontes)\]/gi, " ")
    .replace(/https?:\/\/\S+|www\.\S+/g, " ")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/^[ \t]{0,3}(#{1,6}|>+|[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/[—–]/g, " ")
    .replace(/(^|\s)-+(?=\s|$)/g, " ")
    .replace(/[\p{S}\p{Cf}\p{Extended_Pictographic}§%&@#*_~`^|\\/<>{}[\]=]/gu, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ +([.,;:!?…])/g, "$1")
    .trim();
}
