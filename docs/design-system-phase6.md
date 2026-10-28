# Polimento do design system

## Escolhas

- O daemon real e seus RPCs permanecem responsáveis por tarefas, decisões, páginas e conversas em grupo.
- A janela Tauri mantém `minWidth: 960`, conforme o handoff. A gaveta de 272px abaixo de 760px atende navegador e superfícies estreitas; não é alcançável ao redimensionar a janela nativa principal.
- O painel de execução mantém a sobreposição abaixo de 1180px, preservando o breakpoint existente. A gaveta e o painel sobreposto isolam o restante da interface, contêm o foco e restauram o acionador ao fechar.
- Utilitários de cor legados continuam disponíveis como aliases de tokens semânticos, incluindo branco/preto. Pré-visualizações de tema usam tokens próprios para permanecerem reconhecíveis em qualquer tema.
- Controles têm alvos de pelo menos 44px, mesmo quando o desenho do trilho de um switch é menor. Isso deliberadamente amplia alguns controles em relação às medidas visuais compactas do handoff.

## Ajustes de fidelidade

- Cores e bordas das pré-visualizações claro/escuro, contraste da seleção na lateral e sombras derivadas de tokens.
- Trilhos compactos de switches dentro de alvos de 44px, sem transformar o trilho em um círculo.
- Gaveta sem espaço reservado para os controles nativos do macOS no navegador; botão de fechar próprio.
- Painel sobreposto continua visível mesmo quando o painel de desktop foi recolhido. O botão da gaveta não aparece sobre o título desse painel.
- Páginas: rótulos, estado vazio e ações em português brasileiro.
- Foco, navegação por setas e semântica da paleta, menus, controles segmentados e abas de configurações.

## Desvios restantes

- O aplicativo conserva o rail, navegação por bots, tarefas recentes e biblioteca. O protótipo usa uma lateral única orientada a tarefas. Remover essas superfícies mudaria a navegação existente.
- Conversas e aprovações exibem dados reais, inclusive parâmetros completos para decisões sensíveis. Não reproduzem o exemplo estático de despesas, totais, identidade da pessoa ou etapas de negócio sem informação correspondente no daemon.
- O painel real inclui uso de contexto, computador, ferramentas e permissões. Não foi substituído pela lista ilustrativa de etapas/acessos do protótipo. Seu breakpoint de sobreposição é 1180px, não 1100px.
- Integrações secundárias ainda usam layouts utilitários legados, agora com cores derivadas dos tokens, em vez de todos os componentes do kit. Uma migração estrutural dessas telas fica fora deste polimento.
- O tema da biblioteca de Páginas alcança a interface hospedeira e o fundo do iframe. HTML publicado por um bot permanece em sandbox e pode ter cores próprias; não se injeta CSS em conteúdo publicado.
- Capturas de Páginas cobrem o estado vazio. Capturas de conversa em grupo cobrem o cabeçalho e o compositor reais, sem inventar mensagens.
- A verificação visual desta fase é em Chromium, com daemon real e fixtures ACP/MCP. Não substitui uma nova revisão nativa em WebKit/macOS ou WebView2/Windows, nem uma auditoria completa com leitor de tela.

## Evidências

Capturas claro/escuro em `/Users/devin/screens/phase6/`: conversa, aprovação, apps conectados, permissões, configurações, paleta, Páginas, conversa em grupo, mini janela, kit e gaveta/painel a 700px. Os testes de navegador verificam movimento reduzido, foco de 2px/offset de 3px, setas, menus, Escape, isolamento e restauração de foco da gaveta/painel.
