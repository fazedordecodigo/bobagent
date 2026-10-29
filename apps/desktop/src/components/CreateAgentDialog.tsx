import type { AgentAvatar, ProviderId } from "@upbot/protocol";
import { useEffect, useRef, useState } from "react";
import type { DaemonClient } from "../lib/daemon";
import { errorMessage } from "../lib/errors";
import { statusProvider } from "../lib/ui";
import { PROVIDERS } from "./AgentSettings";
import { Icon } from "./icons";

export type Autonomy = "ask" | "sensitive" | "auto";

export type NewAgentForm = {
  name: string;
  provider: ProviderId;
  instructions: string;
  autonomy: Autonomy;
  avatar: AgentAvatar | null;
};

export function CreateAgentDialog({
  client,
  onSubmit,
  onCancel,
}: {
  client: DaemonClient;
  onSubmit: (form: NewAgentForm) => Promise<void>;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<ProviderId>("claude");
  const [instructions, setInstructions] = useState("");
  const [avatar, setAvatar] = useState<AgentAvatar | null>(null);
  const [autonomy, setAutonomy] = useState<Autonomy>("ask");
  const [nameError, setNameError] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  const suggest = async () => {
    setDraftError(null);
    setDrafting(true);
    try {
      const proposal = await client.request("agents.draft", { prompt: instructions.trim() });
      setName(proposal.name);
      setInstructions(proposal.instructions);
      setAvatar(proposal.avatar);
    } catch (e) {
      setDraftError(errorMessage(e));
    } finally {
      setDrafting(false);
    }
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement as HTMLElement | null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => previous?.focus();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="dlgTitle"
      data-od-id="new-agent-dialog"
      onClose={onCancel}
    >
      <form
        noValidate
        onSubmit={async (event) => {
          event.preventDefault();
          const trimmedName = name.trim();
          if (!trimmedName) {
            setNameError(true);
            return;
          }
          setNameError(false);
          setSubmitError(null);
          setBusy(true);
          try {
            await onSubmit({
              name: trimmedName,
              provider,
              instructions: instructions.trim(),
              autonomy,
              avatar,
            });
          } catch (e) {
            setSubmitError(errorMessage(e));
            setBusy(false);
          }
        }}
      >
        <div className="dlg-head">
          <h2 id="dlgTitle">Criar bot</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="Fechar"
            onClick={() => dialogRef.current?.close()}
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="dlg-body">
          <div className="field">
            <label htmlFor="fName">Nome</label>
            <input
              className="input"
              id="fName"
              placeholder="Ex.: Viagens"
              value={name}
              maxLength={80}
              aria-invalid={nameError}
              aria-describedby={nameError ? "fNameErr" : undefined}
              onChange={(event) => {
                setName(event.target.value);
                if (event.target.value.trim()) setNameError(false);
              }}
            />
            {nameError && (
              <span className="err" id="fNameErr">
                Dê um nome ao bot.
              </span>
            )}
          </div>
          <div className="field">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="fRole">O que ele faz</label>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={!instructions.trim() || drafting}
                onClick={() => void suggest()}
              >
                {drafting ? "Sugerindo…" : "Sugerir nome e instruções"}
              </button>
            </div>
            <input
              className="input"
              id="fRole"
              placeholder="Ex.: Reserva voos e hotéis dentro da política"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
            {draftError && <span className="err">{draftError}</span>}
          </div>
          <fieldset className="field">
            <legend>Provedor</legend>
            <div className="checks">
              {PROVIDERS.map((providerId) => (
                <label key={providerId}>
                  <input
                    type="radio"
                    name="provider"
                    value={providerId}
                    checked={provider === providerId}
                    onChange={() => setProvider(providerId)}
                  />
                  {statusProvider(providerId)}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="field">
            <legend>Autonomia</legend>
            <label className="opt">
              <input
                type="radio"
                name="auto"
                value="ask"
                checked={autonomy === "ask"}
                onChange={() => setAutonomy("ask")}
              />
              <span>
                Sempre perguntar
                <small>Mostra o plano e espera sua aprovação antes de cada ação.</small>
              </span>
            </label>
            <label className="opt">
              <input
                type="radio"
                name="auto"
                value="sensitive"
                checked={autonomy === "sensitive"}
                onChange={() => setAutonomy("sensitive")}
              />
              <span>
                Perguntar em ações sensíveis
                <small>Age sozinho, mas pede aprovação para pagar, enviar ou apagar.</small>
              </span>
            </label>
            <label className="opt">
              <input
                type="radio"
                name="auto"
                value="auto"
                checked={autonomy === "auto"}
                onChange={() => setAutonomy("auto")}
              />
              <span>
                Autônomo
                <small>
                  Executa do início ao fim e envia um resumo. Pagamentos, envios e exclusões ainda
                  pedem aprovação.
                </small>
              </span>
            </label>
          </fieldset>
          {submitError && <p className="err">{submitError}</p>}
        </div>
        <div className="dlg-foot">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => dialogRef.current?.close()}
          >
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Criar e abrir
          </button>
        </div>
      </form>
    </dialog>
  );
}
