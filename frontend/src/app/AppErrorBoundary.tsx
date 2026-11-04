import { Component, createRef } from 'react';
import type { ReactNode } from 'react';

export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  private heading = createRef<HTMLHeadingElement>();

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    document.title = 'Something went wrong | Commerce Lab';
    this.heading.current?.focus();
  }

  render() {
    if (this.state.failed) {
      return (
        <main id="main-content" className="content">
          <section className="surface" role="alert">
            <h1 ref={this.heading} tabIndex={-1}>Something went wrong</h1>
            <p>Reload the page to try again.</p>
            <button type="button" onClick={() => window.location.reload()}>
              Reload page
            </button>
            <p><a href="/">Return home</a></p>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}
