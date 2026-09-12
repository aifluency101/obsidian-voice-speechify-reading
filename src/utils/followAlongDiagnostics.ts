/**
 * A small trace of what follow-along highlighting did, so a failure on a phone
 * can be read back without a console.
 *
 * Each attempt records the decisions in order — which view mode was chosen,
 * whether the passage was found in the markdown, whether Obsidian had a
 * rendered section for that line, whether a range was painted. Where it stops
 * says which of those is at fault, which is not something a screen recording
 * can show.
 */

export interface DiagnosticEvent {
  at: number;
  stage: string;
  detail: string;
}

const MAX_EVENTS = 300;

export class FollowAlongDiagnostics {
  private events: DiagnosticEvent[] = [];
  private startedAt = Date.now();

  record(stage: string, detail: string): void {
    this.events.push({ at: Date.now() - this.startedAt, stage, detail });
    if (this.events.length > MAX_EVENTS) {
      this.events.shift();
    }
  }

  reset(): void {
    this.events = [];
    this.startedAt = Date.now();
  }

  get count(): number {
    return this.events.length;
  }

  /** A compact, shareable report. */
  report(environment: string[]): string {
    const lines = [
      "# Voice follow-along diagnostics",
      "",
      `Captured: ${new Date().toISOString()}`,
      "",
      "## Environment",
      ...environment.map((e) => `- ${e}`),
      "",
      "## Trace",
      "",
      "| +ms | stage | detail |",
      "| ---: | --- | --- |",
    ];
    for (const e of this.events) {
      lines.push(`| ${e.at} | ${e.stage} | ${escapeCell(e.detail)} |`);
    }
    if (this.events.length === 0) {
      lines.push("| | (nothing recorded) | play a note first |");
    }
    return lines.join("\n") + "\n";
  }
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").slice(0, 160);
}
