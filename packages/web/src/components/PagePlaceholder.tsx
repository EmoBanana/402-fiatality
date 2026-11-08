/** Phase 0 stand-in for pages that Phase 1 builders replace. */
export function PagePlaceholder({ title, description }: { title: string; description: string }) {
  return (
    <section className="ui-placeholder">
      <h1>{title}</h1>
      <p>{description}</p>
    </section>
  );
}
