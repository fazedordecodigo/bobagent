import { useState } from "react";
import type { Status } from "./controls";
import {
  Box,
  Button,
  Chip,
  Counter,
  Dialog,
  Field,
  IconButton,
  KeyboardShortcut,
  ScopeTag,
  SegmentedControl,
  Select,
  StatusDot,
  StatusPill,
  Switch,
  statusLabels,
  Tag,
  Toast,
} from "./controls";
import * as icons from "./icons";
import s from "./Kit.module.css";

const iconLabels: Record<string, string> = {
  CalIcon: "Calendário",
  CardIcon: "Cartão",
  ChartIcon: "Gráfico",
  ChevIcon: "Avançar",
  ClipIcon: "Anexo",
  ClockIcon: "Relógio",
  FileIcon: "Arquivo",
  GearIcon: "Ajustes",
  HomeIcon: "Início",
  HookIcon: "Webhook",
  LockIcon: "Cadeado",
  MailIcon: "E-mail",
  MoonIcon: "Lua",
  PanelIcon: "Painel",
  PlaneIcon: "Avião",
  PlugIcon: "Conexão",
  PlusIcon: "Adicionar",
  ReceiptIcon: "Recibo",
  SearchIcon: "Buscar",
  SheetIcon: "Planilha",
  SideIcon: "Lateral",
  SparkIcon: "Seta diagonal",
  SunIcon: "Sol",
  UpIcon: "Enviar",
  UpbotSimboloCurrentcolorIcon: "Símbolo UpBot",
};

