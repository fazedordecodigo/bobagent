import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function openExternal(href: string) {
  if ("__TAURI_INTERNALS__" in window) {
    void openUrl(href);
  } else {
    window.open(href, "_blank", "noopener");
  }
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              rel="noreferrer noopener"
              onClick={(event) => {
                event.preventDefault();
                if (href) openExternal(href);
              }}
            >
              {children}
            </a>
          ),
          img: ({ src, alt }) =>
            src ? (
              <a
                href={src}
                rel="noreferrer noopener"
                onClick={(event) => {
                  event.preventDefault();
                  openExternal(src);
                }}
              >
                {alt || src}
              </a>
            ) : null,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
