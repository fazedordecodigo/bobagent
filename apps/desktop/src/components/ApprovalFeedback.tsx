import { createContext, type ReactNode, useContext, useState } from "react";
import s from "./Approvals.module.css";
import { Button, IconButton } from "./ds/controls";

type Feedback = { message: string; undo?: () => Promise<void> };
const FeedbackContext = createContext<(feedback: Feedback) => void>(() => {});

export function useApprovalFeedback() {
  return useContext(FeedbackContext);
}

export function ApprovalFeedback({ children }: { children: ReactNode }) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <FeedbackContext.Provider value={setFeedback}>
      {children}
      {feedback && (
        <div className={s.toast}>
          <span role="status">{feedback.message}</span>
          {feedback.undo && (
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await feedback.undo?.();
                  setFeedback({
                    message: "Preferência anterior restaurada. A ação aprovada não foi desfeita.",
                  });
                } catch (error) {
                  setFeedback({
                    ...feedback,
                    message: `Não foi possível remover a permissão: ${error instanceof Error ? error.message : String(error)}`,
                  });
                } finally {
                  setBusy(false);
                }
              }}
            >
              Desfazer
            </Button>
          )}
          <IconButton aria-label="Fechar aviso" disabled={busy} onClick={() => setFeedback(null)}>
            ×
          </IconButton>
        </div>
      )}
    </FeedbackContext.Provider>
  );
}
