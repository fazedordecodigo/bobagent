import { useEffect, useState } from "react";
import { MUTE_KEY, muteForHour, muteUntil } from "../lib/notifications";
import { Button } from "./ds/controls";

export function NotificationSettings() {
  const [until, setUntil] = useState(() => muteUntil(localStorage));
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const refresh = () => {
      setUntil(muteUntil(localStorage));
      setNow(Date.now());
    };
    window.addEventListener("storage", refresh);
    const timer = setInterval(refresh, 1000);
    return () => {
      window.removeEventListener("storage", refresh);
      clearInterval(timer);
    };
  }, []);
  const muted = until > now;
  return (
    <div className="set-group">
      <div>
        <h2 style={{ fontSize: "var(--fs-h3)" }}>Notificações</h2>
        <p>Somente pedidos que precisam da sua decisão. Fechar um aviso não resolve o pedido.</p>
        <p aria-live="polite">
          {muted
            ? `Silenciado até ${new Date(until).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.`
            : "Os avisos seguem as permissões do seu sistema."}
        </p>
      </div>
      <Button
        onClick={() => {
          if (muted) {
            localStorage.setItem(MUTE_KEY, "0");
            setUntil(0);
          } else setUntil(muteForHour(localStorage));
        }}
      >
        {muted ? "Retomar notificações" : "Silenciar o UpBot por 1 hora"}
      </Button>
    </div>
  );
}
