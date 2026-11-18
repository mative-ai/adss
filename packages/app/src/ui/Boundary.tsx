/**
 * The edge of an error in rendering (Phase 4, the error state): a component that throws takes down its
 * subtree and shows the fallback in its place, not a blank page. The worker's own failures are not this: the store keeps
 * them as state, and the screen shows them without a throw.
 */
import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback: (error: Error) => ReactNode;
}

export class Boundary extends Component<Props, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override render(): ReactNode {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}
