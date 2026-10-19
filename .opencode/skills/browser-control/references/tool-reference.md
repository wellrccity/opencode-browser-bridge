# Referência das ferramentas `chrome_*`

Todas as ferramentas aceitam `tabId` quando fazem sentido. Em sessões com mais de uma janela ou aba, passe o `tabId` explicitamente. `timeout` é em milissegundos.

## Sessão, abas e navegação

### `chrome_status`

Sem argumentos. Retorna bridge, versão da extensão, conexão, aba ativa e lista de abas. Use sempre como primeira chamada.

### `chrome_tabs`

| Argumento | Valores / observação |
| --- | --- |
| `action` | `list`, `new`, `activate`, `close`, `get`, `reload`, `duplicate`, `pin`, `mute`, `unmute` |
| `tabId` | Alvo; padrão é a aba ativa |
| `url` | Para `new` |
| `active` | Para `new`: focar a aba |
| `windowId` | Para `new` |
| `waitUntil` | `none`, `commit`, `domcontentloaded` (padrão), `load`, `networkidle` |
| `timeout` | 1000–120000 |
| `bypassCache` | Para `reload` |
| `pinned` | Para `new` |

### `chrome_navigate`

| Argumento | Valores / observação |
| --- | --- |
| `action` | `goto` (padrão), `back`, `forward`, `reload`, `stop` |
| `url` | Obrigatório em `goto`; domínio sem esquema vira `https://` |
| `tabId` | Alvo |
| `newTab` | Abrir em nova aba |
| `active` | Focar a aba; padrão `true` |
| `waitUntil` | `none`, `commit`, `domcontentloaded` (padrão), `load`, `networkidle` |
| `timeout` | 1000–120000; padrão 30000 |
| `bypassCache` | Recarregar ignorando cache |

### `chrome_debugger`

| Argumento | Valores / observação |
| --- | --- |
| `action` | `status`, `attach`, `detach` |
| `tabId` | Alvo |

CDP habilita entrada confiável, screenshot de página inteira, `evaluate`, upload e emulação. O Chrome mostra uma faixa de depuração enquanto estiver anexado.

## Leitura e inspeção

### `chrome_snapshot`

| Argumento | Valores / observação |
| --- | --- |
| `tabId` | Alvo |
| `frameId` | Frame; padrão 0 ou o frame codificado na ref |
| `allFrames` | Incluir iframes |
| `selector` | Restringir a uma subárvore |
| `mode` | `interactive` (padrão) ou `full` |
| `maxNodes` | 20–2000; padrão 400 |
| `maxDepth` | 3–80; padrão 24 |
| `includeHidden` | Incluir elementos ocultos |
| `includeBboxes` | Incluir caixas delimitadoras |
| `timeout` | 1000–120000; padrão 20000 |

As refs têm o formato `f<frame>_e<n>`, por exemplo `f0_e12`.

### `chrome_screenshot`

| Argumento | Valores / observação |
| --- | --- |
| `tabId`, `frameId` | Alvo |
| `fullPage` | Página inteira |
| `ref` ou `selector` | Capturar um elemento (não use os dois) |
| `annotate` | Desenhar refs como caixas rotuladas |
| `grid` | Grade de 100 px |
| `format` | `png` (padrão) ou `jpeg` |
| `quality` | 1–100 para JPEG |
| `maxWidth` | 200–6000 |
| `maxHeight` | 200–12000 |
| `trusted` | Forçar CDP on/off |
| `timeout` | 1000–180000; padrão 60000 |

### `chrome_dom`

| Argumento | Valores / observação |
| --- | --- |
| `action` | `query`, `html`, `text`, `attributes`, `styles`, `rect`, `count` |
| `selector` | CSS; suporta shadow DOM aberto com `host >>> interno` |
| `ref` | Ref do snapshot |
| `xpath` | Alternativa ao CSS |
| `all` | Todos os matches |
| `limit` | 1–100 |
| `includeHtml` | Incluir HTML no resultado de query |
| `maxLength` | 100–30000 |
| `properties` | Lista de propriedades CSS para `styles` |
| `timeout` | 1000–60000; padrão 10000 |

