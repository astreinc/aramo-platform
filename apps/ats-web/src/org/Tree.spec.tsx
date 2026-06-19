import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Tree } from './Tree';
import type { TreeNode } from './types';

// Settings S5c-1 — Tree component spec.
//
// Covers the ARIA tree pattern + multi-parent aria-labels + expand/
// collapse + the per-row Remove action + the empty state.

function makeNode(args: {
  key: string;
  user_id: string;
  display_name?: string;
  email?: string;
  edge_id?: string | null;
  parent_user_id?: string | null;
  children?: readonly TreeNode[];
  depth_capped?: boolean;
  cycle_skipped?: boolean;
}): TreeNode {
  return {
    key: args.key,
    user:
      args.display_name === undefined && args.email === undefined
        ? null
        : {
            user_id: args.user_id,
            email: args.email ?? `${args.user_id}@example.test`,
            display_name: args.display_name ?? null,
            is_active: true,
            deactivated_at: null,
            site_id: null,
            role_keys: [],
          },
    user_id: args.user_id,
    edge_id: args.edge_id ?? null,
    parent_user_id: args.parent_user_id ?? null,
    children: args.children ?? [],
    depth_capped: args.depth_capped ?? false,
    cycle_skipped: args.cycle_skipped ?? false,
  };
}

describe('Tree (S5c-1)', () => {
  it('renders the empty state when there are no roots', () => {
    render(<Tree roots={[]} onRemoveEdge={() => undefined} />);
    expect(screen.getByText(/no reporting relationships/i)).toBeInTheDocument();
  });

  it('renders role="tree" + role="treeitem" per the ARIA tree pattern (ruling 5)', () => {
    const root = makeNode({
      key: 'root:u-a',
      user_id: 'u-a',
      display_name: 'Alice',
    });
    render(<Tree roots={[root]} onRemoveEdge={() => undefined} />);
    expect(screen.getByRole('tree')).toBeInTheDocument();
    expect(screen.getByRole('treeitem')).toBeInTheDocument();
  });

  it('sets aria-level / aria-posinset / aria-setsize on each treeitem', () => {
    const child = makeNode({
      key: 'e1',
      user_id: 'u-b',
      display_name: 'Bob',
      edge_id: 'e1',
      parent_user_id: 'u-a',
    });
    const root = makeNode({
      key: 'root:u-a',
      user_id: 'u-a',
      display_name: 'Alice',
      children: [child],
    });
    render(<Tree roots={[root]} onRemoveEdge={() => undefined} />);

    const rootItem = screen.getByTestId('tree-node-root:u-a');
    expect(rootItem).toHaveAttribute('aria-level', '1');
    expect(rootItem).toHaveAttribute('aria-posinset', '1');
    expect(rootItem).toHaveAttribute('aria-setsize', '1');

    const childItem = screen.getByTestId('tree-node-e1');
    expect(childItem).toHaveAttribute('aria-level', '2');
    expect(childItem).toHaveAttribute('aria-posinset', '1');
    expect(childItem).toHaveAttribute('aria-setsize', '1');
  });

  it('MULTI-PARENT (ruling 2): each occurrence gets a unique DOM id and a parent-context aria-label', () => {
    // Carol under Alice (edge e1) AND under Bob (edge e2).
    const carolUnderAlice = makeNode({
      key: 'e1',
      user_id: 'u-c',
      display_name: 'Carol',
      edge_id: 'e1',
      parent_user_id: 'u-a',
    });
    const carolUnderBob = makeNode({
      key: 'e2',
      user_id: 'u-c',
      display_name: 'Carol',
      edge_id: 'e2',
      parent_user_id: 'u-b',
    });
    const alice = makeNode({
      key: 'root:u-a',
      user_id: 'u-a',
      display_name: 'Alice',
      children: [carolUnderAlice],
    });
    const bob = makeNode({
      key: 'root:u-b',
      user_id: 'u-b',
      display_name: 'Bob',
      children: [carolUnderBob],
    });
    render(<Tree roots={[alice, bob]} onRemoveEdge={() => undefined} />);

    // Two SEPARATE treeitems for Carol — unique DOM ids.
    const carolNodes = [
      screen.getByTestId('tree-node-e1'),
      screen.getByTestId('tree-node-e2'),
    ];
    expect(carolNodes[0]?.id).not.toBe(carolNodes[1]?.id);

    // The aria-labels disambiguate by parent context.
    expect(carolNodes[0]?.getAttribute('aria-label')).toMatch(
      /Carol \(reports to Alice\)/,
    );
    expect(carolNodes[1]?.getAttribute('aria-label')).toMatch(
      /Carol \(reports to Bob\)/,
    );
  });

  it('clicking the expand toggle collapses + restores children', () => {
    const child = makeNode({
      key: 'e1',
      user_id: 'u-b',
      display_name: 'Bob',
      edge_id: 'e1',
    });
    const root = makeNode({
      key: 'root:u-a',
      user_id: 'u-a',
      display_name: 'Alice',
      children: [child],
    });
    render(<Tree roots={[root]} onRemoveEdge={() => undefined} />);

    expect(screen.getByText('Bob')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Collapse'));
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Expand'));
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('clicking Remove on a non-root invokes onRemoveEdge with the edge_id', () => {
    const onRemoveEdge = vi.fn();
    const child = makeNode({
      key: 'e1',
      user_id: 'u-b',
      display_name: 'Bob',
      edge_id: 'e1',
    });
    const root = makeNode({
      key: 'root:u-a',
      user_id: 'u-a',
      display_name: 'Alice',
      children: [child],
    });
    render(<Tree roots={[root]} onRemoveEdge={onRemoveEdge} />);

    fireEvent.click(screen.getByTestId('tree-remove-e1'));
    expect(onRemoveEdge).toHaveBeenCalledWith('e1');
  });

  it('roots have NO Remove button (no edge above)', () => {
    const root = makeNode({
      key: 'root:u-a',
      user_id: 'u-a',
      display_name: 'Alice',
    });
    render(<Tree roots={[root]} onRemoveEdge={() => undefined} />);
    expect(screen.queryByText('Remove')).not.toBeInTheDocument();
  });

  it('depth_capped nodes render a "depth limit" helper hint', () => {
    const capped = makeNode({
      key: 'e1',
      user_id: 'u-b',
      display_name: 'Bob',
      edge_id: 'e1',
      depth_capped: true,
    });
    render(<Tree roots={[capped]} onRemoveEdge={() => undefined} />);
    expect(screen.getByText(/depth limit/i)).toBeInTheDocument();
  });

  it('cycle_skipped nodes render an "already shown above" hint', () => {
    const cyc = makeNode({
      key: 'e1',
      user_id: 'u-b',
      display_name: 'Bob',
      edge_id: 'e1',
      cycle_skipped: true,
    });
    render(<Tree roots={[cyc]} onRemoveEdge={() => undefined} />);
    expect(screen.getByText(/already shown above/i)).toBeInTheDocument();
  });

  it('renders the raw user_id when user is null (the 403-fallback path)', () => {
    const root = makeNode({
      key: 'root:u-alice',
      user_id: 'u-alice',
    });
    render(<Tree roots={[root]} onRemoveEdge={() => undefined} />);
    expect(screen.getByText('u-alice')).toBeInTheDocument();
  });
});
