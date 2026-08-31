import { mkdir, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Private local pilot records, not a general artifact-redaction or publication subsystem. */
export class RunJournal {
  private sequence = 0;
  private constructor(readonly directory: string, private readonly secrets: string[]) {}
  static async create(parent: string, secrets: string[]) {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = join(parent, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    return new RunJournal(directory, secrets.filter(Boolean));
  }
  private serialize(value: unknown) {
    // Replace in string values before JSON encoding so credentials containing quotes still redact.
    return JSON.stringify(value, (_key, part) => typeof part === 'string' ? this.secrets.reduce((safe, secret) => safe.split(secret).join('[redacted]'), part) : part);
  }
  async append(event: Record<string, unknown>) {
    const file = await open(join(this.directory, 'events.jsonl'), 'a', 0o600);
    try { await file.writeFile(this.serialize({ ...event, sequence: this.sequence++ }) + '\n'); await file.sync(); }
    finally { await file.close(); }
  }
  async write(name: 'config' | 'plan' | 'result', value: unknown) {
    const temporary = join(this.directory, `.${name}-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(this.serialize(value) + '\n'); await file.sync(); } finally { await file.close(); }
    await rename(temporary, join(this.directory, `${name}.json`));
  }
}
