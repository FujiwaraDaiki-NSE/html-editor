import { createHash } from "node:crypto";

const fingerprint = (deck) => createHash("sha256").update(JSON.stringify(deck)).digest("hex");

export function changedSlideIds(previous, next) {
  const previousById = new Map(previous.slides.map((slide) => [slide.id, JSON.stringify(slide)]));
  const nextById = new Map(next.slides.map((slide) => [slide.id, JSON.stringify(slide)]));
  return [
    ...next.slides.filter((slide) => previousById.get(slide.id) !== JSON.stringify(slide)).map((slide) => slide.id),
    ...previous.slides.filter((slide) => !nextById.has(slide.id)).map((slide) => slide.id),
  ];
}

export class ProjectPreviewMonitor {
  constructor({
    baseline,
    readSnapshot,
    publish,
    onSnapshot,
    pollInterval,
    settleMs,
    minPublishInterval,
    now,
    setIntervalFn,
    clearIntervalFn,
  }) {
    this.readSnapshot = readSnapshot;
    this.publish = publish;
    this.onSnapshot = onSnapshot;
    this.pollInterval = pollInterval;
    this.settleMs = settleMs;
    this.minPublishInterval = minPublishInterval;
    this.now = now;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.published = structuredClone(baseline);
    this.publishedFingerprint = fingerprint(baseline);
    this.candidate = null;
    this.candidateFingerprint = null;
    this.candidateSince = 0;
    this.lastPublishedAt = Number.NEGATIVE_INFINITY;
    this.sequence = 0;
    this.running = false;
    this.reading = false;
    this.timer = null;
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this.timer = this.setIntervalFn(() => void this.sample(), this.pollInterval);
    this.timer?.unref?.();
    return this;
  }

  async sample() {
    if (!this.running || this.reading) return;
    this.reading = true;
    try {
      const snapshot = await this.readSnapshot();
      if (!this.running) return;
      const nextFingerprint = fingerprint(snapshot);
      if (nextFingerprint === this.publishedFingerprint) {
        this.candidate = null;
        this.candidateFingerprint = null;
        return;
      }
      const sampledAt = this.now();
      if (nextFingerprint !== this.candidateFingerprint) {
        this.candidate = structuredClone(snapshot);
        this.candidateFingerprint = nextFingerprint;
        this.candidateSince = sampledAt;
        return;
      }
      if (sampledAt - this.candidateSince < this.settleMs || sampledAt - this.lastPublishedAt < this.minPublishInterval) return;
      const changed = changedSlideIds(this.published, this.candidate);
      this.published = this.candidate;
      this.publishedFingerprint = this.candidateFingerprint;
      this.candidate = null;
      this.candidateFingerprint = null;
      this.lastPublishedAt = sampledAt;
      this.sequence += 1;
      this.onSnapshot(structuredClone(this.published));
      this.publish({ changedSlideIds: changed, previewSequence: this.sequence });
    } catch {
      this.candidate = null;
      this.candidateFingerprint = null;
      // Incomplete writes and transient read/quality failures are retried on the next poll.
    } finally {
      this.reading = false;
    }
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== null) this.clearIntervalFn(this.timer);
    this.timer = null;
    this.candidate = null;
    this.candidateFingerprint = null;
  }
}
