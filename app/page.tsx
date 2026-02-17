"use client";

import Image from "next/image";
import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";

const fallbackModels = ["gpt-5", "claude-sonnet-4.5"];
const maxUploadSizeBytes = 5 * 1024 * 1024;
const acceptedImageTypes = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);

type ServerLogEntry = {
  at: string;
  step: string;
  detail?: string;
};

type ActivityLogEntry = {
  at: string;
  source: "client" | "server";
  message: string;
};

type VideoMetadata = {
  title: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
};

type ApiVariantSuccess = {
  variantId: string;
  styleName: string;
  styleBrief: string;
  status: "succeeded";
  jobId: string;
  videoUrl: string;
  metadata: VideoMetadata;
};

type ApiVariantFailure = {
  variantId: string;
  styleName: string;
  styleBrief: string;
  status: "failed";
  error: string;
};

type ApiVariant = ApiVariantSuccess | ApiVariantFailure;
type VariantCountOption = 1 | 4;

type ApiSuccessResponse = {
  ok: true;
  requestId?: string;
  jobId: string;
  videoUrl: string;
  metadata: VideoMetadata;
  variants?: ApiVariant[];
  logs?: ServerLogEntry[];
};

type ApiErrorResponse = {
  ok: false;
  requestId?: string;
  error: string;
  variants?: ApiVariant[];
  logs?: ServerLogEntry[];
  stack?: string;
};

type ApiResponse = ApiSuccessResponse | ApiErrorResponse;

type ModelsResponse = {
  ok: boolean;
  models?: string[];
};

type RenderHistoryItem = {
  id: string;
  fileName: string;
  videoUrl: string;
  createdAt: string;
  sizeBytes: number;
};

type RendersResponse = {
  ok: boolean;
  items?: RenderHistoryItem[];
};

async function parseResponseJson<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type") || "";
  const rawBody = await response.text();

  if (!contentType.toLowerCase().includes("application/json")) {
    const snippet = rawBody.slice(0, 180).replace(/\s+/g, " ").trim();
    throw new Error(`Server returned non-JSON response (${response.status}). ${snippet}`);
  }

  try {
    return JSON.parse(rawBody) as T;
  } catch {
    const snippet = rawBody.slice(0, 180).replace(/\s+/g, " ").trim();
    throw new Error(`Server returned invalid JSON (${response.status}). ${snippet}`);
  }
}

function formatVideoDuration(metadata: VideoMetadata): string {
  return `${(metadata.durationInFrames / metadata.fps).toFixed(1)}s`;
}

function isVariantSuccess(variant: ApiVariant): variant is ApiVariantSuccess {
  return variant.status === "succeeded";
}

