# Diagnóstico e recuperação

## Ordem de verificação

1. `chrome_status` — mostra bridge, versão da extensão, abas e aba ativa.
2. Popup da extensão — deve mostrar **Conectado** e a mesma porta do servidor.
3. `opencode mcp list` — o servidor `chrome` deve aparecer como conectado.
4. Se a conexão caiu depois de recarregar a extensão, aguarde alguns segundos; o service worker reconecta sozinho. Se não voltar, abra o popup e clique em **Conectar**.
5. Se o problema continuar, recarregue a extensão em `chrome://extensions`.

O servidor é iniciado pelo OpenCode. **Não** rode outro `node server/src/index.js` na mesma porta.

## A extensão mostra “Desconectado”

- Confirme que o OpenCode está aberto e que o servidor MCP `chrome` está conectado (`opencode mcp list`).
- Confira a URL no popup: padrão `ws://127.0.0.1:8787`.
- Se houver token, ele precisa ser igual a `OPENCODE_BROWSER_TOKEN` no ambiente do servidor.
- Recarregue a extensão e clique em **Conectar** no popup.
- Veja o log do OpenCode em `~/.local/share/opencode/log/opencode.log` e procure por `mcp connected`, `extension ready` ou `extension disconnected`.

## Só algumas ferramentas `chrome_*` aparecem

Sintoma: o servidor está conectado, mas a sessão só mostra um subconjunto (por exemplo, sem `chrome_navigate`, `chrome_click` ou `chrome_screenshot`).

Causa mais comum: o servidor MCP foi configurado com o nome `browser`. O OpenCode V2 tem um namespace nativo `browser` (negado pela permissão padrão `browser`), e ferramentas MCP com nomes iguais são sombreadas. Renomeie a chave em `mcp.servers` para `chrome`, rode `opencode reload` e abra uma **nova sessão**.

Se o nome já for `chrome` e ainda faltar ferramenta, pode ser o cache de catálogo MCP por sessão: abra uma **nova sessão** no mesmo diretório. Não é necessário reinstalar a extensão nem o servidor.

Para conferir o total de ferramentas do servidor:

```powershell
opencode mcp list
```

O servidor atual registra 24 ferramentas.

## `TIMEOUT`

O comando não respondeu dentro do prazo. Possíveis causas:

1. **Diálogo nativo aberto.** Verifique `chrome_dialog` com `action="status"`. Se a aba estiver bloqueada e o comando não responder, feche a aba ou peça ao usuário para pressionar Enter/Escape. Confirme que o popup mostra **Interceptar diálogos** ativo.
2. **Navegação lenta.** Use `chrome_wait_for` com `loadState="domcontentloaded"` ou `selector` em vez de esperar `load`.
3. **Service worker suspenso.** O bridge deve reconectar; tente `chrome_status` de novo. Se persistir, abra o popup e clique em **Conectar**.
4. **Comando CDP pendente.** Use `chrome_debugger` com `action="detach"` na aba e tente novamente. Se o problema repetir, recarregue a aba.

## `PAGE_NOT_SCRIPTABLE`

A aba é restrita: `chrome://`, Chrome Web Store, páginas internas do Chrome ou páginas de extensão. Use uma URL `http(s)` normal. Para `file://`, habilite **Permitir acesso a URLs de arquivo** nas configurações da extensão.

## `DEBUGGER_BUSY`

O DevTools ou outro depurador já está anexado à aba. Feche o DevTools e tente de novo. Sem CDP, use `trusted:false` para entrada sintética; algumas funções (screenshot de página inteira, upload e emulação) exigem CDP.

## Ref não encontrada ou stale

A árvore DOM mudou. Tire um novo `chrome_snapshot` e use as refs novas. Não reutilize refs de snapshots antigos. Para shadow DOM aberto, use `host >>> interno`; para iframes, use `allFrames=true` e o `frameId` codificado na ref.

## Upload falha

- Use caminhos **absolutos** na máquina que roda o Chrome.
- O input precisa ser `<input type="file">` e, de preferência, estar no frame principal.
- Confirme que o CDP está ativo (`chrome_debugger` com `action="status"`).
- Se o input estiver em um iframe, abra o conteúdo do iframe diretamente ou use uma estratégia alternativa.

## Screenshot de página inteira com cabeçalhos repetidos

Sem CDP, a captura é feita em partes e elementos `position: fixed` podem aparecer repetidos. Use CDP (`trusted`/`preferCdp`) para a captura nativa. Páginas muito altas podem ser reduzidas pelo limite de `maxHeight`.

## Diálogos nativos travando

- Ative **Interceptar diálogos** no popup.
- Use `chrome_dialog` com `action="status"` para ver o log e a política.
- `chrome_dialog` com `action="set_policy"` permite definir `intercept`, `confirm` e a resposta de `prompt`.
- Se um diálogo nativo já estiver aberto, o comando pode não responder; feche a aba ou peça ao usuário para dispensar o diálogo.

## `PORT_IN_USE`

Outro processo está usando a porta. Não inicie uma segunda instância sem necessidade. Descubra o processo:

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess
```

Se precisar trocar a porta, atualize `OPENCODE_BROWSER_PORT` no `opencode.jsonc` **e** a URL no popup da extensão.

## O agente não vê o navegador ou age na aba errada

- Chame `chrome_status` e passe `tabId` explicitamente.
- A aba ativa pode ser a interface do OpenCode ou uma aba pessoal. Não use `chrome://` como alvo.
- Em várias janelas, confirme o `windowId` e a aba pelo título/URL antes de agir.
- Depois de um clique que abre nova aba, use `chrome_tabs`/`chrome_wait_for` para localizar a aba nova.

## Testes rápidos do projeto

```powershell
npm run check   # sintaxe, manifest, ícones e configuração
npm test        # bridge e servidor MCP
```

O teste de integração usa uma extensão simulada; ele não substitui um teste no Chrome real.
