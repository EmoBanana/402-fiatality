import { isRouteErrorResponse, Link, useRouteError } from "react-router";
import { buttonClassName } from "../components/Button";
import { EmptyState } from "../components/EmptyState";

/** Rendered by the router when a page throws or fails to load. */
export default function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "Something went wrong.";
  return (
    <div style={{ padding: "64px 24px" }}>
      <EmptyState
        title="This page hit an error"
        description={message}
        action={
          <Link to="/" className={buttonClassName({ variant: "secondary" })}>
            Back to start
          </Link>
        }
      />
    </div>
  );
}
