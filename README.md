# OpenCode Browser Bridge

Extensão do Chrome + servidor MCP local que permite ao OpenCode controlar um navegador real de forma parecida com uma pessoa: navegar, ler o DOM, clicar, digitar, preencher formulários, rolar, arrastar, tirar screenshots e muito mais.

O servidor aparece no OpenCode como `chrome` (nome escolhido para não colidir com o namespace `browser` nativo do OpenCode V2), então as ferramentas ficam disponíveis como `chrome_status`, `chrome_navigate`, `chrome_snapshot`, `chrome_click`, etc.

## Como funciona

```text
┌──────────────┐   MCP stdio   ┌──────────────────────────────┐
│   OpenCode   │ ────────────► │ Servidor MCP Node.js         │
│   (agente)   │ ◄──────────── │ ferramentas chrome_*         │
└──────────────┘               │ + bridge WebSocket local      │
                               └──────────────┬───────────────┘
                                              │ ws://127.0.0.1:8787
                                              │ (loopback, token opcional)
                               ┌──────────────▼───────────────┐
                               │ Extensão Chrome (MV3)         │
                               │ service worker + CDP + DOM    │
                               └──────────────┬───────────────┘
                                              │
                               ┌──────────────▼───────────────┐
                               │ Abas, iframes, formulários,  │
                               │ screenshots, downloads...    │
                               └──────────────────────────────┘
```

- O OpenCode inicia o servidor MCP por stdio.
- O servidor também escuta um WebSocket apenas em `127.0.0.1`.
- A extensão se conecta a esse WebSocket como cliente.
- O service worker executa comandos nas abas usando as APIs do Chrome e, quando disponível, o Chrome DevTools Protocol (CDP) para entrada confiável e screenshots.

Nenhum tráfego é enviado para a internet pelo servidor. Os resultados das ferramentas (incluindo screenshots, HTML, cookies e logs) são entregues ao OpenCode e podem ser enviados ao provedor do modelo que você estiver usando — trate dados sensíveis com cuidado.

## Requisitos

- Google Chrome 116 ou mais recente.
- Node.js 20 ou mais recente.
- OpenCode V2.

## Instalação

```powershell
cd C:\Users\Well\Desktop\browser-integration
npm install
```

O arquivo `opencode.jsonc` já aponta para `server/src/index.js` e inicia o servidor automaticamente:

```jsonc
{
  "mcp": {
    "servers": {
      "chrome": {
        "type": "local",
        "command": ["node", "server/src/index.js"],
        "cwd": ".",
        "codemode": false
      }
    }
  }
}
```

Reinicie o OpenCode depois de instalar as dependências. Para conferir o estado do servidor:

```powershell
opencode mcp list
```

## Carregar a extensão no Chrome

1. Abra `chrome://extensions`.
2. Ative o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** / **Load unpacked**.
4. Selecione a pasta `extension` deste projeto.
5. Fixe a extensão na barra de ferramentas para acessar o popup com facilidade.
6. Abra o popup. Ele deve mostrar **Conectado** quando o OpenCode (e o servidor MCP) estiverem rodando.

Se você abrir páginas `file://`, ative **Permitir acesso a URLs de arquivo** nas configurações da extensão.

> A extensão usa a permissão `debugger`, portanto o Chrome mostra uma faixa de “OpenCode Browser Bridge started debugging this browser”. Isso é esperado enquanto o CDP estiver anexado.

## Primeiro teste

No OpenCode, peça algo como:

```text
Use chrome_status para verificar a conexão e depois abra https://example.com em uma nova aba.
Tire um snapshot da página e clique no link "More information...".
```

Fluxo recomendado para o agente:

1. `chrome_status` — confirma a conexão e lista as abas.
2. `chrome_navigate` — abre uma URL.
3. `chrome_snapshot` — retorna uma árvore de acessibilidade compacta com refs como `f0_e12`.
4. `chrome_click`, `chrome_type`, `chrome_select`, `chrome_hover`, `chrome_press` — usam as refs.
5. `chrome_wait_for` — espera atualizações assíncronas ou navegação.
6. `chrome_screenshot` — use quando o visual importa. `annotate=true` desenha as refs e `grid=true` adiciona uma grade de 100 px.

