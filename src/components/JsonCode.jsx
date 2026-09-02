/**
 * JSON display and editing.
 *
 * `JsonView` is read-only and syntax-coloured. `JsonEditor` is a real textarea that is *always*
 * editable — no button to press first — with the coloured version rendered behind it and the
 * caret-bearing textarea transparent on top. Both share `.code-metrics` so the two layers line up
 * to the pixel; if you change the font or padding, change it there and nowhere else.
 *
 * Tokenising into elements rather than building an HTML string means nothing typed into the editor
 * can be interpreted as markup.
 */
import { useLayoutEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

const TOKEN =
  /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|(\b-?\d+\.?\d*(?:[eE][+-]?\d+)?\b)|(\btrue\b|\bfalse\b|\bnull\b)/g;

function tokenise(text) {
  const out = [];
  let last = 0;
  let m;
  let k = 0;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text))) {
    if (m.index > last) out.push(<span key={k++} className="tok-pun">{text.slice(last, m.index)}</span>);
    const [, key, str, num, lit] = m;
    if (key) {
      const cut = key.lastIndexOf('"') + 1;
      out.push(
        <span key={k++} className="tok-key">{key.slice(0, cut)}</span>,
        <span key={k++} className="tok-pun">{key.slice(cut)}</span>
      );
    } else if (str) out.push(<span key={k++} className="tok-str">{str}</span>);
    else if (num) out.push(<span key={k++} className="tok-num">{num}</span>);
    else out.push(<span key={k++} className="tok-lit">{lit}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<span key={k++} className="tok-pun">{text.slice(last)}</span>);
  return out;
}

const PAD = 'px-4 py-3';

export function JsonView({ value, className }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'null';
  return (
    <pre className={cn('code-metrics overflow-x-auto', PAD, className)}>{tokenise(text)}</pre>
  );
}

export function JsonEditor({ text, onChange, invalid, minRows = 6 }) {
  const ta = useRef(null);
  const back = useRef(null);

  /* Grow with the content so the whole payload is visible without an inner scrollbar — these
     bodies are short, and a nested scroll area here would be worse than a taller card. */
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight, minRows * 20)}px`;
  }, [text, minRows]);

  return (
    <div className="relative">
      <pre
        ref={back}
        aria-hidden="true"
        className={cn('code-metrics pointer-events-none absolute inset-0 overflow-hidden', PAD)}
      >
        {tokenise(text)}
      </pre>
      <textarea
        ref={ta}
        value={text}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onScroll={() => {
          if (back.current && ta.current) back.current.scrollTop = ta.current.scrollTop;
        }}
        className={cn(
          'code-metrics relative w-full resize-none overflow-hidden bg-transparent text-transparent caret-foreground outline-none',
          PAD,
          invalid && 'ring-1 ring-inset ring-destructive'
        )}
      />
    </div>
  );
}
