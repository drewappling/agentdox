import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import { visit } from 'unist-util-visit';

// Only allow benign URL schemes. remark-rehype escapes raw HTML but passes link/image
// URLs through as-is, so a doc like `[x](javascript:alert(1))` would otherwise reach {@html}.
const SAFE_URL = /^(https?:|mailto:|#|\/|\.|data:image\/(png|jpe?g|gif|webp);)/i;

function rehypeSafeUrls() {
  return (tree: any) => {
    visit(tree, 'element', (node: any) => {
      const p = node.properties ?? {};
      if (node.tagName === 'a' && typeof p.href === 'string' && !SAFE_URL.test(p.href)) p.href = undefined;
      if (node.tagName === 'img' && typeof p.src === 'string' && !SAFE_URL.test(p.src)) p.src = undefined;
    });
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype)
  .use(rehypeSafeUrls)
  .use(rehypeSlug)
  .use(rehypeAutolinkHeadings, { behavior: 'wrap' })
  .use(rehypeKatex)
  .use(rehypeHighlight)
  .use(rehypeStringify);

/** Render markdown to an HTML string (client-side, static). URLs are scheme-sanitized. */
export async function renderMarkdown(md: string): Promise<string> {
  const file = await processor.process(md);
  return String(file);
}
