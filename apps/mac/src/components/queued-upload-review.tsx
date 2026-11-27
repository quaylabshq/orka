import { useProductView } from "./desktop-usage.js";
import { invoke } from "./product-command.js";
import { useEffect, useRef, useState } from "react";
import { Button } from "./button.js";
import { Modal } from "./modal.js";
import { FileReview } from "./file-review.js";
import type { FileManifestEntry } from "./diff-model.js";
import { handleReviewTab } from "./review-focus.js";

interface UploadPreview {
  previewToken: string;
  title: string;
  revision: number;
  before: Record<string, string>;
  files: Record<string, string>;
  beforeManifest: FileManifestEntry[];
  afterManifest: FileManifestEntry[];
  note: string;
}

export function QueuedUploadReview({
  input,
  title,
  stale,
  parentBusy,
  onClose,
  onRefresh,
  onNotice,
}: {
  input: {
    accountId: string | null;
    serviceOrigin?: string;
    projectId: string;
    resourceId: string;
    uploadId: string;
  };
  title: string;
  stale: boolean;
  parentBusy: boolean;
  onClose: () => void;
  onRefresh: () => Promise<unknown>;
  onNotice: (message: string) => void;
}) {
  const [preview, setPreview] = useState<UploadPreview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(true);
  const submitting = useRef(false);
  const current = useRef(!stale);
  current.current = !stale;
  const { accountId, serviceOrigin, projectId, resourceId, uploadId } = input;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setPreview(null);
    void invoke<UploadPreview>("resource_command", {
      action: "preview-upload",
      input: { accountId, serviceOrigin, projectId, resourceId, uploadId },
    })
      .then((result) => {
        if (!cancelled && current.current) setPreview(result);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(String(failure));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, accountId, serviceOrigin, projectId, resourceId, uploadId]);
  useProductView(preview ? "upload_review_viewed" : undefined, resourceId);
  const submit = async () => {
    if (submitting.current || !preview || stale || parentBusy) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await invoke("resource_command", {
        action: "retry-upload",
        input: { ...input, previewToken: preview.previewToken },
      });
      if (!mounted.current || !current.current) return;
      onNotice("Reviewed plan update queued");
      await onRefresh();
      if (mounted.current) onClose();
    } catch (failure: unknown) {
      if (mounted.current) {
        setError(String(failure));
        setPreview(null);
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <Modal
      title="Review queued upload"
      className="changes-review-modal"
      onClose={() => {
        if (!busy) onClose();
      }}
      onEscapeKeyDown={(event) => {
        if (busy) event.preventDefault();
      }}
      onKeyDownCapture={handleReviewTab}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        const resource = document.querySelector<HTMLElement>(
          `button[data-resource-id="${CSS.escape(resourceId)}"]`,
        );
        (
          resource ??
          document.querySelector<HTMLElement>(".workspace-header .sync-status")
        )?.focus();
      }}
      size="wide"
      closeLabel="Close queued upload review"
      closeDisabled={busy}
      footer={
        <>
          {!loading && !preview && !stale && (
            <Button
              size="sm"
              disabled={busy || parentBusy}
              onClick={() => setAttempt((value) => value + 1)}
            >
              Review latest version
            </Button>
          )}
          <Button
            size="sm"
            variant="tertiary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy || parentBusy || loading || !preview || stale}
            aria-busy={busy}
            onClick={() => void submit()}
          >
            {busy ? "Queuing update…" : "Queue reviewed update"}
          </Button>
        </>
      }
    >
      <div className="changes-review-body">
        <div className="review-versions" aria-label="Compared versions">
          <span className="version-pill">
            {preview ? `Shared version ${preview.revision}` : "Shared version"}
          </span>
          <span aria-hidden="true">to</span>
          <span className="sr-only">compared with</span>
          <span className="version-pill">Queued snapshot</span>
        </div>
        <h3>{preview?.title ?? title}</h3>
        {stale ? (
          <p role="alert">
            This item or account changed. Close this review and open the upload
            again.
          </p>
        ) : (
          <>
            {error && <p role="alert">{error}</p>}
            {loading && (
              <p role="status">Loading the current shared version…</p>
            )}
            {preview && (
              <>
                <p>{preview.note}</p>
                <FileReview
                  before={preview.before}
                  files={preview.files}
                  beforeManifest={preview.beforeManifest}
                  afterManifest={preview.afterManifest}
                />
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