export default function HomePage() {
  const [prompt, setPrompt] = useState(
    "A bold motion-graphics intro for a tech launch: neon gradients, kinetic typography, and smooth scene transitions."
  );
  const [model, setModel] = useState("gpt-5");
  const [variantCount, setVariantCount] = useState<VariantCountOption>(1);
  const [modelOptions, setModelOptions] = useState<string[]>(fallbackModels);
  const [isModelsLoading, setIsModelsLoading] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApiSuccessResponse | null>(null);
  const [activityLogs, setActivityLogs] = useState<ActivityLogEntry[]>([]);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyItems, setHistoryItems] = useState<RenderHistoryItem[]>([]);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageFileName, setImageFileName] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [selectedVariant, setSelectedVariant] = useState<ApiVariant | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  const addClientLog = (message: string) => {
    setActivityLogs((previous) => [
      ...previous,
      {
        at: new Date().toISOString(),
        source: "client",
        message
      }
    ]);
  };

  const appendServerLogs = (logs: ServerLogEntry[] | undefined) => {
    if (!logs || logs.length === 0) {
      return;
    }

    setActivityLogs((previous) => [
      ...previous,
      ...logs.map((entry) => ({
        at: entry.at,
        source: "server" as const,
        message: entry.detail ? `${entry.step}: ${entry.detail}` : entry.step
      }))
    ]);
  };

  useEffect(() => {
    let isMounted = true;

    async function loadModels() {
      try {
        const response = await fetch("/api/models");
        const data = await parseResponseJson<ModelsResponse>(response);
        const models = Array.isArray(data.models) ? data.models.filter((m) => typeof m === "string" && m.length > 0) : [];

        if (!isMounted) return;

        if (models.length > 0) {
          setModelOptions(models);
          setModel((currentModel) => (models.includes(currentModel) ? currentModel : models[0]));
        } else {
          setModelOptions(fallbackModels);
        }
      } catch {
        if (!isMounted) return;
        setModelOptions(fallbackModels);
      } finally {
        if (isMounted) {
          setIsModelsLoading(false);
        }
      }
    }

    void loadModels();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!isHistoryOpen) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsHistoryOpen(false);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isHistoryOpen]);

  useEffect(() => {
    if (!selectedVariant) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedVariant(null);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [selectedVariant]);

  const displayVariants = useMemo<ApiVariant[]>(() => {
    if (!result) return [];

    if (Array.isArray(result.variants) && result.variants.length > 0) {
      return result.variants;
    }

    return [
      {
        variantId: "style-1",
        styleName: "Primary",
        styleBrief: "Legacy single-style response.",
        status: "succeeded" as const,
        jobId: result.jobId,
        videoUrl: result.videoUrl,
        metadata: result.metadata
      }
    ];
  }, [result]);

  const successfulVariantCount = useMemo(() => {
    return displayVariants.filter(isVariantSuccess).length;
  }, [displayVariants]);

  const hasMultipleVariants = displayVariants.length > 1;
  const singleVariant = hasMultipleVariants ? null : displayVariants[0];

  async function loadHistory() {
    setIsHistoryLoading(true);
    setHistoryError(null);

    try {
      const response = await fetch("/api/renders");
      const data = await parseResponseJson<RendersResponse>(response);

      if (!response.ok || !data.ok) {
        throw new Error("Failed to load generated videos.");
      }

      setHistoryItems(Array.isArray(data.items) ? data.items : []);
    } catch (loadError) {
      setHistoryError(loadError instanceof Error ? loadError.message : "Failed to load generated videos.");
    } finally {
      setIsHistoryLoading(false);
    }
  }

  function openHistoryModal() {
    setIsHistoryOpen(true);
    void loadHistory();
  }

  function closeHistoryModal() {
    setIsHistoryOpen(false);
  }

  function closeVariantModal() {
    setSelectedVariant(null);
  }

  async function onImageChange(event: ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.target.files?.[0];

    if (!selectedFile) {
      return;
    }

    if (!acceptedImageTypes.has(selectedFile.type)) {
      setImageError("Please upload a PNG, JPG, WEBP, or GIF image.");
      return;
    }

    if (selectedFile.size > maxUploadSizeBytes) {
      setImageError("Image is too large. Max upload size is 5 MB.");
      return;
    }

    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === "string") {
            resolve(reader.result);
            return;
          }
          reject(new Error("Failed to read uploaded image."));
        };
        reader.onerror = () => reject(new Error("Failed to read uploaded image."));
        reader.readAsDataURL(selectedFile);
      });

      setImageError(null);
      setImageDataUrl(dataUrl);
      setImageFileName(selectedFile.name);
      addClientLog(`Image selected: ${selectedFile.name}`);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "Failed to process uploaded image.";
      setImageError(message);
    }
  }

  function clearImage() {
    setImageDataUrl(null);
    setImageFileName(null);
    setImageError(null);
    if (imageInputRef.current) {
      imageInputRef.current.value = "";
    }
    addClientLog("Uploaded image cleared.");
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setIsLoading(true);
    setError(null);
    setSelectedVariant(null);
    setActivityLogs([]);
    addClientLog("Generate button clicked.");
    addClientLog(`Submitting request to /api/generate with model "${model}" (${variantCount} style${variantCount > 1 ? "s" : ""}).`);
    if (imageDataUrl) {
      addClientLog(`Including uploaded image "${imageFileName || "image"}".`);
    }

    try {
      const payload: { prompt: string; model: string; variantCount: VariantCountOption; imageDataUrl?: string } = {
        prompt,
        model,
        variantCount
      };

      if (imageDataUrl) {
        payload.imageDataUrl = imageDataUrl;
      }

      const response = await fetch("/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const data = await parseResponseJson<ApiResponse>(response);
      appendServerLogs(data.logs);

      if (!response.ok || !data.ok) {
        addClientLog("Generation failed.");
        throw new Error(data.ok ? "Generation failed." : data.error);
      }

      setResult(data);
      const variants = Array.isArray(data.variants) && data.variants.length > 0
        ? data.variants
        : [
            {
              variantId: "style-1",
              styleName: "Primary",
              styleBrief: "Legacy single-style response.",
              status: "succeeded" as const,
              jobId: data.jobId,
              videoUrl: data.videoUrl,
              metadata: data.metadata
            }
          ];
      const succeededCount = variants.filter((variant) => variant.status === "succeeded").length;

      addClientLog(`${succeededCount}/${variants.length} variants completed.`);
      addClientLog(`First ready video at ${data.videoUrl}.`);
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "Unknown error.";
      addClientLog(`Error: ${message}`);
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }

  function formatBytes(sizeBytes: number): string {
    if (sizeBytes < 1024) return `${sizeBytes} B`;
    if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <main className="page-shell">
      <section className="panel">
        <div className="panel-header">
          <div className="panel-top-row">
            <p className="eyebrow">Copilot SDK + Remotion</p>
            <button type="button" className="history-button" onClick={openHistoryModal}>
              History
            </button>
          </div>
          <h1>Prompt To Video Studio</h1>
          <p className="subtitle">
            Type a concept, let Copilot author the Remotion composition, and render either one style or four alternatives.
          </p>
        </div>

        <form className="prompt-form" onSubmit={onSubmit}>
          <label className="field-label" htmlFor="prompt">
            Video Prompt
          </label>
          <textarea
            id="prompt"
            className="prompt-input"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={6}
            required
          />

          <div className="upload-group">
            <label className="field-label" htmlFor="image-upload">
              Optional Image
            </label>
            <div className="upload-row">
              <input
                id="image-upload"
                className="upload-input"
                type="file"
                accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
                ref={imageInputRef}
                onChange={onImageChange}
              />
              {imageDataUrl ? (
                <button type="button" className="clear-image-button" onClick={clearImage}>
                  Clear
                </button>
              ) : null}
            </div>
            {imageFileName ? <p className="upload-meta">Selected: {imageFileName}</p> : null}
            {imageError ? <p className="upload-error">{imageError}</p> : null}
            {imageDataUrl ? (
              <Image
                className="upload-preview"
                src={imageDataUrl}
                alt={imageFileName || "Uploaded image"}
                width={240}
                height={160}
                unoptimized
              />
            ) : null}
          </div>

          <div className="form-row">
            <div className="settings-grid">
              <div className="model-group">
                <label className="field-label" htmlFor="model">
                  Copilot Model
                </label>
                <select
                  id="model"
                  className="model-input"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  disabled={isModelsLoading}
                >
                  {isModelsLoading ? <option value={model}>Loading models...</option> : null}
                  {modelOptions.map((modelOption) => (
                    <option key={modelOption} value={modelOption}>
                      {modelOption}
                    </option>
                  ))}
                </select>
              </div>

              <div className="model-group">
                <label className="field-label" htmlFor="variant-count">
                  Style Count
                </label>
                <select
                  id="variant-count"
                  className="model-input"
                  value={String(variantCount)}
                  onChange={(event) => setVariantCount(Number(event.target.value) as VariantCountOption)}
                  disabled={isLoading}
                >
                  <option value="1">1 style</option>
                  <option value="4">4 styles</option>
                </select>
              </div>
            </div>

            <button
              className={`generate-button${isLoading ? " is-loading" : ""}`}
              type="submit"
              disabled={isLoading}
              aria-busy={isLoading}
            >
              <span>{isLoading ? "Generating Video..." : "Generate Video"}</span>
            </button>
          </div>
        </form>

        {error ? <p className="error-text">{error}</p> : null}

        <div className="activity-panel">
          <div className="activity-header">
            <p className="eyebrow">Under The Hood</p>
            <span className="activity-count">{activityLogs.length} events</span>
          </div>

          <div className="activity-log" aria-live="polite">
            {activityLogs.length === 0 ? (
              <p className="activity-placeholder">Press Generate Video to see request and render logs.</p>
            ) : (
              activityLogs.map((entry, index) => (
                <div key={`${entry.at}-${entry.source}-${index}`} className="activity-entry">
                  <span className={`activity-source activity-source-${entry.source}`}>{entry.source}</span>
                  <span className="activity-message">{entry.message}</span>
                  <span className="activity-time">{new Date(entry.at).toLocaleTimeString()}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="panel output-panel">
        <div className="panel-header compact">
          <p className="eyebrow">Render Output</p>
          <h2>Preview</h2>
        </div>

        {result ? (
          <>
            {hasMultipleVariants ? (
              <>
                <p className="variants-summary">
                  {successfulVariantCount}/{displayVariants.length} variants succeeded
                </p>

                <div className="variant-list">
                  {displayVariants.map((variant) => (
                    <button
                      key={variant.variantId}
                      type="button"
                      className={`variant-list-item variant-list-item-${variant.status}`}
                      onClick={() => setSelectedVariant(variant)}
                    >
                      <div className="variant-list-main">
                        <h3 className="variant-list-title">{variant.styleName}</h3>
                        <p className="variant-list-brief">{variant.styleBrief}</p>
                      </div>
                      <div className="variant-list-actions">
                        <span className={`variant-status-pill variant-status-pill-${variant.status}`}>
                          {variant.status === "succeeded" ? "Ready" : "Failed"}
                        </span>
                        <span className="variant-list-open">View</span>
                      </div>
                    </button>
                  ))}
                </div>
              </>
            ) : singleVariant?.status === "succeeded" ? (
              <>
                <video className="video-player" controls autoPlay loop preload="metadata" src={singleVariant.videoUrl} />

                <div className="meta-grid">
                  <div className="meta-item">
                    <span className="meta-label">Title</span>
                    <span className="meta-value">{singleVariant.metadata.title}</span>
                  </div>
                  <div className="meta-item">
                    <span className="meta-label">Resolution</span>
                    <span className="meta-value">
                      {singleVariant.metadata.width}x{singleVariant.metadata.height}
                    </span>
                  </div>
                  <div className="meta-item">
                    <span className="meta-label">FPS</span>
                    <span className="meta-value">{singleVariant.metadata.fps}</span>
                  </div>
                  <div className="meta-item">
                    <span className="meta-label">Duration</span>
                    <span className="meta-value">{formatVideoDuration(singleVariant.metadata)}</span>
                  </div>
                  <div className="meta-item">
                    <span className="meta-label">Video URL</span>
                    <a className="meta-link" href={singleVariant.videoUrl} target="_blank" rel="noreferrer">
                      {singleVariant.videoUrl}
                    </a>
                  </div>
                  <div className="meta-item">
                    <span className="meta-label">Job ID</span>
                    <span className="meta-value">{singleVariant.jobId}</span>
                  </div>
                </div>
              </>
            ) : (
              <p className="variant-error">{singleVariant?.error || "This variant failed to render."}</p>
            )}
          </>
        ) : (
          <div className="placeholder">
            <p>Your generated video will appear here after rendering.</p>
          </div>
        )}
      </section>

      {isHistoryOpen ? (
        <div className="modal-overlay" role="presentation" onClick={closeHistoryModal}>
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="history-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3 id="history-title">Generated Videos</h3>
              <button type="button" className="modal-close-button" onClick={closeHistoryModal}>
                Close
              </button>
            </div>

            <div className="modal-body">
              {isHistoryLoading ? <p className="modal-message">Loading generated videos...</p> : null}
              {historyError ? <p className="modal-error">{historyError}</p> : null}
              {!isHistoryLoading && !historyError && historyItems.length === 0 ? (
                <p className="modal-message">No generated videos found yet.</p>
              ) : null}

              {!isHistoryLoading && !historyError && historyItems.length > 0 ? (
                <div className="history-list">
                  {historyItems.map((item) => (
                    <div key={item.id} className="history-item">
                      <div className="history-item-main">
                        <p className="history-item-title">{item.fileName}</p>
                        <p className="history-item-meta">
                          {new Date(item.createdAt).toLocaleString()} • {formatBytes(item.sizeBytes)}
                        </p>
                      </div>
                      <div className="history-item-actions">
                        <a href={item.videoUrl} target="_blank" rel="noreferrer" className="history-link">
                          Open
                        </a>
                        <a href={item.videoUrl} download className="history-link">
                          Download
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {selectedVariant && hasMultipleVariants ? (
        <div className="modal-overlay" role="presentation" onClick={closeVariantModal}>
          <div className="modal-card variant-modal-card" role="dialog" aria-modal="true" aria-labelledby="variant-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3 id="variant-title">{selectedVariant.styleName}</h3>
              <button type="button" className="modal-close-button" onClick={closeVariantModal}>
                Close
              </button>
            </div>

            <div className="modal-body">
              <p className="variant-brief">{selectedVariant.styleBrief}</p>

              {selectedVariant.status === "succeeded" ? (
                <>
                  <video className="video-player variant-video-player" controls autoPlay loop preload="metadata" src={selectedVariant.videoUrl} />

                  <div className="meta-grid variant-meta-grid">
                    <div className="meta-item">
                      <span className="meta-label">Title</span>
                      <span className="meta-value">{selectedVariant.metadata.title}</span>
                    </div>
                    <div className="meta-item">
                      <span className="meta-label">Resolution</span>
                      <span className="meta-value">
                        {selectedVariant.metadata.width}x{selectedVariant.metadata.height}
                      </span>
                    </div>
                    <div className="meta-item">
                      <span className="meta-label">FPS</span>
                      <span className="meta-value">{selectedVariant.metadata.fps}</span>
                    </div>
                    <div className="meta-item">
                      <span className="meta-label">Duration</span>
                      <span className="meta-value">{formatVideoDuration(selectedVariant.metadata)}</span>
                    </div>
                    <div className="meta-item">
                      <span className="meta-label">Video URL</span>
                      <a className="meta-link" href={selectedVariant.videoUrl} target="_blank" rel="noreferrer">
                        {selectedVariant.videoUrl}
                      </a>
                    </div>
                    <div className="meta-item">
                      <span className="meta-label">Job ID</span>
                      <span className="meta-value">{selectedVariant.jobId}</span>
                    </div>
                  </div>
                </>
              ) : (
                <p className="variant-error">{selectedVariant.error}</p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
