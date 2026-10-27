import { Component } from 'react';
import type { ReactNode } from 'react';
import { messageOf, useViewerHealth } from './viewer-health';
import type { ViewerProblem } from './viewer-health';

interface GuardProps<T> {
  /** What the children are drawn from (a scene object: identity changes with every edit). */
  value: T;
  source: ViewerProblem['source'];
  /** Draws `value`. May throw while rendering. */
  children: (value: T) => ReactNode;
}

interface GuardState<T> {
  error: unknown;
  /** The value whose drawing failed (null until `componentDidCatch` ran). */
  failedFor: T | null;
}

/**
 * Error boundary for one part of the 3D view. When drawing `value` throws it
 * - keeps drawing the last value that worked (if any), so the flat does not vanish,
 * - reports the problem to `useViewerHealth` (a visible banner), and
 * - tries again as soon as `value` changes (the next edit).
 * Without it a throw in the shell build unmounts the whole canvas and leaves nothing but the page background.
 */
export class ViewerGuard<T extends object> extends Component<GuardProps<T>, GuardState<T>> {
  override state: GuardState<T> = { error: null, failedFor: null };
  private good: T | null = null;

  static getDerivedStateFromError(error: unknown): Partial<GuardState<never>> {
    return { error };
  }

  static getDerivedStateFromProps<T extends object>(props: GuardProps<T>, state: GuardState<T>): Partial<GuardState<T>> | null {
    if (state.error && state.failedFor !== null && state.failedFor !== props.value) return { error: null, failedFor: null };
    return null;
  }

  override componentDidCatch(error: unknown): void {
    this.setState({ failedFor: this.props.value });
    useViewerHealth.getState().report({ source: this.props.source, message: messageOf(error), keptLastGood: this.good !== null });
  }

  override componentDidMount(): void {
    this.good = this.props.value;
  }

  override componentDidUpdate(): void {
    if (this.state.error) return;
    this.good = this.props.value;
    useViewerHealth.getState().clear(this.props.source);
  }

  override render(): ReactNode {
    const { children, value } = this.props;
    if (!this.state.error) return children(value);
    return this.good === null ? null : <Quiet>{children(this.good)}</Quiet>;
  }
}

/** Innermost boundary of the fallback: the last good value failing too just draws nothing. */
class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
