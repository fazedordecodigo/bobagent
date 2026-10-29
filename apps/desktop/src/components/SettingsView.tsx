import type { Agent } from "@upbot/protocol";
import { type ReactNode, useEffect, useState } from "react";
import type { DaemonClient } from "../lib/daemon";
import { moveControlFocus } from "../lib/keyboard";
import { type ThemePreference, useThemePref } from "../lib/theme";
import { Pill } from "../lib/ui";
import { Icon } from "./icons";
import { NotificationSettings } from "./NotificationSettings";
import { TABS, ToolBody, type ToolTab } from "./ToolsView";
import { UpdateButton } from "./UpdateButton";

const STATUS_NOTES = {
  run: "Agindo agora",
  wait: "Precisa de você",
  ok: "Entregue",
  err: "Falhou",
};

export function SettingsView({
  client,
  agents,
  selected,
  onSelect,
  profileName,
  onProfileName,
}: {
  client: DaemonClient;
  agents: Agent[];
  selected: ToolTab | "general";
  onSelect: (tab: ToolTab | "general") => void;
  profileName: string;
  onProfileName: (name: string) => void;
}) {
  const [theme, setTheme] = useThemePref();
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const dark = theme === "auto" ? systemDark : theme === "dark";
  return (
    <section className="view on">
      <div className="page">
        <div className="page-inner settings">
          <div className="page-top">
            <div>
              <h1>Configurações</h1>
              <p>Preferências desta conta, aplicadas em todos os seus bots.</p>
            </div>
          </div>
          <div
            className="filters"
            role="tablist"
            aria-label="Configurações"
            onKeyDown={moveControlFocus}
          >
            <button
              type="button"
              className="chip"
              role="tab"
              aria-selected={selected === "general"}
              tabIndex={selected === "general" ? 0 : -1}
              onClick={() => onSelect("general")}
            >
              Geral
            </button>
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className="chip"
                role="tab"
                aria-selected={selected === tab.id}
                tabIndex={selected === tab.id ? 0 : -1}
                title={tab.hint}
                onClick={() => onSelect(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {selected === "general" ? (
            <>
              <div className="set-group">
                <div>
                  <h2 style={{ fontSize: "var(--fs-h3)" }}>Perfil</h2>
                  <p>Nome exibido neste dispositivo.</p>
                </div>
                <label>
                  Seu nome
                  <input
                    className="field"
                    value={profileName}
                    maxLength={80}
                    placeholder="Seu nome"
                    onChange={(event) => onProfileName(event.target.value)}
                  />
                </label>
              </div>
              <NotificationSettings />
              <UpdateButton />
              <div className="set-group" data-od-id="settings-appearance">
                <div>
                  <h2 style={{ fontSize: "var(--fs-h3)" }}>Tema</h2>
                  <p>Escolha um tema fixo ou deixe o UpBot seguir o seu sistema.</p>
                </div>
                <div>
                  <fieldset className="theme-opts">
                    <legend className="sr">Tema da interface</legend>
                    <ThemeOption value="light" current={theme} onChange={setTheme}>
                      <span className="tp light">
                        <span className="tp-rail" />
                        <span className="tp-main">
                          <i style={{ width: "62%" }} />
                          <i style={{ width: "88%" }} />
                          <i style={{ width: "46%" }} />
                          <span className="tp-dots">
                            <b className="r" />
                            <b className="w" />
                            <b className="o" />
                          </span>
                        </span>
                      </span>
                      <span className="lbl">
                        <span>
                          Claro<small>Fundo branco</small>
                        </span>
                        <span className="tick">
                          <Icon name="ok" />
                        </span>
                      </span>
                    </ThemeOption>
                    <ThemeOption value="dark" current={theme} onChange={setTheme}>
                      <span className="tp dark">
                        <span className="tp-rail" />
                        <span className="tp-main">
                          <i style={{ width: "62%" }} />
                          <i style={{ width: "88%" }} />
                          <i style={{ width: "46%" }} />
                          <span className="tp-dots">
                            <b className="r" />
                            <b className="w" />
                            <b className="o" />
                          </span>
                        </span>
                      </span>
                      <span className="lbl">
                        <span>
                          Escuro<small>Fundo grafite</small>
                        </span>
                        <span className="tick">
                          <Icon name="ok" />
                        </span>
                      </span>
                    </ThemeOption>
                    <ThemeOption value="auto" current={theme} onChange={setTheme}>
                      <span className="tp auto">
                        <span className="tp light">
                          <span className="tp-rail" />
                          <span className="tp-main">
                            <i style={{ width: "80%" }} />
                            <i style={{ width: "100%" }} />
                            <i style={{ width: "60%" }} />
                            <span className="tp-dots">
                              <b className="r" />
                              <b className="w" />
                            </span>
                          </span>
                        </span>
                        <span className="tp dark">
                          <span className="tp-main">
                            <i style={{ width: "70%" }} />
                            <i style={{ width: "100%" }} />
                            <i style={{ width: "50%" }} />
                            <span className="tp-dots">
                              <b className="w" />
                              <b className="o" />
                            </span>
                          </span>
                        </span>
                      </span>
                      <span className="lbl">
                        <span>
                          Automático<small>Segue o sistema</small>
                        </span>
                        <span className="tick">
                          <Icon name="ok" />
                        </span>
                      </span>
                    </ThemeOption>
                  </fieldset>
                  <p className="theme-note" aria-live="polite">
                    {theme === "auto" ? (
                      <>
                        Seu sistema está no tema <b>{dark ? "escuro" : "claro"}</b>. O UpBot troca
                        junto quando ele mudar.
                      </>
                    ) : (
                      <>
                        Tema <b>{theme === "dark" ? "escuro" : "claro"}</b> fixo, independente do
                        sistema.
                      </>
                    )}
                  </p>
                </div>
              </div>
              <div className="set-group" data-od-id="settings-status-preview">
                <div>
                  <h2 style={{ fontSize: "var(--fs-h3)" }}>Cores de status</h2>
                  <p>
                    Os mesmos quatro estados nos dois temas. No escuro, o tom fica mais claro e
                    saturado.
                  </p>
                </div>
                <div className="st-demo">
                  {(["run", "wait", "ok", "err"] as const).map((st) => (
                    <div key={st}>
                      <Pill st={st} />
                      <span className="meta">{STATUS_NOTES[st]}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <ToolBody client={client} agents={agents} tab={selected} />
          )}
        </div>
      </div>
    </section>
  );
}

function ThemeOption({
  value,
  current,
  onChange,
  children,
}: {
  value: ThemePreference;
  current: ThemePreference;
  onChange: (value: ThemePreference) => void;
  children: ReactNode;
}) {
  return (
    <label className="theme-opt">
      <input
        type="radio"
        name="theme"
        value={value}
        checked={current === value}
        onChange={() => onChange(value)}
      />
      {children}
    </label>
  );
}
