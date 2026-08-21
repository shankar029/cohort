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
      className={`prose prose-sm prose-invert max-w-none break-words prose-p:my-1.5 prose-headings:mb-1.5 prose-headings:mt-2 prose-pre:my-2 prose-pre:bg-surface-3 prose-code:rounded prose-code:bg-surface-3 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:before:content-[''] prose-code:after:content-[''] prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-a:text-accent-400 ${className}`}
      data-testid="markdown"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