### `chrome_evaluate`

| Argumento | Valores / observação |
| --- | --- |
| `expression` | JavaScript; use IIFE para várias instruções |
| `frameId` | Frame |
| `awaitPromise` | Esperar Promise; padrão `true` |
| `returnByValue` | Retornar JSON; padrão `true` |
| `userGesture` | Simular gesto do usuário; padrão `true` |
| `trusted` | Usar CDP |

Exemplo: `(() => ({ title: document.title, links: [...document.querySelectorAll('a')].length }))()`.

## Interação

### `chrome_click`

Alvo: `ref` (preferido), `selector`, `text` (texto visível/nome acessível) ou `x` + `y`.

| Argumento | Valores / observação |
| --- | --- |
| `exactText` | Exigir texto exato |
| `button` | `left` (padrão), `right`, `middle` |
| `clickCount` | 1–3 |
| `modifiers` | `Alt`, `Control`, `Meta`, `Shift`, `Option`, `Command` |
| `trusted` | `true` = CDP; `false` = eventos DOM |
| `human` | Movimento de mouse humanizado; padrão `false` (mais rápido). Use `true` só quando o site exigir |
| `waitUntil` | Estado de carga após navegação; padrão `domcontentloaded` |
| `timeout` | 1000–120000; padrão 30000 |
| `detectNavigationMs` | 100–5000; padrão 450 |
| `switchToNewTab` | Ativar aba aberta pelo clique |
| `delayAfter` | 0–5000 ms |

### `chrome_type`

Alvo: `ref`, `selector` ou `focused`.

| Argumento | Valores / observação |
| --- | --- |
| `text` | Obrigatório |
| `clear` | Limpar antes; padrão `true` |
| `delay` | 0–1000 ms por caractere |
| `pressEnter` | Enviar Enter no final |
| `trusted` | CDP por padrão |
| `waitUntil` | Estado de carga após Enter; padrão `domcontentloaded` |
| `timeout` | 1000–120000; padrão 30000 |
| `delayAfter` | 0–5000 ms |

Texto vazio + `pressEnter` em um botão focado funciona como clique; prefira `chrome_click` quando disponível.

### `chrome_press`

| Argumento | Valores / observação |
| --- | --- |
| `ref` / `selector` | Focar o elemento antes |
| `key` | `Enter` (padrão), `Tab`, `Escape`, `Backspace`, `ArrowDown`, `Control+A`, `Shift+Enter`, `F5`... |
| `trusted` | CDP por padrão |
| `delay` | 0–2000 ms |
| `noSubmit` | Não enviar formulário ao pressionar Enter |
| `waitUntil` | Estado de carga; padrão `domcontentloaded` |
| `timeout` | 1000–120000 |

### `chrome_hover`

Alvo: `ref`, `selector` ou `text`. Opções: `trusted`, `durationMs` (0–10000), `steps` (1–80), `duration` (0–3000 ms de movimento).

### `chrome_select`

Alvo: `ref` ou `selector`. Escolha por `value`, `values`, `label`, `labels`, `index` ou `indexes`. Para dropdowns customizados, clique no gatilho e depois na opção com `chrome_click`.

### `chrome_scroll`

| Argumento | Valores / observação |
| --- | --- |
| `direction` | `up`, `down` (padrão), `left`, `right` |
| `amount` | 50–10000; padrão 600 |
| `to` | `top` ou `bottom` |
| `ref` / `selector` | Trazer elemento à vista |
| `containerRef` / `containerSelector` | Rolar um container |
| `smooth` | Rolagem suave; padrão `false` (instantânea) |
| `trusted` | Wheel via CDP |

### `chrome_drag`

Origem: `fromRef`, `fromSelector` ou `fromX` + `fromY`. Destino: `toRef`, `toSelector` ou `toX` + `toY`. Opções: `steps` (2–80), `duration` (0–3000), `trusted`.

### `chrome_fill_form`

