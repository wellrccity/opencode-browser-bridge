---
name: Controle do navegador
description: Controla o Chrome real pela extensão OpenCode Browser Bridge e pelas ferramentas chrome_*. Use sempre que o usuário pedir para abrir ou navegar em sites, inspecionar o DOM, clicar, digitar, preencher formulários, testar uma aplicação web, tirar screenshots, ler console/rede, gerenciar cookies, emular dispositivo ou automatizar qualquer fluxo no navegador — mesmo que ele não mencione "browser" ou "Chrome" explicitamente (browser automation, web testing, Chrome control, DOM inspection, screenshots, form filling).
---

# Controle do navegador

Esta skill é o manual de uso da integração **OpenCode Browser Bridge**: um servidor MCP local (`chrome`) mais uma extensão MV3 que controla o Google Chrome de verdade, com entrada confiável via CDP quando disponível.

O servidor MCP já é iniciado pelo OpenCode e injeta suas instruções na sessão. Esta skill complementa isso com o fluxo de trabalho, receitas e cuidados que não cabem na descrição curta das ferramentas. Se o servidor estiver conectado, o agente verá as ferramentas `chrome_*`; esta skill não substitui a conexão.

## Antes de qualquer ação

1. Chame `chrome_status`. Ele mostra o estado do bridge, a versão da extensão, as abas abertas e a aba ativa.
2. Se aparecer `Bridge: disconnected`, não invente comandos. Peça para abrir o popup da extensão e clicar em **Conectar**, confira a porta (`ws://127.0.0.1:8787`) e recarregue a extensão em `chrome://extensions` se necessário.
3. Se houver mais de uma janela ou aba, **passe `tabId` explicitamente** em todas as chamadas. A aba ativa pode ser a interface do próprio OpenCode ou uma aba pessoal do usuário; não a controle por engano.
4. O servidor MCP precisa se chamar `chrome` no `opencode.jsonc`. **Não use `browser`**: o OpenCode V2 tem um namespace nativo `browser` que é negado por padrão e sombreia ferramentas MCP com os mesmos nomes (`navigate`, `snapshot`, `click`, `screenshot` etc.). Se acabou de renomear, rode `opencode reload` e abra uma **nova sessão**. Se ainda faltarem ferramentas, abra outra sessão; o catálogo MCP pode ficar congelado por sessão em versões afetadas.

## Regras de ouro

- **Prefira refs a seletores.** Tire um `chrome_snapshot` e use refs como `f0_e12`. Refs pertencem a um frame (`f123_e4` é o frame 123) e podem ficar obsoletas depois de mudanças no DOM; nesse caso, tire outro snapshot.
- **Espere de verdade.** Depois de clicar, digitar ou navegar, use `chrome_wait_for` com seletor, texto, URL, `js` ou `loadState`. Evite `sleep` chutado.
- **Leia antes de agir.** Use `chrome_dom` para HTML, texto, atributos, estilos, rects e contagens. Use `chrome_evaluate` para extração estruturada ou ações que nenhuma ferramenta cobre.
- **CDP é o padrão.** `chrome_click` e `chrome_type` usam entrada confiável (`isTrusted=true`) por padrão. Use `trusted:false` quando o iframe exigir eventos sintéticos ou quando o aviso de depuração do Chrome incomodar.
- **Não misture `ref` e `selector`** na mesma chamada quando a ferramenta exigir um alvo único.
- **Confirme ações irreversíveis.** Antes de comprar, apagar, enviar mensagem, publicar ou alterar configurações, peça confirmação ao usuário.
- **Proteja segredos.** Cookies, tokens, sessões e dados pessoais só devem ser inspecionados quando necessário para a tarefa. Não copie valores sensíveis para a resposta sem necessidade; redija quando possível.
- **Não suba outro servidor na porta 8787.** O bridge pertence ao OpenCode. Se houver `PORT_IN_USE`, descubra o processo antes de encerrar qualquer coisa.
- **Páginas restritas.** Chrome bloqueia automação em `chrome://`, na Chrome Web Store e em algumas páginas internas. Use `http(s)`; para `file://`, habilite “Permitir acesso a URLs de arquivo” na extensão.
- **Diálogos.** A interceptação de `alert`/`confirm`/`prompt` vem ligada. Use `chrome_dialog` para ver o log ou mudar a política. Se um diálogo nativo já estiver bloqueando a aba, `chrome_dialog` pode não responder; feche a aba ou peça para o usuário dispensar o diálogo.

## Desempenho (padrões rápidos)

Os padrões privilegiam velocidade. Ajuste apenas quando o site exigir:

