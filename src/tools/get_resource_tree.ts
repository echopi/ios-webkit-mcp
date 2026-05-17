import { z } from 'zod';
import { PageSession } from '../page-session.js';

interface FrameLike {
  id: string;
  parentId?: string;
  loaderId?: string;
  url?: string;
  securityOrigin?: string;
  mimeType?: string;
  name?: string;
}
interface ResourceLike {
  url: string;
  type: string;
  mimeType?: string;
  contentSize?: number;
  failed?: boolean;
}
interface FrameTreeNode {
  frame: FrameLike;
  childFrames?: FrameTreeNode[];
  resources?: ResourceLike[];
}
interface ResourceTreeResult {
  frameTree: FrameTreeNode;
}

export const getResourceTreeTool = {
  name: 'get_resource_tree',
  description: [
    'Return the frame + resource tree of the inspected iOS WebView page via WIP `Page.getResourceTree`.',
    'Useful for multi-frame pages (iframes) — see exactly which frame loaded which resources, their URLs, mime types, sizes, and load failures.',
    'Probe-confirmed (2026-05-16): `Page.getResourceTree` is one of the rare `Page.*` methods present on WIP. Returns the full frame hierarchy in one call.',
  ].join(' '),

  inputSchema: {
    resourceUrlSubstring: z
      .string()
      .optional()
      .describe('Case-insensitive substring filter on resource URLs (default: include all).'),
    maxResourcesPerFrame: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe('Cap resources rendered per frame (default 50).'),
  },

  handler: async ({
    resourceUrlSubstring,
    maxResourcesPerFrame = 50,
  }: { resourceUrlSubstring?: string; maxResourcesPerFrame?: number }) => {
    let ps: PageSession;
    try {
      ps = await PageSession.get();
    } catch (e) {
      return errorResult(`Unable to attach to a WKWebView page: ${describe(e)}`);
    }

    let result: ResourceTreeResult;
    try {
      result = await ps.session.send<ResourceTreeResult>('Page.getResourceTree', undefined, 10_000);
    } catch (e) {
      return errorResult(`Page.getResourceTree failed: ${describe(e)}`);
    }

    const lines: string[] = [];
    let totalFrames = 0;
    let totalResources = 0;
    const needle = resourceUrlSubstring?.toLowerCase();
    const renderFrame = (node: FrameTreeNode, depth: number): void => {
      totalFrames++;
      const indent = '  '.repeat(depth);
      const f = node.frame;
      lines.push(`${indent}- frame \`${f.id}\`${f.name ? ` (name=${f.name})` : ''} · ${f.mimeType ?? '?'}`);
      lines.push(`${indent}  URL: ${f.url ?? '(no url)'}`);
      if (f.securityOrigin) lines.push(`${indent}  origin: ${f.securityOrigin}`);
      let resources = node.resources ?? [];
      if (needle) resources = resources.filter(r => r.url.toLowerCase().includes(needle));
      const shown = resources.slice(0, maxResourcesPerFrame);
      totalResources += resources.length;
      if (shown.length > 0) {
        lines.push(`${indent}  resources (${shown.length}${resources.length > shown.length ? `/${resources.length} shown` : ''}):`);
        for (const r of shown) {
          const tag = r.failed ? '✗ failed' : '✓';
          lines.push(`${indent}    ${tag} ${r.type}${r.mimeType ? '/' + r.mimeType : ''}${r.contentSize != null ? ` · ${r.contentSize}B` : ''} · ${r.url}`);
        }
      }
      for (const child of node.childFrames ?? []) renderFrame(child, depth + 1);
    };

    lines.push(`# get_resource_tree`);
    lines.push('');
    renderFrame(result.frameTree, 0);
    lines.unshift(`Total frames: ${totalFrames}  ·  resources${needle ? ` (filtered "${resourceUrlSubstring}")` : ''}: ${totalResources}`);
    lines.unshift('');

    return textResult(lines.join('\n'));
  },
};

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}
function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
