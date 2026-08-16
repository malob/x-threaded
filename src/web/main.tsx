import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { createQueryClient } from "./queries";

/**
 * Without this, a throw anywhere in the render tree unmounts the whole app and
 * leaves a white page with the reason only in the console. Say what broke and
 * offer the one action that helps.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state: { message: string | null } = { message: null };

  static getDerivedStateFromError(error: Error): { message: string } {
    return { message: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.message === null) return this.props.children;
    return (
      <main>
        <div className="error" role="alert">
          <p>Something went wrong displaying this page — {this.state.message}</p>
          <button onClick={() => location.reload()}>Reload</button>
        </div>
      </main>
    );
  }
}

// One client for the page: the cache is where conversations live between
// views, so it must outlive any component that shows them.
const queryClient = createQueryClient();

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");
createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
