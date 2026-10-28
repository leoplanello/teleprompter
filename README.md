# Teleprompter

Teleprompter translúcido para Windows que segue a sua fala. Escuta o microfone, acha onde você está no roteiro e destaca a palavra. Se você improvisa, ele espera e continua de onde você parou.

- Voz local (Vosk), português e inglês ao mesmo tempo, sem internet.
- Janela translúcida, sempre no topo, com clicar-através e proteção contra captura de tela.
- Configurações pela engrenagem ou `Ctrl+Alt+S`: tamanho, opacidade, fonte, cor, linhas, microfone, idiomas e o texto do roteiro.
- Atualização pelo próprio app (Configurações > Atualização).

## Rodar

```
npm install
python -m venv stt/.venv   # Python 3.13
stt/.venv/Scripts/pip install -r stt/requirements.txt
```

Baixe os modelos Vosk `vosk-model-small-pt-0.3` e `vosk-model-small-en-us-0.15` de https://alphacephei.com/vosk/models e descompacte em `stt/models/`.

```
npm start      # app
npm test       # alinhador
npm run dist   # gera dist/Teleprompter.exe
```

O executável procura o motor de voz em `E:\Projetos\teleprompter\stt` (mude com a variável `TELEPROMPTER_STT`).

## Atalhos

`Ctrl+Alt+` S configurações · O abrir roteiro · T clicar através · H ocultar · Q fechar · ←/→ pular frase · ↑/↓ fonte · `[` `]` opacidade · P esconder da gravação · R voltar ao início.
