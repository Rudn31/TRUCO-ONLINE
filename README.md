# Truco Paulista Online

Truco no navegador do celular ou do computador: **2x2** (4 jogadores em duplas) ou **1x1** (mano a mano), com voz gritando "Truco!".

- **Partida rápida**: entra na fila por ordem de chegada; a cada 4 jogadores abre uma mesa.
- **Mesa privada**: cria uma mesa com código para jogar com os amigos.
- **Contra o computador**: joga sozinho com 3 bots (funciona até sem internet).
- Jogador que cai é substituído por um bot até voltar.

## Rodar

```
node server.js        # porta 3000 (ou $PORT)
```

Sem dependências: só Node.js 18+. No Render: Build `echo ok`, Start `node server.js`.

O jogo fica em `public/index.html`; o servidor usa o mesmo motor de regras do arquivo.
