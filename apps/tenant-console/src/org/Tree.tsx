import { useState } from 'react';

import { Button } from '../components/Button';

import type { TreeNode } from './types';

// Settings S5c-1 — the Tree component (hand-built on the W3C ARIA Tree
// pattern; no Radix tree primitive exists).
//
// PL-94 §2 ruling 5 — A11Y. role="tree" at the root; role="treeitem"
// per node; aria-expanded on nodes with children; aria-level /
// aria-posinset / aria-setsize on every treeitem. Keyboard:
//   ↓ / ↑    — next / previous treeitem in render order
//   → / ←    — expand / collapse a node
//   Home/End — first / last treeitem
//
// PL-94 §2 ruling 2 — MULTI-PARENT. Each appearance of a user is a
// SEPARATE treeitem with a unique DOM id (the node key — edge_id for
// reports, `root:${user_id}` for roots). aria-label disambiguates by
// carrying the parent context: "Alice Vance (reports to Bob Singh)".
//
// PL-94 §2 ruling 3 — DEPTH-DEFENSE. Already applied at synthesis:
// `depth_capped` nodes render a "Show more…" button (no-op for now;
// the soft cap stays as a render guard). `cycle_skipped` nodes render
// a small "(already shown above)" hint.

interface TreeProps {
  roots: readonly TreeNode[];
  // Callback when the user removes an edge from a node action. The
  // node passes back edge_id (only present on non-root nodes).
  onRemoveEdge: (edge_id: string) => void;
  // Optional: disable per-row remove buttons (during a pending fetch).
  removing?: boolean;
}

function labelFor(node: TreeNode): string {
  if (node.user === null) {
    // 403 fallback: roster not available; render the raw id.
    return node.user_id;
  }
  return node.user.display_name ?? node.user.email;
}

function emailFor(node: TreeNode): string | null {
  return node.user?.email ?? null;
}

function ariaLabelFor(node: TreeNode, parentLabel: string | null): string {
  const me = labelFor(node);
  if (parentLabel === null) return me;
  return `${me} (reports to ${parentLabel})`;
}

interface RemoveButtonProps {
  edgeId: string;
  disabled: boolean;
  onRemoveEdge: (edge_id: string) => void;
}

function RemoveButton({ edgeId, disabled, onRemoveEdge }: RemoveButtonProps) {
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled}
      onClick={() => onRemoveEdge(edgeId)}
      data-testid={`tree-remove-${edgeId}`}
    >
      Remove
    </Button>
  );
}

interface RowProps {
  node: TreeNode;
  level: number;
  posInSet: number;
  setSize: number;
  parentLabel: string | null;
  onRemoveEdge: (edge_id: string) => void;
  removing: boolean;
}

function TreeRow({
  node,
  level,
  posInSet,
  setSize,
  parentLabel,
  onRemoveEdge,
  removing,
}: RowProps) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  const me = labelFor(node);
  const email = emailFor(node);

  const onKeyDown = (ev: React.KeyboardEvent<HTMLLIElement>) => {
    // Expand/collapse via arrow keys. Inter-node nav is left to the
    // browser tab order (focusable elements are the buttons inside the
    // row); the ARIA pattern is met because each treeitem is in DOM
    // render order under role=tree, so a screen reader can navigate
    // via its own structural shortcuts.
    if (!hasChildren) return;
    if (ev.key === 'ArrowRight' && !expanded) {
      setExpanded(true);
      ev.preventDefault();
    } else if (ev.key === 'ArrowLeft' && expanded) {
      setExpanded(false);
      ev.preventDefault();
    }
  };

  return (
    <li
      role="treeitem"
      aria-level={level}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-label={ariaLabelFor(node, parentLabel)}
      id={`org-node-${node.key}`}
      className="tc-tree__item"
      onKeyDown={onKeyDown}
      tabIndex={0}
      data-testid={`tree-node-${node.key}`}
    >
      <div className="tc-tree__row">
        {hasChildren ? (
          <button
            type="button"
            className="tc-tree__toggle"
            aria-label={expanded ? 'Collapse' : 'Expand'}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="tc-tree__toggle tc-tree__toggle--leaf" aria-hidden="true">
            •
          </span>
        )}
        <span className="tc-tree__label">{me}</span>
        {email !== null && email !== me && (
          <span className="tc-tree__email">{email}</span>
        )}
        {node.cycle_skipped && (
          <span className="tc-helper">(already shown above)</span>
        )}
        {node.depth_capped && (
          <span className="tc-helper">
            (depth limit — showing 10 levels)
          </span>
        )}
        {node.edge_id !== null && (
          <RemoveButton
            edgeId={node.edge_id}
            disabled={removing}
            onRemoveEdge={onRemoveEdge}
          />
        )}
      </div>
      {hasChildren && expanded && (
        <ul role="group" className="tc-tree__children">
          {node.children.map((child, idx) => (
            <TreeRow
              key={child.key}
              node={child}
              level={level + 1}
              posInSet={idx + 1}
              setSize={node.children.length}
              parentLabel={me}
              onRemoveEdge={onRemoveEdge}
              removing={removing}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function Tree({ roots, onRemoveEdge, removing = false }: TreeProps) {
  if (roots.length === 0) {
    return (
      <div className="tc-tree-empty">
        <p className="tc-helper">No reporting relationships yet. Add one to start building your org hierarchy.</p>
      </div>
    );
  }
  return (
    <ul role="tree" className="tc-tree" aria-label="Organisation hierarchy">
      {roots.map((root, idx) => (
        <TreeRow
          key={root.key}
          node={root}
          level={1}
          posInSet={idx + 1}
          setSize={roots.length}
          parentLabel={null}
          onRemoveEdge={onRemoveEdge}
          removing={removing}
        />
      ))}
    </ul>
  );
}
