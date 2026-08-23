import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Safe markdown renderer used across the app (chat, work-item details, plans).
 * react-markdown does not render raw HTML, so agent-authored content is XSS-safe.
 * Styling piggybacks on @tailwindcss/typography's `prose` with dark-mode tweaks
 * tuned for compact surfaces like chat bubbles.
 */
export function Markdown({
  content,
  className = '',
}: {
  content: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={`prose prose-sm max-w-none break-words prose-p:my-1.5 prose-headings:mb-1.5 prose-headings:mt-2 prose-pre:my-2 prose-pre:bg-surface-3 prose-code:rounded prose-code:bg-surface-3 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:before:content-[''] prose-code:after:content-[''] prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 ${className}`}
      data-testid="markdown"
      // Drive typography colors from the Catppuccin theme tokens so text stays
      // legible in BOTH themes (prose-invert would be near-white on Latte).
      style={
        {
          '--tw-prose-body': 'rgb(var(--ct-t2))',
          '--tw-prose-headings': 'rgb(var(--ct-t1))',
          '--tw-prose-bold': 'rgb(var(--ct-t1))',
          '--tw-prose-links': 'rgb(var(--ct-accent-text))',
          '--tw-prose-code': 'rgb(var(--ct-t1))',
          '--tw-prose-quotes': 'rgb(var(--ct-t2))',
          '--tw-prose-bullets': 'rgb(var(--ct-t4))',
          '--tw-prose-counters': 'rgb(var(--ct-t4))',
          '--tw-prose-hr': 'rgb(var(--ct-border))',
          '--tw-prose-quote-borders': 'rgb(var(--ct-border))',
          '--tw-prose-th-borders': 'rgb(var(--ct-border))',
          '--tw-prose-td-borders': 'rgb(var(--ct-border))',
          '--tw-prose-captions': 'rgb(var(--ct-t4))',
        } as React.CSSProperties
      }
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
