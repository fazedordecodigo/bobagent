# Main-window sidebar

Reference: supplied 1568×1089 image. The new `boto-handoff.zip` was extracted to
`/Users/devin/sidebar-handoff/boto-handoff`; recursive comparison with the earlier
handoff found no differences. Layout comes from `prototipos/boto-desktop-app.html`.
The image scales the prototype's 248px sidebar to approximately 270px; this app uses
270px, 15px navigation/bot titles, 13px subtitles, token radii and semantic colors.

## Navigation

- Nova tarefa: the existing new-bot dialog, also reached with ⌘N / Ctrl+N.
- Buscar: the existing command palette, also reached with ⌘K / Ctrl+K.
- Início: the existing default empty-state content; there was no separate landing view.
- Agendadas: all records from `routines.list({})`, including disabled and webhook-only
  routines. Each available bot opens its conversation. Loading, empty, error/retry,
  reconnect and routine update/delete states are handled.
- Apps conectados: Settings → Apps. The pill counts pending approvals with an app ID,
  not waiting bots or connected apps; it disappears at zero.
- Bot/group rows open the existing conversations. Bot status uses real pending
  approvals, provider status, queue length and latest turn. Pending app approvals take
  priority over the provider's still-running status. Colors appear only on status dots.
- Footer gear: Settings → Geral. Light/dark buttons use the existing persisted theme.
- Páginas, Todos os bots, Tarefas, group creation and every settings tab remain in the
  command palette. Páginas is always present, even when its library is empty; ⌘P / Ctrl+P
  also continues to work. The updater moved from the old sidebar to general settings.

The section label is **SEUS AGENTES**, per the user's subsequent explicit override;
other UI terminology continues to say bot.

## Profile and accessibility

No existing personal profile/OS-user API was found. The allowed settings-value fallback
is an editable **Seu nome** field in general settings, persisted locally as
`boto.profile.name`. Until configured the footer truthfully says **Você**, rather than
inventing an identity. Screenshots configure the fixture profile as Marina.

The drawer retains its dialog semantics, inert background, Tab containment, Escape,
scrim close and focus restoration below 760px. With the old rail gone, it and its scrim
now extend to the bottom edge. Native `minWidth: 960` is unchanged.

Navigation controls and bot rows are at least 44px tall. To match the compact reference
footer, theme segments are **28×28px** and the gear is **34×44px**; these are intentional
exceptions to the general target rule. The theme fieldset retains arrow/Home/End keys,
pressed-state semantics and roving Tab focus. The outlined new-task button remains
44px tall (slightly taller than the image's approximately 40px).

## Visual verification and differences

Chromium screenshots at exactly 1568×1089 use the real daemon, ACP and MCP fixtures:
completed, awaiting approval, running, failed and queued bots, plus real group chats.
Light/dark: `/Users/devin/screens/sidebar/main-{light,dark}.png`.
Side-by-side comparison: `/Users/devin/screens/sidebar/comparison.png`.

- The official handoff symbol is the existing current-color SVG component; the Nunito
  wordmark follows the prototype, rather than introducing a replacement logo drawing.
- Native traffic lights belong to Tauri/macOS. Their reserved 52px region stays empty
  in browser captures; no fake window controls were added.
- Real names, bot/group counts, pending count and state subtitles differ from the
  illustrative four tasks, two requests and Emerson profile in the reference.
- Main conversation/details content is preserved, not replaced with illustrative travel
  steps. Token colors (including dark-theme inversion) are preserved rather than
  sampling colors from the reference raster.
- Native WebKit/WebView2 rendering was not reverified for this sidebar change.

Browser coverage includes navigation, an empty and populated routines list, a deliberately
injected routines RPC error and successful retry, live approval badge removal, selected
inversion, profile editing, theme persistence/keyboard navigation, groups, palette Pages
reachability, and the existing narrow drawer/focus/ARIA/reduced-motion checks.