```json
{
  "tabId": 123,
  "fields": [
    { "ref": "f0_e3", "value": "Maria" },
    { "selector": "#email", "value": "maria@example.com" },
    { "selector": "#country", "type": "select", "value": "BR" },
    { "selector": "#terms", "type": "checkbox", "checked": true }
  ],
  "submit": { "selector": "button[type=submit]" }
}
```

Cada campo aceita `ref`/`selector`, `value`, `text`, `type` (`text`, `select`, `checkbox`, `radio`), `checked`, `values`, `label`, `index`, `clear`, `delay`, `pressEnter` e `frameId`. Opções gerais: `trusted`, `continueOnError`, `timeout`.

### `chrome_upload_file`

| Argumento | Valores / observação |
| --- | --- |
| `ref` / `selector` | `<input type="file">` |
| `files` | Lista de caminhos absolutos na máquina que roda o Chrome |
| `frameId` | Frame do input |

Requer CDP e o frame principal.

## Espera e observação

### `chrome_wait_for`

Informe pelo menos uma condição: `selector`, `text`, `urlIncludes`, `urlMatches`, `js` ou `loadState`.

| Argumento | Valores / observação |
| --- | --- |
| `state` | `visible` (padrão), `attached`, `hidden`, `detached` |
| `exact` | Texto exato |
| `urlMatches` | Fonte de regex JavaScript |
| `js` | Expressão/predicado |
| `loadState` | `commit`, `domcontentloaded`, `load`, `networkidle` |
| `timeout` | 100–120000; padrão 10000 |
| `interval` | 50–2000 ms; padrão 200 |
| `trusted` | Usar CDP |

### `chrome_console`

| Argumento | Valores / observação |
| --- | --- |
| `action` | `get` (padrão) ou `clear` |
| `level` | `log`, `info`, `warn`, `error`, `debug` |
| `limit` | 1–400; padrão 200 |

### `chrome_network`

| Argumento | Valores / observação |
| --- | --- |
| `action` | `get` (padrão) ou `clear` |
| `filter` | Trecho da URL |
| `type` | `fetch`, `xmlhttprequest`, `image` etc. |
| `status` | Código HTTP |
| `includeStatic` | Incluir scripts/imagens/cache |
| `limit` | 1–400; padrão 200 |

## Estado e ambiente

### `chrome_cookies`

| Argumento | Valores / observação |
| --- | --- |
| `action` | `get` (padrão), `set`, `delete`, `clear` |
| `url` / `domain` | Obrigatório para leitura/limpeza; `url` recomendado |
| `name` | Nome exato; use para leitura focada |
| `value` | Para `set` |
| `path` | Padrão `/` no `set` |
| `secure`, `httpOnly`, `sameSite` | Atributos do cookie |
| `expirationDate` | Timestamp Unix em segundos |
| `storeId` | Store de cookies |

### `chrome_dialog`

| Argumento | Valores / observação |
| --- | --- |
| `action` | `status`, `set_policy`, `clear` |
| `intercept` | Ligar/desligar interceptação |
| `confirm` | Resposta automática para `confirm()` |
| `prompt` | Texto retornado por `prompt()` |

### `chrome_highlight`

| Argumento | Valores / observação |
| --- | --- |
| `action` | `show` (padrão), `clear` |
| `ref` / `selector` / `text` | Alvo |
| `all` | Destacar todos os elementos com refs |
| `color` | Cor do contorno |
| `durationMs` | 0–60000 |

### `chrome_emulate`

| Argumento | Valores / observação |
| --- | --- |
| `action` | `set` (padrão), `reset` |
| `width`, `height` | 200–10000 |
| `deviceScaleFactor` | 0.5–4 |
| `mobile` | Emular mobile |
| `userAgent` | String |
| `latitude`, `longitude`, `accuracy` | Geolocalização |
| `colorScheme` | `light`, `dark` |
| `timezone` | Ex.: `America/Sao_Paulo` |
| `offline` | Modo offline |
| `latency`, `downloadThroughput`, `uploadThroughput` | Rede |

Requer CDP. Use `reset` para limpar todos os overrides.