As refs são o jeito mais confiável de mirar elementos. Elas pertencem a um frame: `f0_e12` é o frame principal; `f123_e4` é o frame 123. Se a página mudou, tire um novo snapshot.

## Skill pronta

O projeto inclui uma skill local em `.opencode/skills/browser-control/SKILL.md`. Ela ensina o fluxo completo: verificar a conexão, escolher `tabId`, usar refs, preencher formulários, esperar conteúdo dinâmico, tirar screenshots, lidar com iframes/shadow DOM, upload, cookies, rede, emulação e recuperação de erros.

Em uma nova sessão do OpenCode, a skill aparece automaticamente na lista de skills. Você pode carregá-la explicitamente com `@browser-control` ou pedindo algo como “use a skill de navegador”. As referências detalhadas ficam em:

- `.opencode/skills/browser-control/references/tool-reference.md` — argumentos de todas as ferramentas.
- `.opencode/skills/browser-control/references/troubleshooting.md` — diagnóstico e recuperação.

A skill complementa as instruções do servidor MCP; ela não substitui a extensão conectada.

## Ferramentas disponíveis

| Ferramenta | Para que serve |
| --- | --- |
| `chrome_status` | Estado da conexão, abas abertas e aba ativa. |
| `chrome_tabs` | Listar, criar, ativar, fechar, recarregar, duplicar, fixar ou silenciar abas. |
| `chrome_navigate` | Abrir URL, voltar, avançar, recarregar ou parar. |
| `chrome_snapshot` | Árvore de acessibilidade com refs; suporta iframes e shadow DOM. |
| `chrome_screenshot` | Viewport, página inteira ou elemento; anotações e grade opcionais. |
| `chrome_click` | Clique por ref, seletor, texto ou coordenadas; evento real via CDP. |
| `chrome_type` | Digitar em input, textarea ou contenteditable; limpar e enviar com Enter. |
| `chrome_press` | Teclas e combinações: Enter, Tab, Escape, Control+A, Shift+Enter, F5... |
| `chrome_hover` | Passar o mouse para abrir menus, tooltips e ativar `:hover`. |
| `chrome_select` | Selecionar opções de `<select>` por valor, rótulo ou índice. |
| `chrome_scroll` | Rolar a página ou um container, ir ao topo/fim ou trazer um elemento à vista. |
| `chrome_wait_for` | Esperar seletor, texto, URL, predicado JavaScript ou estado de carregamento. |
| `chrome_evaluate` | Executar JavaScript no mundo principal e retornar JSON. |
| `chrome_dom` | Consultar HTML, texto, atributos, estilos, rects e contagens. |
| `chrome_fill_form` | Preencher vários campos de uma vez e opcionalmente enviar. |
| `chrome_upload_file` | Anexar arquivos em `<input type="file">` via CDP. |
| `chrome_console` | Ler logs, avisos, erros e rejeições não tratadas. |
| `chrome_network` | Ler requisições `fetch`/XHR capturadas, com status e duração. |
| `chrome_cookies` | Ler, criar, apagar ou limpar cookies do site. |
| `chrome_dialog` | Inspecionar `alert`/`confirm`/`prompt` e mudar a política de resposta. |
| `chrome_highlight` | Desenhar contornos temporários em elementos. |
| `chrome_drag` | Arrastar de um elemento/ponto a outro. |
| `chrome_emulate` | Emular viewport, mobile, user agent, geolocalização, tema, fuso e rede. |
| `chrome_debugger` | Ver, anexar ou desanexar o depurador CDP de uma aba. |

## Desempenho

Os padrões priorizam velocidade e economia de contexto:

