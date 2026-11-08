/** Spinner for loading states. <Spinner /> or <Spinner size={24} label="Loading tabs" /> */
export function Spinner({ size = 16, label = "Loading" }: { size?: number; label?: string }) {
  return <span className="ui-spinner" role="status" aria-label={label} style={{ width: size, height: size }} />;
}