- `chrome_click`: `human=false` por padrão (sem trajetória humanizada do mouse). Use `human=true` somente quando o site reagir a movimento brusco.
- `chrome_click`: observa navegação por ~450 ms (`detectNavigationMs`). Aumente se um clique demorar a navegar.
- Navegação e espera pós-ação usam `waitUntil="domcontentloaded"`. Peça `load` ou `networkidle` quando o conteúdo depender de recursos tardios, ou `none` para não esperar.
- Prefira `chrome_snapshot` a `chrome_screenshot`; snapshots gastam muito menos contexto.
- Evite `sleep` chutado: use `chrome_wait_for` com seletor, texto, URL, `js` ou `loadState`.

## Fluxo padrão

1. `chrome_status` — conexão, abas e aba ativa.
2. `chrome_tabs` (`list`/`get`) — escolha a aba e guarde o `tabId`.
3. `chrome_navigate` (`goto`) ou `chrome_tabs` (`new`) — abra a página.
4. `chrome_snapshot` — árvore de acessibilidade com refs.
5. Ação: `chrome_click`, `chrome_type`, `chrome_select`, `chrome_press`, `chrome_hover`, `chrome_scroll`, `chrome_drag` ou `chrome_fill_form`.
6. `chrome_wait_for` — espere o efeito assíncrono.
7. Verificação: novo `chrome_snapshot`, `chrome_dom` ou `chrome_evaluate`.
8. `chrome_screenshot` — só quando o visual importar de verdade.

## Referência rápida

| Ferramenta | Para que serve |
| --- | --- |
| `chrome_status` | Estado do bridge, versão da extensão, abas e aba ativa. |
| `chrome_tabs` | Listar, criar, ativar, fechar, recarregar, duplicar, fixar ou silenciar abas. |
| `chrome_navigate` | `goto`, `back`, `forward`, `reload`, `stop`; espera o estado de carga pedido. |
| `chrome_snapshot` | Árvore de acessibilidade com refs; iframes e shadow DOM. |
| `chrome_screenshot` | Viewport, página inteira ou elemento; `annotate` e `grid` opcionais. |
| `chrome_click` | Clique por ref, seletor, texto ou coordenadas; CDP por padrão. |
| `chrome_type` | Digitar em input/textarea/contenteditable; limpar e enviar com Enter. |
| `chrome_press` | Teclas e combinações: Enter, Tab, Escape, Control+A, Shift+Enter, F5. |
| `chrome_hover` | Passar o mouse para abrir menus, tooltips e ativar `:hover`. |
| `chrome_select` | Escolher opções de `<select>` por valor, rótulo ou índice. |
| `chrome_scroll` | Rolar página/container, ir ao topo/fim ou trazer elemento à vista. |
| `chrome_wait_for` | Esperar seletor, texto, URL, predicado JS ou estado de carga. |
| `chrome_evaluate` | Executar JavaScript no mundo principal e retornar JSON. |
| `chrome_dom` | Consultar HTML, texto, atributos, estilos, rects e contagens; `>>>` para shadow DOM. |
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

Os argumentos completos de cada ferramenta estão em `references/tool-reference.md`. Receitas e diagnóstico detalhado estão em `references/troubleshooting.md`.

## Receitas

### Abrir uma página e clicar em um link

1. `chrome_navigate` com `action="goto"`, `url` e, se necessário, `newTab=true`.
2. `chrome_snapshot` com o `tabId` escolhido.
3. `chrome_click` com a ref do link (ou `text`/`selector` se não houver ref).
4. `chrome_wait_for` com `urlIncludes` ou `loadState="networkidle"`.
5. `chrome_snapshot` de novo para confirmar a nova página.

### Preencher e enviar um formulário

- Para poucos campos: `chrome_type` em cada ref, `chrome_select` nos `<select>`, depois `chrome_click` no botão de envio.
- Para muitos campos: `chrome_fill_form` com um array `fields`; cada item pode usar `ref` ou `selector` e `type` (`text`, `select`, `checkbox`, `radio`). Use `submit` para enviar no final.
- Prefira `chrome_wait_for` com um texto de confirmação ou uma mudança de URL em vez de assumir que o envio terminou.

### Conteúdo dinâmico (SPA, busca, modais)

1. Faça a ação.
2. `chrome_wait_for` com `selector` do novo conteúdo, `text`, `urlIncludes` ou `js`.
3. Tire um novo `chrome_snapshot`; as refs antigas podem não valer mais.
4. Se a página demorar por rede, use `loadState="networkidle"` com um `timeout` razoável.

### Shadow DOM e iframes