- `chrome_click` usa `human=false` por padrão (sem trajetória humanizada do mouse). Passe `human=true` quando o site precisar.
- Depois de um clique, o bridge observa a navegação por ~450 ms (`detectNavigationMs`). Aumente se o clique demorar a navegar.
- `waitUntil` padrão é `domcontentloaded`; peça `load` ou `networkidle` quando o conteúdo depender de recursos tardios, ou `none` para não esperar.
- Prefira `chrome_snapshot` a `chrome_screenshot`: snapshots gastam muito menos contexto.
- Use `chrome_wait_for` (seletor, texto, URL, `js` ou `loadState`) em vez de pausas fixas.

## Configurações da extensão

Abra o popup da extensão para ajustar:

- **URL do servidor MCP** — padrão `ws://127.0.0.1:8787`.
- **Token** — opcional; precisa ser igual a `OPENCODE_BROWSER_TOKEN` no servidor.
- **Conectar automaticamente** — reconecta quando o Chrome inicia.
- **Usar CDP por padrão** — ativa entrada confiável (`isTrusted=true`), screenshots via CDP, avaliação, upload e emulação. Desative se o aviso de depuração incomodar.
- **Manter depurador anexado** — se desativado, o CDP é desanexado alguns segundos depois de cada comando.
- **Interceptar diálogos** — evita que `alert`, `confirm` e `prompt` travem a automação.
- **Aceitar `confirm()`** — escolhe a resposta automática.
- **Resposta de `prompt()`** — texto devolvido automaticamente.
- **Mudar para novas abas** — ativa uma aba aberta por um clique.

## Variáveis de ambiente do servidor

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `OPENCODE_BROWSER_PORT` | `8787` | Porta do bridge WebSocket. |
| `OPENCODE_BROWSER_HOST` | `127.0.0.1` | Endereço de escuta. |
| `OPENCODE_BROWSER_TOKEN` | vazio | Token compartilhado exigido da extensão. |
| `OPENCODE_BROWSER_ALLOW_REMOTE` | vazio | `1` permite escutar fora do loopback. Evite. |
| `OPENCODE_BROWSER_REQUEST_TIMEOUT` | `30000` | Timeout padrão de comandos em ms. |
| `OPENCODE_BROWSER_DEBUG` | vazio | `1` inclui stack traces nos erros das ferramentas. |

Se mudar a porta, atualize também a URL no popup da extensão. Só um processo pode usar a mesma porta.

Exemplo com token:

```jsonc
"environment": {
  "OPENCODE_BROWSER_PORT": "8787",
  "OPENCODE_BROWSER_TOKEN": "{env:OPENCODE_BROWSER_TOKEN}"
}
```

Depois preencha o mesmo token no popup da extensão.

## Segurança

- O bridge escuta somente em loopback por padrão.
- O servidor rejeita conexões com `Origin` de páginas web comuns; apenas `chrome-extension://` (ou clientes locais sem `Origin`, como os testes) podem conectar.
- Um token compartilhado é opcional, mas recomendado em máquinas compartilhadas.
- Apenas uma extensão fica conectada por vez; uma nova conexão substitui a anterior.
- A extensão tem acesso amplo ao navegador: abas, DOM, cookies, screenshots e depurador. Instale apenas este código local e revise alterações antes de usar.
- Nunca exponha a porta do bridge na rede. Se usar `OPENCODE_BROWSER_ALLOW_REMOTE=1`, você assume o risco.
- O agente deve confirmar com você antes de ações irreversíveis (comprar, apagar, enviar mensagens).
- Cookies, tokens e dados pessoais não devem ser exfiltrados; inspecione apenas o necessário para a tarefa.

## Solução de problemas

### A extensão mostra “Desconectado”

1. Verifique se o OpenCode está aberto e se o servidor MCP `chrome` está conectado (`opencode mcp list`).
2. Confirme que a porta no popup é a mesma do servidor.
3. Clique em **Conectar** no popup.
4. Recarregue a extensão em `chrome://extensions`.
5. Se houver token, confirme que os dois lados usam o mesmo valor.

### `PORT_IN_USE`

Outro processo já está usando a porta. Feche a instância antiga ou mude `OPENCODE_BROWSER_PORT` no `opencode.jsonc` e a URL no popup.

