import { isRouteErrorResponse, Link, useRouteError } from "react-router";
import { buttonClassName } from "../components/Button";
import { EmptyState } from "../components/EmptyState";

/**
 * Rendered by the router when a page throws or its code fails to load (e.g. a stale tab after a rebuild).
 * It replaces the whole shell, so it carries its own way out.
 */
export default function RouteError() {
  const error = useRouteError();
  const chunkFailed = error instanceof Error && /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(error.message);
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : chunkFailed
      ? "This page's code changed since you opened the app. Reload to get the new version."
      : error instanceof Error
        ? error.message
        : "Something went wrong.";
  return (
    <div style={{ padding: "96px 24px" }}>
      <EmptyState
        tone="danger"
        title="This page hit an error"
        description={message}
        action={
          <>
            <button type="button" className={buttonClassName({ variant: "primary" })} onClick={() => window.location.reload()}>
              Reload
            </button>
            <Link to="/" className={buttonClassName({ variant: "secondary" })} reloadDocument>
              Back to start
            </Link>
          </>
        }
      />
    </div>
  );
}