- Shadow DOM aberto: use `chrome_dom` com `selector` no formato `host >>> interno`, por exemplo `#shadowHost >>> #shadowText`.
- Iframes: use `chrome_snapshot` com `allFrames=true`; as refs já codificam o frame (`f123_e4`). Passe `frameId` quando a ferramenta pedir.
- Entrada confiável via CDP é usada no frame principal; em iframes, o agente pode cair para eventos sintéticos. Para fluxos que exigem `isTrusted`, abra o conteúdo do iframe diretamente quando possível.

### Screenshot útil

- `chrome_screenshot` sem alvo: viewport.
- `fullPage=true`: página inteira; pode ser limitada em páginas muito altas.
- `ref` ou `selector`: captura um elemento.
- `annotate=true`: desenha as refs como caixas com rótulos.
- `grid=true`: adiciona uma grade de 100 px para coordenadas.
- Prefira snapshot para ler texto; screenshot gasta mais contexto.

### Upload de arquivo

- Use `chrome_upload_file` com `ref` ou `selector` do `<input type="file">` e `files` com **caminhos absolutos** na máquina que roda o Chrome.
- Requer CDP e o frame principal. Se o input estiver em um iframe, abra o frame ou use uma estratégia alternativa.

### Console, rede e cookies

- `chrome_console`: logs/erros desde o carregamento; `action="clear"` limpa o buffer.
- `chrome_network`: `filter` por trecho de URL, `type` (`fetch`, `xmlhttprequest`, `image`), `status` e `includeStatic=true` para recursos estáticos.
- `chrome_cookies`: informe `url` ou `domain`; para leitura focada, use `name` e `path`. Trate os valores como segredos.

### Emular dispositivo

- `chrome_emulate` com `action="set"`, `width`, `height`, `mobile`, `userAgent`, `deviceScaleFactor`, `colorScheme`, `timezone` ou condições de rede.
- Use `action="reset"` para limpar os overrides. Requer CDP.

### Múltiplas abas e janelas

- `chrome_tabs` (`list`) mostra todas as abas e janelas. Passe `tabId` em cada chamada.
- `chrome_navigate` com `newTab=true` e `switchToNewTab=true` quando o fluxo deve continuar na nova aba.
- Depois de um clique que abre nova aba, use `chrome_wait_for`/`chrome_tabs` para descobrir e ativar a aba correta.

## Tratamento de erros

| Sintoma | O que fazer |
| --- | --- |
| `NOT_CONNECTED` / `NOT_READY` | Abra o popup da extensão, clique em **Conectar**, confira a porta e recarregue a extensão. |
| `TIMEOUT` | Pode ser diálogo nativo, navegação lenta ou service worker suspenso. Verifique `chrome_dialog`, tente `chrome_wait_for` e, se a aba estiver travada, feche-a. |
| `PAGE_NOT_SCRIPTABLE` | A aba é `chrome://`, Chrome Web Store ou página restrita. Use uma página `http(s)` ou habilite acesso a `file://`. |
| `DEBUGGER_BUSY` | Feche o DevTools da aba ou use `trusted:false` quando possível. |
| Ref não encontrada / stale | Tire um novo `chrome_snapshot`; não reutilize refs de uma árvore antiga. |
| Só 11 ferramentas | Nova sessão do OpenCode ou reinicie o OpenCode; o catálogo MCP pode estar congelado. |
| Upload falha | Confirme caminho absoluto, input no frame principal e CDP ativo. |

Diagnóstico mais detalhado: `references/troubleshooting.md`.

## Segurança e responsabilidade

- A extensão tem acesso amplo ao navegador: abas, DOM, cookies, screenshots e depurador. Use apenas para a tarefa pedida.
- Não exfiltre cookies, tokens ou dados pessoais. Se precisar inspecionar, resuma ou redija.
- Não contorne autenticação, CAPTCHAs ou políticas de sites.
- Confirme ações irreversíveis com o usuário.
- O tráfego do bridge fica em loopback; não exponha a porta na rede.

## Arquivos úteis

- `README.md` — instalação, configuração e referência em português.
- `extension/background.js` — service worker, roteamento e comandos.
- `extension/content/agent.js` — snapshot, refs, DOM e interação.
- `extension/content/page-hooks.js` — console, rede e diálogos no MAIN world.
- `extension/lib/cdp.js` — entrada confiável, screenshots e upload.
- `server/src/tools.js` — definição das ferramentas MCP.
- `references/tool-reference.md` — argumentos de todas as ferramentas.
- `references/troubleshooting.md` — erros, conexão e sessão.