### `NOT_CONNECTED` / `NOT_READY`

A extensão não completou o handshake. Abra o popup, clique em **Conectar** e recarregue a extensão se o problema continuar.

### CDP não anexa

O DevTools ou outra extensão pode estar usando o depurador da aba. Feche o DevTools e tente novamente. Sem CDP, as ferramentas ainda funcionam com eventos sintéticos, mas sem entrada confiável, screenshot de página inteira, upload e emulação.

### Páginas que não podem ser controladas

Chrome bloqueia extensões em `chrome://`, na Chrome Web Store e em algumas páginas internas. Use páginas `http(s)` normais. Para `file://`, habilite o acesso a URLs de arquivo.

### Só algumas ferramentas `chrome_*` aparecem

Confira se o servidor está configurado como `chrome` no `opencode.jsonc`. **Não use `browser` como nome do servidor MCP**: o OpenCode V2 já tem um namespace nativo `browser` (negado pela permissão padrão `browser`), e ferramentas MCP com nomes iguais são sombreadas. Foi por isso que `navigate`, `snapshot`, `screenshot`, `click` etc. desapareciam.

Se o nome já for `chrome` e ainda faltarem ferramentas, abra uma **nova sessão** no mesmo diretório do projeto. Em versões afetadas, o catálogo MCP pode ficar congelado por sessão. A extensão e o servidor continuam rodando; não é preciso reinstalar nada. Confira o total com:

```powershell
opencode mcp list
```

O servidor atual registra 24 ferramentas.

### Sem logs de console ou rede

A extensão captura dados a partir do momento em que a página carrega. Recarregue a página depois de instalar ou recarregar a extensão.

### Diálogos nativos travando

Ative **Interceptar diálogos** no popup. Se um diálogo nativo já estiver aberto, use `chrome_dialog` ou feche-o manualmente.

### Screenshot de página inteira com cabeçalhos repetidos

Sem CDP, a captura é feita em partes e cabeçalhos fixos podem aparecer repetidos. Use CDP (`trusted`/`preferCdp`) para a captura nativa.

### Cliques em iframes

Cliques confiáveis via CDP são usados no frame principal. Em iframes, o agente usa eventos sintéticos no DOM. Para fluxos que exigem `isTrusted`, abra o conteúdo do iframe diretamente quando possível.

## Desenvolvimento

```powershell
npm run icons   # regenera extension/icons/*.png
npm run check   # valida sintaxe e referências do manifest
npm test        # testes do bridge e do servidor MCP
npm start       # roda o servidor MCP manualmente (sem OpenCode)
```

Estrutura:

```text
extension/
  manifest.json          manifesto MV3
  background.js          service worker, WebSocket e roteamento
  popup.html/css/js      interface em português
  content/agent.js       agente DOM injetado sob demanda
  content/page-hooks.js  console/rede/diálogos no MAIN world
  lib/cdp.js             helpers do Chrome DevTools Protocol
  lib/image.js           anotação, grade e redimensionamento
  lib/settings.js        configurações padrão
  lib/util.js            utilitários
server/src/
  index.js               entrada MCP por stdio
  bridge.js              bridge WebSocket local
  tools.js               definição das ferramentas MCP
  format.js              formatação das respostas
test/                    testes sem Chrome
scripts/                 ícones e verificação
.opencode/skills/
  browser-control/       skill de uso da integração
    SKILL.md
    references/          referência de ferramentas e troubleshooting
```

## Limitações conhecidas

- O Chrome pode suspender o service worker; o alarme de keepalive e a reconexão automática reduzem o impacto.
- A avaliação JavaScript no mundo principal pode ser bloqueada pelo CSP de algumas páginas; CDP é o caminho preferido.
- Capturas de página inteira muito altas são limitadas e podem ser reduzidas.
- A extensão não contorna autenticação, CAPTCHAs ou políticas de sites; use com responsabilidade.
- O comportamento de diálogos e frames varia conforme o site.
