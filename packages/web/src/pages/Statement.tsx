import { useParams } from "react-router";
import { PagePlaceholder } from "../components/PagePlaceholder";

export default function Statement() {
  const { tabId } = useParams();
  return <PagePlaceholder title="Statement" description={`Printable statement for tab ${tabId ?? ""}: per-seller lines, voids and fees.`} />;
}
