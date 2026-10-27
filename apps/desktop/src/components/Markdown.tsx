import { openUrl } from "@tauri-apps/plugin-opener";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./CopyButton";

function getTextContent(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint")
    return String(node);
  if (Array.isArray(node)) return node.map(getTextContent).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return getTextContent(node.props.children);
  return "";
}

function wrapLongCellText(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child !== "string") return child;
    let preceding = "";
    return child.split(/(\s+)/u).flatMap((run) => {
      const chars = Array.from(run);
      const context = preceding;
      preceding += run;
      if (!run || /^\s+$/u.test(run) || chars.length <= 24) return run;
      const wrapped: ReactNode[] = [];
      for (let index = 0; index < chars.length; index += 24) {
        wrapped.push(chars.slice(index, index + 24).join(""));
        if (index + 24 < chars.length)
          wrapped.push(<wbr key={`${context}${chars.slice(0, index).join("")}`} />);
      }
      return wrapped;
    });
  });
}

function CodeBlock({ children }: { children: ReactNode }) {
  const code = Children.toArray(children).find(
    (child): child is ReactElement<{ className?: string; children?: ReactNode }> =>
      isValidElement<{ className?: string; children?: ReactNode }>(child),
  );
  const languageClass = code?.props.className ?? "";
  const language = /(?:^|\s)language-([^\s]+)/.exec(languageClass)?.[1] ?? "texto";
  const codeText = getTextContent(code?.props.children ?? children);

  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="meta">{language}</span>
        <CopyButton text={codeText} />
      </div>
      <pre>{children}</pre>
    </div>
  );
}

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
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          th: ({ node, children, ...props }) => {
            void node;
            return <th {...props}>{wrapLongCellText(children)}</th>;
          },
          td: ({ node, children, ...props }) => {
            void node;
            return <td {...props}>{wrapLongCellText(children)}</td>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