export default function Kit() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? "light");
  const [filter, setFilter] = useState("all");
  const [enabled, setEnabled] = useState(true);
  const [daily, setDaily] = useState(false);
  const [pressed, setPressed] = useState(true);
  const [message, setMessage] = useState("Nenhuma ação realizada.");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toastOpen, setToastOpen] = useState(false);
  const changeTheme = (value: string) => {
    document.documentElement.dataset.themePref = value;
    document.documentElement.dataset.theme = value;
    try {
      localStorage.setItem("upbot.theme", value);
    } catch {}
    setTheme(value);
  };
  return (
    <main className={s.kit}>
      <header className={s.header}>
        <div className={s.brand}>
          <icons.UpbotSimboloCurrentcolorIcon />
          <strong>UpBot</strong>
          <span>Kit de interface</span>
        </div>
        <SegmentedControl
          label="Tema"
          icons
          options={[
            { value: "light", label: "Tema claro", icon: <icons.SunIcon /> },
            { value: "dark", label: "Tema escuro", icon: <icons.MoonIcon /> },
          ]}
          value={theme}
          onValueChange={changeTheme}
        />
      </header>
      <div className={s.intro}>
        <p>DESIGN SYSTEM · FUNDAMENTOS</p>
        <h1>Controles</h1>
        <p>Papel e tinta. Clareza em cada decisão.</p>
        <a href="/">Voltar ao app</a>
      </div>
      <div className={s.grid}>
        <section className={s.card}>
          <h2>Configurações do agente</h2>
          <div className={s.row}>
            <Button variant="danger" onClick={() => setMessage("Confirmação de exclusão.")}>
              Excluir agente
            </Button>
            <Select aria-label="Modelo">
              <optgroup label="Devin">
                <option>Modelo padrão</option>
              </optgroup>
              <optgroup label="Claude">
                <option>Modelo padrão</option>
              </optgroup>
            </Select>
            <Tag>Todo dia, 09:00</Tag>
          </div>
          <div className={s.row}>
            <Button variant="danger">Excluir agente</Button>
            <Button variant="danger" disabled>
              Exclusão indisponível
            </Button>
            <Button onClick={() => setDialogOpen(true)}>Abrir diálogo</Button>
            <Button onClick={() => setToastOpen(true)}>Mostrar toast</Button>
          </div>
          <Box>
            <div className={s.setting}>
              <div>
                <b>Alterações não salvas</b>
                <p>As mudanças ficam no rascunho.</p>
              </div>
              <Button variant="primary">Salvar</Button>
            </div>
          </Box>
          {toastOpen && (
            <Toast
              action="Desfazer"
              onAction={() => {
                setMessage("Ação desfeita.");
                setToastOpen(false);
              }}
            >
              Configurações salvas.
            </Toast>
          )}
          <Dialog open={dialogOpen} title="Excluir agente?" onClose={() => setDialogOpen(false)}>
            <h2>Excluir agente?</h2>
            <p>A pasta de trabalho e as conversas continuam guardadas.</p>
            <Button onClick={() => setDialogOpen(false)}>Cancelar</Button>
            <Button variant="danger" onClick={() => setDialogOpen(false)}>
              Excluir agente
            </Button>
          </Dialog>
        </section>
        <section className={s.card}>
          <h2>Botões</h2>
          <div className={s.row}>
            <Button
              variant="primary"
              onClick={() => setMessage("Exemplo demonstrado. Nenhum relatório foi enviado.")}
            >
              Aprovar e enviar
            </Button>
            <Button onClick={() => setMessage("Revisão de exemplo aberta.")}>Revisar antes</Button>
            <Button variant="ghost" arrow onClick={() => setMessage("Navegação de exemplo.")}>
              Ver no app
            </Button>
          </div>
          <div className={s.row}>
            <Button aria-pressed={pressed} onClick={() => setPressed(!pressed)}>
              Selecionado
            </Button>
            <Button disabled aria-describedby="unavailable">
              Indisponível
            </Button>
            <IconButton aria-label="Buscar" onClick={() => setMessage("Busca de exemplo aberta.")}>
              <icons.SearchIcon />
            </IconButton>
            <IconButton
              aria-label="Painel selecionado"
              aria-pressed={pressed}
              onClick={() => setPressed(!pressed)}
            >
              <icons.PanelIcon />
            </IconButton>
            <IconButton aria-label="Busca indisponível" disabled aria-describedby="unavailable">
              <icons.SearchIcon />
            </IconButton>
          </div>
          <p id="unavailable" className={s.hint}>
            Indisponível até conectar uma conta.
          </p>
          <div className={s.row}>
            <Button small>Revisar antes</Button>
            <Button small variant="ghost">
              Recusar
            </Button>
            <Button small disabled aria-describedby="unavailable">
              Aprovar
            </Button>
          </div>
          <p role="status" className={s.hint}>
            {message}
          </p>
        </section>
        <section className={s.card}>
          <h2>Campos</h2>
          <Field
            label="Enviar relatório para"
            defaultValue="marina.costa@empresa.com.br"
            hint="O UpBot só envia depois que você aprovar."
          />
          <Field
            label="Limite por despesa"
            className={s.num}
            defaultValue="R$ 0,00"
            error="Informe um valor acima de zero."
          />
          <Field label="Buscar tarefa" placeholder="Nome da tarefa" />
          <Field
            label="Conta conectada"
            disabled
            placeholder="Conecte uma conta para continuar"
            hint="Disponível depois de conectar uma conta."
          />
          <Field multiline label="Instruções" placeholder="Descreva a tarefa" />
        </section>
        <section className={s.card}>
          <h2>Estados, segmentos e atalhos</h2>
          <div className={s.row}>
            {(Object.keys(statusLabels) as Status[]).map((status) => (
              <StatusPill key={status} status={status} />
            ))}
          </div>
          <div className={s.row}>
            {(Object.keys(statusLabels) as Status[]).map((status) => (
              <span key={status} className={s.dotLabel}>
                <StatusDot status={status} />
                {statusLabels[status]}
              </span>
            ))}
          </div>
          <div className={s.row}>
            <SegmentedControl
              label="Filtro"
              options={[
                { value: "all", label: "Todas" },
                { value: "active", label: "Ativas" },
                { value: "scheduled", label: "Agendadas" },
                { value: "disabled", label: "Indisponível", disabled: true },
              ]}
              value={filter}
              onValueChange={setFilter}
            />
          </div>
          <p className={s.hint}>O filtro indisponível requer uma tarefa agendada.</p>
          <div className={s.row}>
            <span>
              <KeyboardShortcut>⌘</KeyboardShortcut> <KeyboardShortcut>K</KeyboardShortcut> buscar
            </span>
            <span>
              <KeyboardShortcut>⌘</KeyboardShortcut> <KeyboardShortcut>N</KeyboardShortcut> nova
              tarefa
            </span>
            <span>
              <KeyboardShortcut>⌘</KeyboardShortcut> <KeyboardShortcut>↵</KeyboardShortcut> aprovar
            </span>
          </div>
        </section>
        <section className={s.card}>
          <h2>Ajustes · switch</h2>
          <div className={s.setting}>
            <div>
              <b>Pedir aprovação antes de pagar</b>
              <p>Sempre ativo para valores acima de R$ 0.</p>
            </div>
            <Switch
              checked
              disabled
              onCheckedChange={() => {}}
              aria-label="Pedir aprovação antes de pagar"
            />
          </div>
          <div className={s.setting}>
            <div>
              <b>Resumo diário às 8h</b>
              <p>Uma mensagem com o que mudou desde ontem.</p>
            </div>
            <Switch checked={daily} onCheckedChange={setDaily} aria-label="Resumo diário às 8h" />
          </div>
          <div className={s.setting}>
            <div>
              <b>Abrir com o sistema</b>
              <p>O UpBot fica na barra de menus.</p>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="Abrir com o sistema"
            />
          </div>
          <div className={s.setting}>
            <div>
              <b>Resumo por e-mail</b>
              <p>Conecte uma conta para ativar.</p>
            </div>
            <Switch
              checked={false}
              disabled
              onCheckedChange={() => {}}
              aria-label="Resumo por e-mail"
            />
          </div>
        </section>
        <section className={s.card}>
          <h2>Contadores, escopos e sugestões</h2>
          <div className={s.row}>
            <Counter>{0}</Counter>
            <Counter>{3}</Counter>
            <Counter>{128}</Counter>
            <span className={s.selected}>
              Apps conectados <Counter selected>{3}</Counter>
            </span>
          </div>
          <div className={s.row}>
            <ScopeTag>Ler</ScopeTag>
            <ScopeTag ask>Enviar · pergunta</ScopeTag>
            <ScopeTag ask>Ler · Enviar · pergunta</ScopeTag>
          </div>
          <div className={s.row}>
            <Chip onClick={() => setMessage("Sugestão selecionada: revisar despesas.")}>
              <icons.ReceiptIcon />
              Revisar despesas
            </Chip>
            <Chip disabled aria-describedby="chip-hint">
              <icons.MailIcon />
              Organizar e-mails
            </Chip>
          </div>
          <p id="chip-hint" className={s.hint}>
            Conecte o e-mail para organizar mensagens.
          </p>
        </section>
        <section className={s.card}>
          <h2>Ícones</h2>
          <div className={s.icons}>
            {Object.entries(icons).map(([name, Icon]) => (
              <div key={name}>
                <Icon />
                <span>{iconLabels[name]}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
