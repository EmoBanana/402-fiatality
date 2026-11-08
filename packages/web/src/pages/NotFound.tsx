import { Link, useLocation } from "react-router";
import { buttonClassName } from "../components/Button";

/** Unknown routes. Styled as the gateway would answer: a status line, then a way back. */
export default function NotFound() {
  const { pathname } = useLocation();
  return (
    <section className="ui-placeholder" aria-labelledby="nf-title">
      <p className="ui-eyebrow">HTTP/1.1 404 Not Found</p>
      <h1 id="nf-title">Nothing lives at this address</h1>
      <p>
        <span className="mono">{pathname}</span> isn't a page here. Agents pay at <span className="mono">/s/&lt;seller&gt;/…</span>; people start in
        the console.
      </p>
      <div className="ui-cluster" style={{ marginTop: 8 }}>
        <Link to="/console" className={buttonClassName({ variant: "primary" })}>
          Open console
        </Link>
        <Link to="/" className={buttonClassName({ variant: "ghost" })}>
          Home
        </Link>
      </div>
    </section>
  );
}
